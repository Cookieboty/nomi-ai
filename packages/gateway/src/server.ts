/**
 * 网关 HTTP 服务（docs/design/unified-gateway.md §5.1、§10）：
 * 鉴权（客户端令牌）→ 按路径识别入口协议 → 解析候选 → 逐个尝试上游 → 同协议透传 / 跨协议转换。
 * 纯 Node：既能跑在 Electron utilityProcess 里，也能直接在 Vitest 里起服务测试。
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { ClientId, GatewayConfig } from './config';
import { CLIENT_IDS } from './config';
import { customToolNames } from './customTools';
import { errorResponse, kindOfStatus, upstreamMessage } from './errors';
import { ingressFromPath, type Ingress } from './ingress';
import type { Wire } from './ir';
import { classifyFailure, Learner, type LearnEvent } from './learn';
import { modelsBody } from './models';
import { isAllowedHostHeader, urlHost } from './net/loopback';
import { checkUpstream, UpstreamBlockedError, type LookupAll } from './net/upstreamGuard';
import { alternateWire, resolveCandidates, type Candidate } from './route/resolve';
import { createStreamConverter, jsonToJson, jsonToSse, type StreamUsage } from './stream';
import { estimateRequestTokens } from './tokens';
import { upstreamBody, upstreamHeaders, upstreamUrl } from './upstream';
import { usageOfJson, UsageTap } from './usageTap';

export const GATEWAY_VERSION = '1';

/** 每个请求最多尝试的候选数（§11.1） */
const MAX_ATTEMPTS = 4;
/** 每个请求因运行时学习而重试的上限（计入 MAX_ATTEMPTS） */
const MAX_LEARN_RETRIES = 2;
/** 首字节前单次尝试的超时 */
const FIRST_BYTE_TIMEOUT_MS = 30_000;
/** 首字节之前所有尝试的总时长上限 */
const FIRST_BYTE_BUDGET_MS = 60_000;
/** 首字节之后上游连续无事件的上限 */
const STREAM_IDLE_TIMEOUT_MS = 180_000;

export type GatewayClient = ClientId | 'legacy';

export interface UsageEvent {
  client: GatewayClient;
  ingress: Wire;
  wire?: Wire;
  provider?: string;
  keyId?: string;
  model?: string;
  status: number;
  usage: StreamUsage;
  startedAt: number;
  ms: number;
  attempts: number;
  error?: string;
}

export interface GatewayHooks {
  onUsage?: (e: UsageEvent) => void;
  /** 运行时学到的东西（主进程持久化，§7.4） */
  onLearn?: (e: LearnEvent) => void;
  logger?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  lookupAll?: LookupAll;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

function tokenEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** 令牌可以放在 x-api-key、Authorization: Bearer、x-goog-api-key 或 ?key= 里 */
function presentedTokens(req: http.IncomingMessage, url: URL): string[] {
  const out: string[] = [];
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x) out.push(x);
  const a = req.headers.authorization;
  if (typeof a === 'string' && a) out.push(a.replace(/^Bearer\s+/i, ''));
  const g = req.headers['x-goog-api-key'];
  if (typeof g === 'string' && g) out.push(g);
  const q = url.searchParams.get('key');
  if (q) out.push(q);
  return out;
}

/** 旧版共享令牌的客户端身份：按入口路径和 User-Agent 推断，推断不了就不做场景映射（§10.2） */
function legacyClient(ingress: Ingress | null, ua: string): ClientId | null {
  if (ingress?.wire === 'messages') return 'claude';
  const u = ua.toLowerCase();
  if (u.includes('codex')) return 'codex';
  if (u.includes('grok')) return 'grok';
  if (u.includes('dsh')) return 'dsh';
  if (ingress?.wire === 'gemini') return 'gemini';
  return null;
}

type Attempt =
  | { kind: 'response'; res: Response; cand: Candidate }
  | {
      kind: 'failed';
      status: number;
      message: string;
      retryable: boolean;
      cand: Candidate;
      /** 上游错误体与本次发出的请求体（运行时学习分类用，§7.4） */
      text?: string;
      sent?: unknown;
    };

export class GatewayServer {
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();

  private readonly learner: Learner;

  constructor(
    private cfg: GatewayConfig,
    private readonly hooks: GatewayHooks = {},
  ) {
    this.learner = new Learner((e) => {
      this.hooks.logger?.info('gateway learned', e);
      this.hooks.onLearn?.(e);
    });
  }

  /** 换新配置：进行中的请求继续用各自拿到的旧快照 */
  update(cfg: GatewayConfig): void {
    this.cfg = cfg;
  }

