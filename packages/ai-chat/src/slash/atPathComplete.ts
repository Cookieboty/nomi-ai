import type { WorkspaceTreeNode } from '../services/harnessClient';

export interface AtPathToken {
  start: number;
  end: number;
  query: string;
}

/**
 * Active @-token ending at caret: the nearest @ left of the caret, with no whitespace between @
 * and caret. The @ must start the text or follow whitespace, so emails / `user@host` never open
 * the palette (it swallows Enter while it has matches).
 */
export function atPathToken(text: string, caret: number): AtPathToken | null {
  const c = Math.max(0, Math.min(caret, text.length));
  const left = text.slice(0, c);
  const at = left.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(left[at - 1] ?? '')) return null;
  const between = left.slice(at + 1);
  if (/\s/.test(between)) return null;
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
  /** 插入的路径：工作目录里的是相对路径，项目其余文件夹里的是绝对路径 */
  path: string;
  kind: 'file' | 'dir';
  label: string;
  /** 面板里显示的路径（其余文件夹：「文件夹名/相对路径」）；缺省 = path */
  display?: string;
}

/**
 * 目录树摊平成候选。folder：项目里工作目录之外的文件夹——插入绝对路径（工作目录里的相对路径对不上它），
 * 显示成「文件夹名/相对路径」
 */
export function flattenWorkspacePaths(
  nodes: readonly WorkspaceTreeNode[],
  folder?: { root: string; name: string },
): AtPathOption[] {
  const out: AtPathOption[] = [];
  const root = folder?.root.replace(/\\/g, '/').replace(/\/+$/, '');
  const walk = (list: readonly WorkspaceTreeNode[]) => {
    for (const n of list) {
      const rel = n.path.replace(/\\/g, '/');
      out.push(
        folder
          ? {
              path: `${root}/${rel}`,
              kind: n.kind,
              label: n.name,
              display: `${folder.name}/${rel}`,
            }
          : { path: rel, kind: n.kind, label: n.name },
      );
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
      const path = (o.display ?? o.path).toLowerCase();
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
