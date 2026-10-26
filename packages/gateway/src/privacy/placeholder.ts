/**
 * 占位符（docs/design/secret-privacy.md §7.1）：`{{KIND_xxxxxxxx}}`。
 * 后缀 = HMAC-SHA256(本机密钥, KIND + "\0" + 原文) 的前 40 位，base32 小写 8 个字符：
 * 同一台机器上同一个值总是同一个占位符（缓存、thinking 签名不受影响），短密码也没法从后缀暴力反推。
 */
import { createHmac } from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function b32(buf: Buffer, chars: number): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
    acc &= (1 << bits) - 1;
  }
  return out;
}

function hmac8(key: string, data: string): string {
  return b32(createHmac('sha256', key).update(data).digest(), 8);
}

/** 占位符后缀 */
export function tagOf(key: string, kind: string, value: string): string {
  return hmac8(key, `${kind}\u0000${value}`);
}

/** `{{KIND_tag}}`；同名占位符已被另一个值占用时带序号（`{{KIND_tag_2}}`） */
export function placeholderOf(kind: string, tag: string, n = 1): string {
  return n > 1 ? `{{${kind}_${tag}_${n}}}` : `{{${kind}_${tag}}}`;
}

/**
 * 「从不脱敏」名单的标记：与类型无关、不区分大小写。主进程按同一个函数算好下发，
 * 网关只拿标记比对，名单本身不存原文（§5.3）。
 */
export function allowTagOf(key: string, value: string): string {
  return hmac8(key, `allow\u0000${value.toLowerCase()}`);
}

/** 文本里完整的占位符 */
export const PLACEHOLDER_RE = /\{\{[A-Z][A-Z_]*_[a-z2-7]{8}(?:_\d+)?\}\}/g;

/** 占位符最长多少个字符（回程扣住被切开的尾巴时的上限） */
export const MAX_PLACEHOLDER_LEN = 48;
