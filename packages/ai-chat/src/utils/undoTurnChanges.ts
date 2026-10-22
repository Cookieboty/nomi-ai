/** 撤销本轮对若干文件的写入：优先用 diff 还原旧内容，否则 git checkout，新增无旧内容则删除 */
import { reconstructOldText } from './diffReconstruct';
import type { ChangeEntry } from './sessionChanges';
import { workspaceRelPath } from './workspacePath';

export interface UndoIoResult {
  ok: boolean;
  error?: string;
  code?: string;
}

export interface UndoIo {
  write: (cwd: string, rel: string, content: string) => Promise<UndoIoResult>;
  remove: (cwd: string, rel: string) => Promise<UndoIoResult>;
  gitCheckout?: (cwd: string, rel: string) => Promise<UndoIoResult>;
}

export interface UndoFileOutcome {
  file: string;
  ok: boolean;
  method?: 'diff' | 'git' | 'delete';
  error?: string;
}

export async function undoTurnChanges(
  cwd: string,
  entries: readonly ChangeEntry[],
  io: UndoIo,
): Promise<UndoFileOutcome[]> {
  const out: UndoFileOutcome[] = [];
  for (const e of entries) {
    const rel = workspaceRelPath(cwd, e.file);
    if (e.diff && !e.diff.summaryOnly) {
      const old = reconstructOldText(e.diff.diff);
      if (old != null) {
        const r = await io.write(cwd, rel, old);
        out.push({
          file: e.file,
          ok: r.ok,
          method: 'diff',
          error: r.ok ? undefined : r.error || r.code,
        });
        continue;
      }
    }
    if (e.status === 'added') {
      const r = await io.remove(cwd, rel);
      out.push({
        file: e.file,
        ok: r.ok,
        method: 'delete',
        error: r.ok ? undefined : r.error || r.code,
      });
      continue;
    }
    if (io.gitCheckout) {
      const r = await io.gitCheckout(cwd, rel);
      out.push({
        file: e.file,
        ok: r.ok,
        method: 'git',
        error: r.ok ? undefined : r.error || r.code,
      });
      continue;
    }
    out.push({ file: e.file, ok: false, error: 'no-restore-path' });
  }
  return out;
}
