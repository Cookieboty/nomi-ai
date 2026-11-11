/**
 * Diff 的语法高亮：和对话代码块共用同一个按需加载的 lowlight（`markdownHighlight`）。
 * 旧 / 新两侧各自拼成连续文本整体高亮（块注释、模板字符串跨行也能着色），再按行拆回，
 * 未改行取新侧的结果。hunk 头把文本切段：段与段之间不连续，各自独立高亮。
 */
import type { DiffLine } from '../../utils/lineDiff';

import { canHighlight, highlightCode, type HastNode } from './markdownHighlight';

/** 超过这个字数就不高亮（压缩过的长行会让高亮器很慢） */
const MAX_CHARS = 200_000;

/** 扩展名 → highlight.js 语言名；不在表里的直接拿扩展名去问高亮器（它认识大部分别名，如 ts / py / rs） */
const EXT_LANG: Record<string, string> = {
  vue: 'xml',
  svelte: 'xml',
  htm: 'xml',
  svg: 'xml',
  jsonc: 'json',
  json5: 'json',
  toml: 'ini',
  mdx: 'markdown',
  patch: 'diff',
  fish: 'bash',
  zsh: 'bash',
  pyi: 'python',
};
const FILE_LANG: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.gitconfig': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
};

/** 文件路径对应的语言候选（未经高亮器确认，可能不支持）；认不出返回 undefined */
export function diffLanguage(file: string | undefined): string | undefined {
  if (!file) return;
  const name = file.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (FILE_LANG[name]) return FILE_LANG[name];
  if (/^\.env(?:\.|$)/.test(name)) return 'bash';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return;
  const ext = name.slice(dot + 1);
  return EXT_LANG[ext] ?? ext;
}

/** 把高亮结果按换行拆成逐行的节点（跨行的 span 在每行各复制一份） */
export function splitHastLines(nodes: readonly HastNode[]): HastNode[][] {
  const lines: HastNode[][] = [[]];
  for (const n of nodes) {
    if (n.type === 'text') {
      (n.value ?? '').split('\n').forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1]!.push({ type: 'text', value: part });
      });
    } else if (n.type === 'element') {
      splitHastLines(n.children ?? []).forEach((inner, i) => {
        if (i > 0) lines.push([]);
        if (inner.length) lines[lines.length - 1]!.push({ ...n, children: inner });
      });
    }
  }
  return lines;
}

function highlightSide(language: string, side: DiffLine[], out: Map<DiffLine, HastNode[]>) {
  if (!side.length) return;
  const tokens = highlightCode(language, side.map((l) => l.text).join('\n'));
  if (!tokens) return;
  const rows = splitHastLines(tokens);
  if (rows.length !== side.length) return;
  side.forEach((l, i) => out.set(l, rows[i]!));
}

/**
 * 逐行的高亮节点（按 DiffLine 对象查）；高亮器未加载、语言不支持或内容过长时返回 null，
 * 调用方按纯文本显示。
 */
export function highlightDiffLines(
  file: string | undefined,
  lines: readonly DiffLine[],
): Map<DiffLine, HastNode[]> | null {
  const language = diffLanguage(file);
  if (!language) return null;
  let total = 0;
  for (const l of lines) total += l.text.length + 1;
  if (total > MAX_CHARS) return null;
  if (!canHighlight(language)) return null;
  const out = new Map<DiffLine, HastNode[]>();
  let oldSide: DiffLine[] = [];
  let newSide: DiffLine[] = [];
  const flush = () => {
    highlightSide(language, oldSide, out);
    // 未改行在两侧都有：新侧后写，覆盖旧侧
    highlightSide(language, newSide, out);
    oldSide = [];
    newSide = [];
  };
  for (const l of lines) {
    if (l.type === 'hunk') {
      flush();
      continue;
    }
    if (l.type !== 'add') oldSide.push(l);
    if (l.type !== 'del') newSide.push(l);
  }
  flush();
  return out.size ? out : null;
}
