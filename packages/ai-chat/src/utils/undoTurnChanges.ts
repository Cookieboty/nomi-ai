/**
 * 撤销本轮对若干文件的写入。
 * - 有片段 diff（Edit / 补丁）：读当前内容，把「新」换回「旧」再写回（只改这几处，不碰其它内容）；
 *   找不到（之后又被改过）就报错，不覆盖。
 * - 整文件写入（diff 全是新增）：当前内容与写入内容一致时，优先 git checkout 取回旧版本，否则删除；
 *   内容已变则报错。
 * - 没有 diff 内容：git checkout；新增文件删除。
 */
import { reconstructNewText, reverseApplyDiff } from './diffReconstruct';
import type { ChangeEntry } from './sessionChanges';
import { workspaceRelPath } from './workspacePath';

export interface UndoIoResult {
  ok: boolean;
  error?: string;
  code?: string;
}

export interface UndoIo {
  /** 读当前文件内容（片段 diff 的撤销必须有它） */
  read?: (
    cwd: string,
    rel: string,
  ) => Promise<UndoIoResult & { content?: string; binary?: boolean }>;
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
      const lines = e.diff.diff.lines;
      const wholeFileWrite = lines.length > 0 && lines.every((l) => l.type === 'add');
      if (!io.read) {
        out.push({ file: e.file, ok: false, error: 'no-read' });
        continue;
      }
      const cur = await io.read(cwd, rel);
      if (!cur.ok || cur.binary || typeof cur.content !== 'string') {
        out.push({ file: e.file, ok: false, error: cur.error || cur.code || 'read-failed' });
        continue;
      }
      if (wholeFileWrite) {
        // 整文件写入：旧内容不在 diff 里。只在文件还是当时写入的样子时才动它
        const written = reconstructNewText(e.diff.diff);
        if (written == null || cur.content.replace(/\r\n/g, '\n').replace(/\n$/, '') !== written) {
          out.push({ file: e.file, ok: false, method: 'diff', error: 'changed' });
          continue;
        }
        if (io.gitCheckout) {
          const g = await io.gitCheckout(cwd, rel);
          if (g.ok) {
            out.push({ file: e.file, ok: true, method: 'git' });
            continue;
          }
        }
        const r = await io.remove(cwd, rel);
        out.push({
          file: e.file,
          ok: r.ok,
          method: 'delete',
          error: r.ok ? undefined : r.error || r.code,
        });
        continue;
      }
      const restored = reverseApplyDiff(cur.content, e.diff.diff);
      if (restored == null) {
        out.push({ file: e.file, ok: false, method: 'diff', error: 'changed' });
        continue;
      }
      const r = await io.write(cwd, rel, restored);
      out.push({
        file: e.file,
        ok: r.ok,
        method: 'diff',
        error: r.ok ? undefined : r.error || r.code,
      });
      continue;
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

/** 撤销失败原因 → 用户能看懂的话 */
export function undoErrorText(
  error: string | undefined,
  translate: (zh: string) => string,
): string {
  if (error === 'changed')
    return translate('文件之后又被修改过，无法安全撤销（请用版本控制或手动处理）');
  if (error === 'no-read' || error === 'read-failed') return translate('读取当前文件失败');
  return error || '?';
}
