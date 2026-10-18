/**
 * 唤醒词匹配（纯逻辑）：对本地 whisper 的转写做宽松匹配。
 * - 去标点 / 空白 / 大小写，繁简常见字归一；
 * - 允许少量识别误差（按字的编辑距离，短语长度 ≤4 允许 1 处，>4 允许 2 处）；
 * - 返回唤醒词之后的剩余文本（「你好，诺米，明天天气怎么样」→ 直接当作指令）。
 */
const TRAD: Record<string, string> = {
  妳: '你',
  桌: '桌',
  檯: '台',
  臺: '台',
  說: '说',
  話: '话',
  嗎: '吗',
  麼: '么',
  個: '个',
  這: '这',
  們: '们',
};

export function normalizeForWake(s: string): string {
  return Array.from(s.toLowerCase())
    .map((c) => TRAD[c] ?? c)
    .filter((c) => /[\p{L}\p{N}]/u.test(c))
    .join('');
}

function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...new Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length]![b.length]!;
}

export interface WakeMatch {
  matched: boolean;
  /** 唤醒词之后的文本（原样，去掉前导标点） */
  rest: string;
}

export function matchWakePhrase(text: string, phrase: string): WakeMatch {
  const p = Array.from(normalizeForWake(phrase));
  if (!p.length) return { matched: false, rest: '' };
  const raw = Array.from(text);
  // 建立规范化字符 → 原文下标映射
  const norm: string[] = [];
  const idx: number[] = [];
  raw.forEach((c, i) => {
    const n = normalizeForWake(c);
    if (n) {
      norm.push(n);
      idx.push(i);
    }
  });
  const tol = p.length <= 4 ? 1 : 2;
  // 只在开头附近、或一句话刚结束处（。！？.!?）找起点，防止长句中间偶然命中
  const starts = new Set<number>();
  for (let k = 0; k <= Math.min(norm.length - 1, 3); k++) starts.add(k);
  raw.forEach((c, i) => {
    if (!/[。！？!?.]/.test(c) || (c === '.' && /\d/.test(raw[i + 1] ?? ''))) return;
    const k = idx.findIndex((x) => x > i);
    if (k >= 0) {
      starts.add(k);
      if (k + 1 < norm.length) starts.add(k + 1);
    }
  });
  let best: { d: number; end: number; gap: number } | null = null;
  for (const start of starts) {
    const offset = start <= 3 ? start : starts.has(start - 1) && start - 1 > 3 ? 1 : 0;
    for (
      let len = Math.max(1, p.length - tol);
      len <= p.length + tol && start + len <= norm.length;
      len++
    ) {
      const d = editDistance(norm.slice(start, start + len), p) + offset * 0.01;
      const gap = Math.abs(len - p.length);
      if (d <= tol + 0.05 && (!best || d < best.d || (d === best.d && gap < best.gap)))
        best = { d, end: start + len, gap };
    }
  }
  if (best) {
    const endRaw = idx[best.end - 1]! + 1;
    const rest = raw
      .slice(endRaw)
      .join('')
      .replace(/^[\s\p{P}]+/u, '')
      .trim();
    return { matched: true, rest };
  }
  return { matched: false, rest: '' };
}
