/**
 * 文本线格式（docs/design/core-host-decoupling.md §4.2、§5.2）：帧按 JSON 发，`Uint8Array` 编成
 * `{ "$u8": "<base64>" }`。WebSocket 等只能传文本 / 字节的传输用它；Electron IPC 与 in-process 传输
 * 走 structuredClone，不需要。
 *
 * 只认这一种标记：解码时**恰好**只有一个 `$u8` 字符串字段的对象才还原成 `Uint8Array`，其余原样保留。
 * 业务数据里本来就长这样的对象会被误还原，契约里不要用 `$u8` 作字段名。
 *
 * 不依赖 Node 内置模块（浏览器与内核共用）。
 */

const U8_TAG = '$u8';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let b64Lookup: Int16Array | undefined;
// 用到时才建（模块顶层没有副作用，视图打包时没用到的传输代码能整个摇掉）
const lookup = (): Int16Array => {
  if (!b64Lookup) {
    b64Lookup = new Int16Array(128).fill(-1);
    for (let i = 0; i < B64.length; i++) b64Lookup[B64.charCodeAt(i)] = i;
  }
  return b64Lookup;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new TypeError('invalid base64 length');
  const table = lookup();
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? table[code]! : -1;
    if (v < 0) throw new TypeError('invalid base64 character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** 帧 → 文本（JSON；`Uint8Array` 编成 base64 标记） */
export function encodeWireFrame(frame: unknown): string {
  return JSON.stringify(frame, (_key, value: unknown) =>
    value instanceof Uint8Array ? { [U8_TAG]: bytesToBase64(value) } : value,
  );
}

/** 文本 → 帧（未校验：交给帧 schema 校验）；不是合法 JSON 时抛错 */
export function decodeWireFrame(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const tagged = (value as Record<string, unknown>)[U8_TAG];
      if (keys.length === 1 && typeof tagged === 'string') return base64ToBytes(tagged);
    }
    return value;
  });
}
