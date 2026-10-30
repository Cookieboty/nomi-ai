/**
 * 上游地址校验（docs/design/unified-gateway.md §15）：探测和转发只访问用户配置的地址。
 * - 公网地址：只允许 http / https，不允许内嵌账号密码，解析出的每个地址都必须是公网；
 * - 回环 / 私网地址（Ollama、LM Studio、局域网自建服务）：只放行用户确认过的 host:port；
 * - 不允许指向网关自己的端口，防止请求转圈。
 * 重定向不跟随（调用方用 redirect: 'manual'）。
 * 实际出站请走 net/upstreamFetch（钉 IP 的 undici Agent），避免 check 与 fetch 各自 DNS 的 TOCTOU。
 */
import * as dns from 'node:dns';
import type { LookupAddress } from 'node:dns';

import { isPrivateHost, parseIPv4, parseIPv6 } from './address';

export type LookupAll = (host: string) => Promise<LookupAddress[]>;
const defaultLookupAll: LookupAll = (host) => dns.promises.lookup(host, { all: true });

export class UpstreamBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamBlockedError';
  }
}

export interface UpstreamGuardOpts {
  allowedPrivateHosts?: string[];
  selfPort?: number;
  lookupAll?: LookupAll;
}

function hostPort(u: URL): string {
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.hostname.replace(/^\[|\]$/g, '').toLowerCase()}:${port}`;
}

/**
 * 代理软件的 fake-ip（Clash / Surge 等默认用 198.18.0.0/15，RFC 2544 测试保留段）：
 * 开着这类代理时所有公网域名都解析到这里。它不是真实的局域网，域名解析到这里时放行；
 * 直接写成 IP 字面量的仍按保留地址处理。
 */
export function isFakeIp(address: string): boolean {
  const v4 = parseIPv4(address);
  return Boolean(v4 && v4[0] === 198 && (v4[1] === 18 || v4[1] === 19));
}

function isLoopbackName(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const v4 = parseIPv4(h);
  return Boolean(v4 && v4[0] === 127);
}

/**
 * 解析并校验上游 URL，返回允许连接的地址列表（供钉 IP 的 fetch 使用）。
 * IP 字面量不查 DNS；域名查一次，拒绝未确认的私网（fake-ip 对域名放行）。
 */
export async function resolveUpstreamAddresses(
  raw: string,
  opts: UpstreamGuardOpts = {},
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UpstreamBlockedError(`上游地址无效：${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new UpstreamBlockedError('上游地址只允许 http / https');
  if (u.username || u.password) throw new UpstreamBlockedError('上游地址不能包含账号密码');
  const hp = hostPort(u);
  const allowed = new Set((opts.allowedPrivateHosts ?? []).map((x) => x.toLowerCase()));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (opts.selfPort && isLoopbackName(host) && hp.endsWith(`:${opts.selfPort}`))
    throw new UpstreamBlockedError('上游地址不能指向 Nomi 网关自己');
  if (isPrivateHost(host)) {
    if (!allowed.has(hp))
      throw new UpstreamBlockedError(`上游地址 ${hp} 是本机或局域网地址，需要先在供应商设置里确认`);
    const v4 = parseIPv4(host);
    const v6 = parseIPv6(host);
    if (v4) return { url: u, addresses: [{ address: host, family: 4 }] };
    if (v6) return { url: u, addresses: [{ address: host, family: 6 }] };
    // localhost 等：继续 DNS，但已在白名单
  }
  if ((parseIPv4(host) || parseIPv6(host)) && !isPrivateHost(host)) {
    return {
      url: u,
      addresses: [{ address: host, family: parseIPv4(host) ? 4 : 6 }],
    };
  }
  const addrs = await (opts.lookupAll ?? defaultLookupAll)(host);
  if (!addrs.length) throw new UpstreamBlockedError(`无法解析上游地址 ${host}`);
  const blocked = addrs.filter((a) => isPrivateHost(a.address) && !isFakeIp(a.address));
  if (blocked.length && !allowed.has(hp))
    throw new UpstreamBlockedError(
      `上游地址 ${host} 解析到了本机或局域网地址，需要先在供应商设置里确认`,
    );
  const usable =
    allowed.has(hp) || !blocked.length
      ? addrs
      : addrs.filter((a) => !isPrivateHost(a.address) || isFakeIp(a.address));
  if (!usable.length)
    throw new UpstreamBlockedError(
      `上游地址 ${host} 解析到了本机或局域网地址，需要先在供应商设置里确认`,
    );
  return { url: u, addresses: usable };
}

export async function checkUpstream(raw: string, opts: UpstreamGuardOpts = {}): Promise<URL> {
  const { url } = await resolveUpstreamAddresses(raw, opts);
  return url;
}
