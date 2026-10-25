/**
 * 出站 URL 安全校验：服务端返回的 URL（例如 TTS cos_url）可能指向内网或非 HTTP
 * 协议，直接请求会形成 SSRF。这里统一只允许公网 http(s)，拒绝内嵌凭据与保留地址。
 *
 * 覆盖：
 * - IPv4 保留段（0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、
 *   192.168/16、198.18/15、224/4 组播、240/4 保留、广播）；
 * - 非常规 IPv4 写法（十进制整数 2130706433、八进制 0177.0.0.1、十六进制 0x7f.1、省略段 127.1）；
 * - IPv6 回环 / 未指定 / ULA fc00::/7 / 链路本地 fe80::/10 / 组播，以及内嵌 IPv4
 *   （IPv4-mapped ::ffff:a.b.c.d、IPv4-compatible、NAT64 64:ff9b::/96）按内嵌地址判断；
 * - DNS 重绑定：`safeLookup` 作为 http(s) 请求的 lookup，在真正连接的那次解析结果上校验，
 *   避免「先查一次是公网、连接时再解析成内网」的竞态；`assertPublicHttpUrlResolved` 预检全部解析结果。
 */
import * as dns from 'dns';
import type { LookupAddress, LookupOptions } from 'dns';

import { isPrivateHost, parseIPv4, parseIPv6 } from '@nomi-ai/gateway';

import { t } from '../i18n';

export { isPrivateHost, parseIPv4, parseIPv6 };

export function assertPublicHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(t('electron.common.invalid-audio-url'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(t('electron.common.audio-url-must-use-http-or-https'));
  }
  if (u.username || u.password) {
    throw new Error(t('electron.common.audio-url-must-not-contain-credentials'));
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(t('electron.common.audio-url-must-not-point-to-localhost-or'));
  }
  return u;
}

type LookupAll = (host: string) => Promise<LookupAddress[]>;
const defaultLookupAll: LookupAll = (host) => dns.promises.lookup(host, { all: true });

/** 预检：URL 合法且主机名解析出的每个地址都是公网。 */
export async function assertPublicHttpUrlResolved(
  raw: string,
  lookupAll: LookupAll = defaultLookupAll,
): Promise<URL> {
  const u = assertPublicHttpUrl(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (parseIPv4(host) || parseIPv6(host)) return u;
  const addrs = await lookupAll(host);
  if (!addrs.length || addrs.some((a) => isPrivateHost(a.address))) {
    throw new Error(t('electron.common.audio-url-must-not-point-to-localhost-or'));
  }
  return u;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * 给 http(s).request 的 `lookup` 选项：在实际建立连接所用的解析结果上拒绝内网地址（防 DNS 重绑定）。
 */
export function makeSafeLookup(base: typeof dns.lookup = dns.lookup) {
  return function safeLookup(hostname: string, options: LookupOptions, callback: LookupCb): void {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses as unknown as LookupAddress[];
      const bad = list.find((a) => isPrivateHost(a.address));
      if (!list.length || bad) {
        const e = new Error(
          t('electron.common.audio-url-must-not-point-to-localhost-or'),
        ) as NodeJS.ErrnoException;
        e.code = 'EPRIVATEADDR';
        return callback(e, '');
      }
      if (options?.all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export const safeLookup = makeSafeLookup();
