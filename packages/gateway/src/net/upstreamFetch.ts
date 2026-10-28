/**
 * 统一上游 HTTP 客户端（docs/design/unified-gateway.md §15）：
 * - 自定义 lookup：使用本次请求已校验的地址（AsyncLocalStorage 钉 IP），保留 SNI/Host；
 * - 有 HTTPS_PROXY / HTTP_PROXY 时用 EnvHttpProxyAgent（尊重 NO_PROXY）；
 * - 合理的连接数、connect / headers 超时与 keep-alive。
 * 出站前 resolveUpstreamAddresses 只查一次 DNS；lookup 不再二次解析，消除 TOCTOU 重绑定。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type * as dns from 'node:dns';
import type { LookupAddress } from 'node:dns';

import type * as Undici from 'undici';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';

import { resolveUpstreamAddresses, type UpstreamGuardOpts } from './upstreamGuard';

export type { UpstreamGuardOpts };
export { resolveUpstreamAddresses } from './upstreamGuard';

/**
 * undici 按需加载：这个模块也被主进程（经内核的网关辅助代码）引入，主进程平时不发上游请求，
 * 不该为它常驻 undici（上百个模块）。第一次真正发请求时才加载
 */
let undiciModule: Promise<typeof Undici> | undefined;
const loadUndici = () => (undiciModule ??= import('undici'));

const CONNECT_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 60_000;
const MAX_CONNECTIONS = 32;

/** 单次上游请求钉住的已校验地址（lookup 直接用，不再二次 DNS） */
const pinStore = new AsyncLocalStorage<LookupAddress[]>();

export type UpstreamLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => void;

/** 是否配置了系统 HTTP(S) 代理（大小写都认） */
export function proxyEnvActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy,
  );
}

function finishLookup(
  opts: dns.LookupOptions,
  addrs: LookupAddress[],
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) {
  if (opts.all) cb(null, addrs);
  else cb(null, addrs[0]!.address, addrs[0]!.family);
}

/**
 * 供 Agent connect.lookup：优先用本次请求钉住的地址。
 * 无钉住时（例如连代理本身）再按 getGuard 现校，避免未校验的二次 DNS。
 */
export function createPinnedLookup(getOpts: () => UpstreamGuardOpts): UpstreamLookup {
  return (hostname, options, callback) => {
    const pinned = pinStore.getStore();
    if (pinned?.length) {
      finishLookup(options, pinned, callback);
      return;
    }
    const raw =
      hostname.includes(':') && !hostname.includes('.')
        ? `http://[${hostname}]/`
        : `http://${hostname}/`;
    void resolveUpstreamAddresses(raw, getOpts())
      .then(({ addresses }) => finishLookup(options, addresses, callback))
      .catch((err: Error) => {
        const e = err as NodeJS.ErrnoException;
        e.code = e.code ?? 'ENOTFOUND';
        callback(e, '', 4);
      });
  };
}

export interface UpstreamDispatcherOptions {
  getGuard?: () => UpstreamGuardOpts;
  /** 测试注入环境变量 */
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
}

/** 创建共享 dispatcher：有代理走 EnvHttpProxyAgent，否则普通 Agent；lookup 钉 IP */
export async function createUpstreamDispatcher(
  o: UpstreamDispatcherOptions = {},
): Promise<Dispatcher> {
  const { Agent, EnvHttpProxyAgent } = await loadUndici();
  const getGuard = o.getGuard ?? (() => ({}));
  const connect = {
    timeout: o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    lookup: createPinnedLookup(getGuard),
  };
  const common = {
    connect,
    connections: MAX_CONNECTIONS,
    pipelining: 1,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
    bodyTimeout: 0,
    headersTimeout: o.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
    connectTimeout: o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
  };
  if (proxyEnvActive(o.env ?? process.env)) return new EnvHttpProxyAgent(common);
  return new Agent(common);
}

export type UpstreamFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CreateUpstreamFetchOptions extends UpstreamDispatcherOptions {
  /** 测试可注入已有 dispatcher */
  dispatcher?: Dispatcher;
}

/**
 * 返回走钉 IP dispatcher 的 fetch。每次调用先 resolve+校验，再在 ALS 里钉住地址连接。
 * 调用方仍应 redirect: 'manual'（默认也是 manual）。
 */
export function createUpstreamFetch(o: CreateUpstreamFetchOptions = {}): UpstreamFetch {
  let dispatcher: Promise<Dispatcher> | undefined = o.dispatcher
    ? Promise.resolve(o.dispatcher)
    : undefined;
  const getGuard = o.getGuard ?? (() => ({}));
  return async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.toString();
    const { addresses } = await resolveUpstreamAddresses(raw, getGuard());
    const [{ fetch: undiciFetch }, d] = await Promise.all([
      loadUndici(),
      (dispatcher ??= createUpstreamDispatcher(o)),
    ]);
    return pinStore.run(
      addresses,
      () =>
        undiciFetch(raw, {
          ...(init as UndiciRequestInit),
          dispatcher: d,
          redirect: (init.redirect as UndiciRequestInit['redirect']) ?? 'manual',
        }) as unknown as Promise<Response>,
    );
  };
}

/** 默认单例（进程级）；网关可再 create 一份以便注入 getGuard */
let shared: UpstreamFetch | null = null;
export function defaultUpstreamFetch(): UpstreamFetch {
  shared ??= createUpstreamFetch();
  return shared;
}
