/**
 * 智能体浏览器的出站请求判定（SSRF 防护）。
 *
 * 导航（含每一跳重定向）与页面子资源（图片 / 脚本 / XHR / fetch / WebSocket / iframe）
 * 都走同一个判定函数 `decideRequest`：只放行公网 http(s)/ws(s)，
 * 并且主机名解析出的**每一个**地址都必须是公网（复用 netGuard 的 IP 校验）。
 *
 * 局限：Chromium 连接时会自己再解析一次 DNS，攻击者控制的域名可能在「我们校验」与
 * 「Chromium 连接」之间改指向内网（DNS 重绑定）。因此再加一层兜底：`onResponseStarted`
 * 拿到实际连接的对端 IP，若是内网地址则立即停止加载，并把该主机名拉黑（本次会话内后续请求直接拒绝）。
 */
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  isPrivateHost,
} from '../security/netGuard';

export interface RequestVerdict {
  cancel: boolean;
  reason?: string;
}

export interface RequestGuardOptions {
  /** 测试注入：返回主机名解析出的全部地址 */
  lookupAll?: Parameters<typeof assertPublicHttpUrlResolved>[1];
}

/** 不产生网络访问的内置 scheme（about:blank、data:、blob: 本身不出网；blob/data 的内容来自页面自身） */
const LOCAL_SCHEMES = new Set(['about:', 'data:', 'blob:', 'chrome-error:']);

function toHttpEquivalent(u: URL): string {
  if (u.protocol === 'ws:') return `http:${u.href.slice(3)}`;
  if (u.protocol === 'wss:') return `https:${u.href.slice(4)}`;
  return u.href;
}

/** 同步部分：URL 形态 / IP 字面量 / localhost 之类；供 will-navigate 这种必须同步决定的地方使用 */
export function checkRequestUrlSync(raw: string): RequestVerdict {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { cancel: true, reason: 'invalid url' };
  }
  if (LOCAL_SCHEMES.has(u.protocol)) return { cancel: false };
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) {
    return { cancel: true, reason: `blocked scheme ${u.protocol}` };
  }
  try {
    assertPublicHttpUrl(toHttpEquivalent(u));
  } catch (e) {
    return { cancel: true, reason: e instanceof Error ? e.message : String(e) };
  }
  return { cancel: false };
}

export function createRequestGuard(opts: RequestGuardOptions = {}) {
  /** 实际连接到内网 IP 的主机名：本会话内不再放行 */
  const blockedHosts = new Set<string>();

  async function decideRequest(raw: string): Promise<RequestVerdict> {
    const sync = checkRequestUrlSync(raw);
    if (sync.cancel) return sync;
    const u = new URL(raw);
    if (LOCAL_SCHEMES.has(u.protocol)) return { cancel: false };
    if (blockedHosts.has(u.hostname.toLowerCase())) {
      return { cancel: true, reason: 'host previously resolved to a private address' };
    }
    try {
      await assertPublicHttpUrlResolved(toHttpEquivalent(u), opts.lookupAll);
    } catch (e) {
      return { cancel: true, reason: e instanceof Error ? e.message : String(e) };
    }
    return { cancel: false };
  }

  /**
   * 响应已开始：details.ip 是实际连接的对端。落在内网 → 返回 true，调用方应停止加载。
   */
  function onConnected(rawUrl: string, ip: string | undefined): boolean {
    if (!ip || !isPrivateHost(ip)) return false;
    try {
      blockedHosts.add(new URL(rawUrl).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
    return true;
  }

  return { decideRequest, onConnected, blockedHosts };
}

export type RequestGuard = ReturnType<typeof createRequestGuard>;