  get config(): GatewayConfig {
    return this.cfg;
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    this.server = server;
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, this.cfg.host, () => resolve());
    });
    this.hooks.logger?.info('gateway listening', this.listenUrl());
  }

  stop(): void {
    const s = this.server;
    this.server = null;
    try {
      s?.close();
      s?.closeAllConnections?.();
    } catch {
      /* 已关闭 */
    }
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
  }

  address(): AddressInfo | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a : null;
  }

  listenUrl(): string | null {
    const a = this.address();
    return a ? `http://${urlHost(this.cfg.host)}:${a.port}` : null;
  }

  private identify(req: http.IncomingMessage, url: URL): GatewayClient | null {
    const tokens = presentedTokens(req, url);
    for (const id of CLIENT_IDS) {
      const t = this.cfg.clients[id]?.token;
      if (t && tokens.some((x) => tokenEquals(x, t))) return id;
    }
    const legacy = this.cfg.legacyToken;
    if (legacy && tokens.some((x) => tokenEquals(x, legacy))) return 'legacy';
    return null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cfg = this.cfg;
    const port = this.address()?.port ?? cfg.port;
    if (!isAllowedHostHeader(req.headers.host, port)) {
      sendJson(res, 421, { error: 'misdirected request: invalid Host header' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      sendJson(res, 200, { ok: true, service: 'nomi-gateway', version: GATEWAY_VERSION });
      return;
    }
    // 不设 CORS，浏览器发来的跨站请求一律拒绝
    if (req.headers.origin) {
      sendJson(res, 403, { error: 'browser requests are not allowed' });
      return;
    }
    const ingress = ingressFromPath(url.pathname);
    const client = this.identify(req, url);
    if (!client) {
      const e = errorResponse(
        ingress?.wire ?? 'chat',
        'auth',
        'Nomi 网关：缺少或错误的客户端令牌（请在 Nomi 里重新打开这个标签）',
      );
      sendJson(res, e.status, e.body);
      return;
    }
    if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
      const format = url.pathname.startsWith('/v1beta')
        ? 'gemini'
        : req.headers['x-api-key'] && !req.headers.authorization
          ? 'anthropic'
          : 'openai';
      sendJson(res, 200, modelsBody(cfg, format));
      return;
    }
    if (req.method !== 'POST' || !ingress) {
      sendJson(res, 404, { error: `unknown route: ${req.method} ${url.pathname}` });
      return;
    }
    await this.proxy(req, res, cfg, client, ingress);
  }

  private async proxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    cfg: GatewayConfig,
    client: GatewayClient,
    ingress: Ingress,
  ): Promise<void> {
    const startedAt = Date.now();
    const fail = (status: number, message: string) => {
      const e = errorResponse(ingress.wire, kindOfStatus(status, message), message);
      if (!res.headersSent) sendJson(res, e.status, e.body);
      else res.end();
    };
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      fail(400, 'Nomi 网关：请求体不是合法的 JSON');
      return;
    }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const requested =
      ingress.wire === 'gemini'
        ? (ingress.model ?? '')
        : typeof b.model === 'string'
          ? b.model
          : '';
    const resolveAs =
      client === 'legacy' ? legacyClient(ingress, String(req.headers['user-agent'] ?? '')) : client;
    const r = resolveCandidates(cfg, resolveAs, requested, ingress.wire);
    if (!r.ok) {
      fail(r.status, r.message);
      return;
    }
    const wantsStream = ingress.wire === 'gemini' ? Boolean(ingress.stream) : b.stream === true;
    if (ingress.countTokens) {
      await this.countTokens(res, cfg, ingress, body, r.candidates[0]!);
      return;
    }

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const errors: string[] = [];
    let attempts = 0;
    let last: Attempt | null = null;
    // 被短期压制的候选排到后面；学习触发的重试（换 wire / 去掉字段）插到队首，每个请求最多 2 次（§7.4）
    const queue = this.withSuppression(cfg, r.candidates, ingress.wire);
    let learnRetries = 0;
    while (queue.length && attempts < MAX_ATTEMPTS) {
      if (Date.now() - startedAt > FIRST_BYTE_BUDGET_MS || abort.signal.aborted) break;
      const cand = queue.shift()!;
      attempts++;
      last = await this.attempt(cfg, req, ingress, cand, body, wantsStream, abort.signal);
      if (last.kind === 'response') {
        this.learner.success(cand);
        break;
      }
      errors.push(
        `${cand.provider.name}·${cand.key.name ?? cand.key.id}·${cand.wire}: ${last.message}`,
      );
      const hint =
        last.text !== undefined
          ? this.learner.failure(cand, classifyFailure(last.status, last.text, last.sent))
          : null;
      const retry =
        hint && learnRetries < MAX_LEARN_RETRIES
          ? 'dropParam' in hint
            ? { ...cand, dropParams: [...(cand.dropParams ?? []), hint.dropParam] }
            : alternateWire(cfg, cand, ingress.wire, [hint.excludeWire])
          : null;
      if (retry) {
        learnRetries++;
        queue.unshift(retry);
        continue;
      }
      if (!last.retryable) break;
    }
    if (!last || last.kind === 'failed') {
      const status = last?.status ?? 502;
      const message =
        errors.length > 1
          ? `Nomi 网关：所有候选都失败了 —— ${errors.join('；')}`
          : (last?.message ?? 'Nomi 网关：没有可用的候选');
      fail(status, message);
      this.hooks.onUsage?.({
        client,
        ingress: ingress.wire,
        ...(last
          ? {
              wire: last.cand.wire,
              provider: last.cand.provider.id,
              keyId: last.cand.key.id,
              model: last.cand.publicModel,
            }
          : {}),
        status,
        usage: {},
        startedAt,
        ms: Date.now() - startedAt,
        attempts,
        error: message,
      });
      return;
    }
    const { res: up, cand } = last;
    const usage = await this.respond(res, ingress, cand, up, body, wantsStream, abort);
    this.hooks.onUsage?.({
      client,
      ingress: ingress.wire,
      wire: cand.wire,
      provider: cand.provider.id,
      keyId: cand.key.id,
      model: cand.publicModel,
      status: up.status,
      usage,
      startedAt,
      ms: Date.now() - startedAt,
      attempts,
    });
  }

  /**
   * 被短期压制的 (供应商, Key, wire)：同一个 Key 先换别的协议，原候选排到最后（仍可用，§7.4）。
   */
  private withSuppression(cfg: GatewayConfig, cands: Candidate[], ingress: Wire): Candidate[] {
    const head: Candidate[] = [];
    const tail: Candidate[] = [];
    for (const c of cands) {
      if (!this.learner.isSuppressed(c)) {
        head.push(c);
        continue;
      }
      const alt = alternateWire(cfg, c, ingress, [c.wire]);
      if (alt && !this.learner.isSuppressed(alt)) head.push(alt);
      tail.push(c);
    }
    return [...head, ...tail];
  }

  /** 一次上游尝试；拿到 2xx 响应头就算成功（之后不再换候选） */
  private async attempt(
    cfg: GatewayConfig,
    req: http.IncomingMessage,
    ingress: Ingress,
    cand: Candidate,
    body: unknown,
    wantsStream: boolean,
    signal: AbortSignal,
  ): Promise<Attempt> {
    const base = cand.provider.urls[cand.wire]!;
    const target = upstreamUrl(cand.wire, base, cand.upstreamModel, { stream: wantsStream });
    try {
      await checkUpstream(target, {
        allowedPrivateHosts: cfg.allowedPrivateHosts,
        selfPort: this.address()?.port ?? cfg.port,
        lookupAll: this.hooks.lookupAll,
      });
    } catch (e) {
      return {
        kind: 'failed',
        status: 400,
        message: (e as Error).message,
        retryable: e instanceof UpstreamBlockedError,
        cand,
      };
    }
    const sent = upstreamBody(ingress.wire, cand, body, {
      stream: wantsStream,
      ingressModel: ingress.model,
    });
    const timeout = AbortSignal.timeout(this.hooks.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS);
    const both = AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await (this.hooks.fetchImpl ?? fetch)(target, {
        method: 'POST',
        headers: upstreamHeaders(cand, {
          stream: wantsStream,
          clientHeaders: req.headers,
          sameWire: ingress.wire === cand.wire,
        }),
        body: JSON.stringify(sent),
        redirect: 'manual',
        signal: both,
      });
    } catch (e) {
      const timedOut = timeout.aborted && !signal.aborted;
      return {
        kind: 'failed',
        status: timedOut ? 504 : 502,
        message: timedOut ? '上游在首字节前超时' : `连接上游失败：${(e as Error).message}`,
        retryable: !signal.aborted,
        cand,
      };
    }
    if (res.ok) return { kind: 'response', res, cand };
    const text = await res.text().catch(() => '');
    const s = res.status;
    const retryable =
      s === 429 ||
      s >= 500 ||
      s === 401 ||
      s === 403 ||
      s === 404 ||
      s === 405 ||
      (s >= 300 && s < 400);
    return {
      kind: 'failed',
      status: s >= 300 && s < 400 ? 502 : s,
      message: s >= 300 && s < 400 ? `上游返回重定向（${s}），网关不跟随` : upstreamMessage(text),
      retryable,
      cand,
      text,
      sent,
    };
  }

  /** 把上游的 2xx 响应按入口协议写回客户端，返回用量 */
  private async respond(
    res: http.ServerResponse,
    ingress: Ingress,
    cand: Candidate,
    up: Response,
    body: unknown,
    wantsStream: boolean,
    abort: AbortController,
  ): Promise<StreamUsage> {
    const same = ingress.wire === cand.wire;
    const isSse = (up.headers.get('content-type') ?? '').includes('text/event-stream');
    const convOpts = {
      model: cand.publicModel,
      customTools: ingress.wire === 'responses' ? customToolNames(body) : undefined,
    };
    if (wantsStream && isSse && up.body) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const tap = new UsageTap(cand.wire);
      const conv = same ? null : createStreamConverter(cand.wire, ingress.wire, convOpts);
      const decoder = new TextDecoder();
      const reader = up.body.getReader();
      const idleMs = this.hooks.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
      let idle: ReturnType<typeof setTimeout> | null = null;
      let idleFired = false;
      const arm = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => {
          idleFired = true;
          abort.abort();
        }, idleMs);
      };
      try {
        arm();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          if (res.destroyed) return tap.usage;
          const text = decoder.decode(value, { stream: true });
          tap.push(text);
          if (!conv) res.write(Buffer.from(value));
          else {
            const out = conv.push(text);
            if (out) res.write(out);
          }
        }
        const rest = decoder.decode();
        tap.push(rest);
        if (conv) {
          const tail = conv.push(rest) + conv.end();
          if (tail) res.write(tail);
        }
      } catch (e) {
        if (!res.destroyed) {
          const msg = idleFired
            ? `Nomi 网关：上游 ${Math.round(idleMs / 1000)} 秒没有任何输出，已中断`
            : `Nomi 网关：上游中断（${(e as Error).message}）`;
          if (conv) res.write(conv.fail(msg));
          else res.write(createStreamConverter(cand.wire, ingress.wire, convOpts).fail(msg));
        }
      } finally {
        if (idle) clearTimeout(idle);
        reader.releaseLock();
        if (!res.destroyed) res.end();
      }
      return tap.end();
    }
    const text = await up.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 原样返回 */
    }
    const usage = typeof parsed === 'object' ? usageOfJson(cand.wire, parsed) : {};
    if (wantsStream && parsed && typeof parsed === 'object') {
      // 客户端要流式、上游却回了普通 JSON：合成入口协议的完整 SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(jsonToSse(cand.wire, ingress.wire, parsed, convOpts));
      return usage;
    }
    if (same || typeof parsed !== 'object') {
      res.writeHead(up.status, {
        'Content-Type': up.headers.get('content-type') ?? 'application/json',
      });
      res.end(text);
      return usage;
    }
    const r = jsonToJson(cand.wire, ingress.wire, parsed, convOpts);
    sendJson(res, r.status, r.body);
    return usage;
  }

  /** count_tokens：上游是 Messages 时转发，否则（或上游不支持）本地估算（§10.1、§10.3） */
  private async countTokens(
    res: http.ServerResponse,
    cfg: GatewayConfig,
    ingress: Ingress,
    body: unknown,
    cand: Candidate,
  ): Promise<void> {
    if (ingress.wire === 'messages' && cand.wire === 'messages') {
      const target = upstreamUrl('messages', cand.provider.urls.messages!, cand.upstreamModel, {
        countTokens: true,
      });
      try {
        await checkUpstream(target, {
          allowedPrivateHosts: cfg.allowedPrivateHosts,
          selfPort: this.address()?.port ?? cfg.port,
          lookupAll: this.hooks.lookupAll,
        });
        const up = await (this.hooks.fetchImpl ?? fetch)(target, {
          method: 'POST',
          headers: upstreamHeaders(cand, { stream: false, clientHeaders: {}, sameWire: true }),
          body: JSON.stringify({ ...(body as object), model: cand.upstreamModel }),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.hooks.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS),
        });
        if (up.ok) {
          sendJson(res, 200, await up.json());
          return;
        }
      } catch {
        /* 退回本地估算 */
      }
    }
    const n = estimateRequestTokens(body);
    sendJson(res, 200, ingress.wire === 'gemini' ? { totalTokens: n } : { input_tokens: n });
  }
}

export function createGateway(cfg: GatewayConfig, hooks: GatewayHooks = {}): GatewayServer {
  return new GatewayServer(cfg, hooks);
}
