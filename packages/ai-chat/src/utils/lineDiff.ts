/** 行级 diff：由「旧文本 / 新文本」或统一 diff 文本生成可着色的行列表（纯函数） */

export type DiffLineType = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
}

const CONTEXT = 2;
/** 中间段两侧都不超过该行数才做 LCS；否则整段当作「全删 + 全增」 */
const LCS_LIMIT = 300;

const splitLines = (s: string): string[] => {
  if (!s) return [];
  const parts = s.replace(/\r\n/g, '\n').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
};

type Op = { t: 'ctx' | 'add' | 'del'; text: string };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: 'del', text: a[i++]! });
    else ops.push({ t: 'add', text: b[j++]! });
  }
  while (i < n) ops.push({ t: 'del', text: a[i++]! });
  while (j < m) ops.push({ t: 'add', text: b[j++]! });
  return ops;
}

/** 旧 → 新：先剥掉公共首尾行，再对中间段求差异；只保留变更附近 CONTEXT 行上下文 */
export function diffStrings(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  const mid: Op[] =
    midA.length <= LCS_LIMIT && midB.length <= LCS_LIMIT
      ? lcsOps(midA, midB)
      : [
          ...midA.map((text) => ({ t: 'del' as const, text })),
          ...midB.map((text) => ({ t: 'add' as const, text })),
        ];
  const ops: Op[] = [
    ...a.slice(0, pre).map((text) => ({ t: 'ctx' as const, text })),
    ...mid,
    ...a.slice(a.length - suf).map((text) => ({ t: 'ctx' as const, text })),
  ];
  return fromOps(ops);
}

function fromOps(ops: Op[]): DiffResult {
  // 标记需要保留的行：变更行及其前后 CONTEXT 行
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, i) => {
    if (op.t === 'ctx') return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++)
      keep[k] = true;
  });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldNo = 1;
  let newNo = 1;
  let skipped = false;
  ops.forEach((op, i) => {
    const o = op.t === 'add' ? undefined : oldNo;
    const n = op.t === 'del' ? undefined : newNo;
    if (op.t !== 'add') oldNo++;
    if (op.t !== 'del') newNo++;
    if (op.t === 'add') added++;
    if (op.t === 'del') removed++;
    if (!keep[i]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length) lines.push({ type: 'hunk', text: '…' });
    skipped = false;
    lines.push({
      type: op.t,
      text: op.text,
      ...(o !== undefined ? { oldNo: o } : {}),
      ...(n !== undefined ? { newNo: n } : {}),
    });
  });
  return { lines, added, removed };
}

/** 整个文件都是新增（Write / 新建文件） */
export function diffAllAdded(content: string): DiffResult {
  const rows = splitLines(content);
  return {
    lines: rows.map((text, i) => ({ type: 'add' as const, text, newNo: i + 1 })),
    added: rows.length,
    removed: 0,
  };
}

/** 统一 diff / apply_patch 文本 → 行列表（识别 +/- 行与 @@ 头；其余当上下文） */
export function parsePatch(patch: string): DiffResult {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const raw of splitLines(patch)) {
    if (/^(diff --git|index |--- |\+\+\+ |\*\*\* (Begin|End) Patch)/.test(raw)) continue;
    if (/^(@@|\*\*\* (Update|Add|Delete) File)/.test(raw)) {
      lines.push({ type: 'hunk', text: raw });
    } else if (raw.startsWith('+')) {
      added++;
      lines.push({ type: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      removed++;
      lines.push({ type: 'del', text: raw.slice(1) });
    } else {
      lines.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }
  return { lines, added, removed };
}
