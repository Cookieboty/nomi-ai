/**
 * 本机监听与 Host 头校验（防 DNS 重绑定）：网关与旧的本地路由服务共用。
 */

/** 只允许监听回环地址：0.0.0.0 / 局域网 / 外网地址会把用户的上游密钥暴露给别的机器 */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

export function isLoopbackHost(host: unknown): host is (typeof LOOPBACK_HOSTS)[number] {
  return typeof host === 'string' && (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/**
 * Host 头校验：主机名必须是回环名，端口必须是本服务监听的端口。
 * 浏览器里的恶意页面经重绑定访问 127.0.0.1 时，Host 仍是攻击者的域名，在这里被拒绝。
 */
export function isAllowedHostHeader(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader.trim());
  if (!m) return false;
  const name = m[1]!.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isLoopbackHost(name)) return false;
  return m[2] === undefined ? port === 80 : Number(m[2]) === port;
}

/** URL 里的主机段：IPv6 需要方括号 */
export function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
