/**
 * 形状保持模式（docs/design/secret-privacy.md §13）：把 key 换成同形状的假 key 而不是占位符，
 * 如 sk-proj-w3axCByT… → sk-proj-hYQWRBFm…：前缀、长度、分隔符和每一位的字符类别都相同。
 * 编程助手或工具对 key 格式的校验能通过，模型也不会对着占位符说「这里有个占位符」。
 *
 * 假 key 由同一个本机密钥派生（确定：同一个值每轮都是同一个假 key，缓存不受影响），回程同样还原。
 * 只用于 API_KEY / TOKEN：长度 ≥ 8、可替换的字符 ≥ 6 个、只含字母数字和 `- _ .`（不需要 JSON 转义，
 * 也不太可能碰巧出现在别的文本里）；其余照旧发占位符。
 */
import { createHmac } from 'node:crypto';

/** 原样保留的前缀（长的在前） */
const PREFIXES = [
  'sk-ant-api03-',
  'sk-ant-admin01-',
  'sk-ant-',
  'sk-proj-',
  'sk-svcacct-',
  'sk-admin-',
  'sk-or-v1-',
  'sk-or-',
  'sk-',
  'github_pat_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxr-',
  'AKIA',
  'ASIA',
  'AIza',
  'hf_',
  'xai-',
  'gsk_',
  'nomi-gw-',
  'nomi-tab-',
];

const SHAPED_KINDS = new Set(['API_KEY', 'TOKEN']);
const MIN_SHAPE = 8;
const MIN_RANDOM = 6;

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGIT = '0123456789';

function prefixOf(v: string): string {
  const p = PREFIXES.find((x) => v.startsWith(x));
  if (p) return p;
  // 中转站自己的 key：oc_sk_…
  return /^[a-z]{2,4}_sk_/.exec(v)?.[0] ?? '';
}

/** 值的假 key；不适用时返回 null（照旧发占位符） */
export function shapeOf(key: string, kind: string, value: string): string | null {
  if (!SHAPED_KINDS.has(kind) || value.length < MIN_SHAPE) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  const prefix = prefixOf(value);
  const body = value.slice(prefix.length);
  const random = body.replace(/[^A-Za-z0-9]/g, '').length;
  if (random < MIN_RANDOM) return null;
  // 确定的随机字节：HMAC(本机密钥, shape \0 原文 \0 计数)，不够就再算一块
  const bytes: number[] = [];
  for (let n = 0; bytes.length < body.length; n++)
    bytes.push(...createHmac('sha256', key).update(`shape\u0000${value}\u0000${n}`).digest());
  let out = prefix;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const b = bytes[i]!;
    out += /[a-z]/.test(c)
      ? LOWER[b % 26]
      : /[A-Z]/.test(c)
        ? UPPER[b % 26]
        : /[0-9]/.test(c)
          ? DIGIT[b % 10]
          : c;
  }
  return out === value ? null : out;
}
