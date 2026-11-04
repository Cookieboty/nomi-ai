import type { WorkspaceTreeNode } from '../services/harnessClient';

export interface AtPathToken {
  start: number;
  end: number;
  query: string;
}

/** Active @-token ending at caret: from nearest @ left of caret with no whitespace between @ and caret. */
export function atPathToken(text: string, caret: number): AtPathToken | null {
  const c = Math.max(0, Math.min(caret, text.length));
  const left = text.slice(0, c);
  const at = left.lastIndexOf('@');
  if (at < 0) return null;
  const between = left.slice(at + 1);
  if (/[\s\n]/.test(between)) return null;
  return { start: at, end: c, query: between };
}

export function replaceAtPathToken(
  text: string,
  token: AtPathToken,
  insert: string,
): { text: string; caret: number } {
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}

export interface AtPathOption {
  path: string;
  kind: 'file' | 'dir';
  label: string;
}

export function flattenWorkspacePaths(nodes: readonly WorkspaceTreeNode[]): AtPathOption[] {
  const out: AtPathOption[] = [];
  const walk = (list: readonly WorkspaceTreeNode[]) => {
    for (const n of list) {
      out.push({ path: n.path.replace(/\\/g, '/'), kind: n.kind, label: n.name });
      if (n.kind === 'dir' && n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function filterAtPathOptions(
  options: readonly AtPathOption[],
  query: string,
  limit = 50,
): AtPathOption[] {
  const q = query.trim().toLowerCase();
  const scored = options
    .map((o) => {
      const path = o.path.toLowerCase();
      const base = o.label.toLowerCase();
      if (!q) return { o, score: 1 };
      if (base.includes(q)) return { o, score: 2 };
      if (path.includes(q)) return { o, score: 1 };
      return null;
    })
    .filter((x): x is { o: AtPathOption; score: number } => !!x)
    .sort((a, b) => b.score - a.score || a.o.path.localeCompare(b.o.path));
  return scored.slice(0, limit).map((x) => x.o);
}

export function formatAtPathInsert(option: AtPathOption): string {
  const p = option.path.replace(/\\/g, '/').replace(/\/+$/, '');
  return option.kind === 'dir' ? `@${p}/` : `@${p}`;
}
