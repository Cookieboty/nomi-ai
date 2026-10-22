/** 解析 `git status --short` porcelain 与 unified diff 为文件行 */

export type GitFileStatus = 'M' | 'A' | 'D' | '?' | 'R' | 'C' | 'U' | ' ';

export interface GitFileEntry {
  path: string;
  /** 工作区位（第二列）或未跟踪 */
  work: GitFileStatus;
  /** 暂存区位（第一列） */
  index: GitFileStatus;
  /** 展示用单字母：优先工作区，其次暂存区 */
  letter: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

function letterOf(ch: string): GitFileStatus {
  const c = (ch || ' ').toUpperCase();
  if (c === '?' || c === '!') return '?';
  if ('MADRCUT '.includes(c)) return c as GitFileStatus;
  return 'M';
}

/** 解析一行 porcelain：`XY path` 或 `XY old -> new` */
export function parseStatusLine(line: string): GitFileEntry | null {
  const raw = line.replace(/\r$/, '');
  if (!raw.trim()) return null;
  if (raw.length < 3) return null;
  const x = raw[0] ?? ' ';
  const y = raw[1] ?? ' ';
  let path = raw.slice(2).trim();
  if (path.includes(' -> ')) path = path.split(' -> ').pop()!.trim();
  if (!path) return null;
  const index = letterOf(x === '?' ? '?' : x);
  const work = letterOf(y === '?' ? '?' : y);
  const untracked = x === '?' && y === '?';
  const staged = !untracked && index !== ' ' && index !== '?';
  const unstaged = untracked || (work !== ' ' && work !== '?') || work === '?';
  const letter = untracked ? '?' : work !== ' ' ? work : index;
  return { path, work, index, letter, staged, unstaged, untracked };
}

export function parseGitStatus(status: string): GitFileEntry[] {
  const out: GitFileEntry[] = [];
  const seen = new Set<string>();
  for (const line of status.split('\n')) {
    const e = parseStatusLine(line);
    if (!e || seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(e);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function isNotGitRepoError(error?: string | null): boolean {
  if (!error) return false;
  return /not a git repository|不是 git 仓库|outside repository/i.test(error);
}

export interface ParsedDiffFile {
  file: string;
  body: string;
  added: number;
  removed: number;
}

/** 按 `diff --git` 切分 unified diff */
export function splitUnifiedDiff(raw: string): ParsedDiffFile[] {
  if (!raw.trim()) return [];
  const chunks = raw.split(/^diff --git /m).filter(Boolean);
  return chunks.map((c) => {
    const body =
      c.startsWith('a/') || c.startsWith('diff ')
        ? c.startsWith('diff ')
          ? c
          : `diff --git ${c}`
        : `diff --git ${c}`;
    const file =
      /^diff --git a\/(.+?) b\//m.exec(body)?.[1] ??
      /^\+\+\+ b\/(.+)$/m.exec(body)?.[1] ??
      '(unnamed)';
    let added = 0;
    let removed = 0;
    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { file, body, added, removed };
  });
}
