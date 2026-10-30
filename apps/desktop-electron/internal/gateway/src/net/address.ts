/**
 * 地址分类（纯 Node，无依赖）：判断主机名 / IP 是否是本机、局域网或保留地址。
 * 覆盖 IPv4 保留段与非常规写法（十进制整数、八进制、十六进制、省略段），以及 IPv6 回环 / ULA /
 * 链路本地 / 组播和内嵌 IPv4。网关的上游地址校验与主进程的 netGuard 共用（§15）。
 */

/** inet_aton 宽松解析：1–4 段，每段十进制 / 0x 十六进制 / 0 开头八进制。不是 IPv4 返回 null。 */
export function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9]\d*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  const restBytes = 4 - nums.length;
  if (last >= 2 ** (8 * restBytes)) return null;
  const out = [...nums];
  for (let i = restBytes - 1; i >= 0; i--) out.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return out;
}

function isPrivateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** IPv6 文本 → 8 个 16 位分组；支持 :: 压缩与末尾点分 IPv4。非法返回 null。 */
export function parseIPv6(host: string): number[] | null {
  let h = host.split('%')[0]!;
  if (!h.includes(':')) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (v4) {
    const b = parseIPv4(v4[1]!);
    if (!b || v4[1]!.split('.').length !== 4) return null;
    h =
      h.slice(0, -v4[1]!.length) +
      ((b[0]! << 8) | b[1]!).toString(16) +
      ':' +
      ((b[2]! << 8) | b[3]!).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const seg = (s: string) => (s === '' ? [] : s.split(':'));
  const head = seg(halves[0]!);
  const tail = halves.length === 2 ? seg(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function isPrivateV6(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = () => [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (zero(0, 7) && (g[7] === 0 || g[7] === 1)) return true; // :: / ::1
  if (zero(0, 5) && g[5] === 0xffff) return isPrivateV4(embedded()); // ::ffff:a.b.c.d
  if (zero(0, 6)) return isPrivateV4(embedded()); // ::a.b.c.d（已废弃的 IPv4-compatible）
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return isPrivateV4(embedded()); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // 组播
  return false;
}

/** 是否为本机 / 局域网 / 保留地址（含主机名 localhost、*.local）。 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (h === '' || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))
    return true;
  const v6 = parseIPv6(h);
  if (v6) return isPrivateV6(v6);
  const v4 = parseIPv4(h);
  if (v4) return isPrivateV4(v4);
  return false;
}
