import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { t } from '../i18n';

import { type AppTrash, moveNoOverwrite } from './AppTrash';

/** 逆操作 */
export type InverseOp =
  | { op: 'move'; from: string; to: string }
  | { op: 'restore'; stored: string; original: string }
  | {
      op: 'trash';
      path: string;
      /** 撤销前该文件应仍是我们写入的那一版（size + mtime）；不符说明用户之后改过，拒绝撤销 */
      expectSize?: number;
      expectMtimeMs?: number;
    }
  | { op: 'truncate'; path: string; size: number; expectSize: number }
  /** 由注册的处理器执行（笔记内容回写、提醒状态恢复等非纯文件操作） */
  | { op: 'custom'; kind: string; payload: unknown };

export interface CustomUndo {
  /** 返回问题描述则不执行撤销 */
  check(payload: unknown): string | null;
  apply(payload: unknown): Promise<void> | void;
}

export interface JournalEntry {
  id: string;
  ts: number;
  tool: string;
  summary: string;
  /** 按顺序执行即可撤销 */
  inverse: InverseOp[];
}

interface UndoMark {
  undoOf: string;
  ts: number;
}

/** 撤销日志：userData/desktop/journal.jsonl（只追加；撤销本身也追加一条标记） */
export class UndoJournal {
  private readonly custom = new Map<string, CustomUndo>();

  registerCustom(kind: string, h: CustomUndo): void {
    this.custom.set(kind, h);
  }

  constructor(
    private readonly file: string,
    private readonly trash: AppTrash,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): { entries: JournalEntry[]; undone: Set<string> } {
    const entries: JournalEntry[] = [];
    const undone = new Set<string>();
    if (!fs.existsSync(this.file)) return { entries, undone };
    for (const l of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l) as JournalEntry | UndoMark;
        if ('undoOf' in o) undone.add(o.undoOf);
        else entries.push(o);
      } catch {
        /* skip */
      }
    }
    return { entries, undone };
  }

  record(tool: string, summary: string, inverse: InverseOp[]): JournalEntry {
    const e: JournalEntry = { id: randomUUID(), ts: this.now(), tool, summary, inverse };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    return e;
  }

  list(limit = 50): Array<JournalEntry & { undone: boolean }> {
    const { entries, undone } = this.read();
    return entries
      .slice(-limit)
      .reverse()
      .map((e) => ({ ...e, undone: undone.has(e.id) }));
  }

  /** 最近一条尚未撤销的记录 */
  last(): JournalEntry | null {
    const { entries, undone } = this.read();
    for (let i = entries.length - 1; i >= 0; i -= 1)
      if (!undone.has(entries[i].id)) return entries[i];
    return null;
  }

  /**
   * 校验逆操作是否仍可执行（文件在此之后被改过 → 不自动撤销）。
   * 一条记录里的逆操作是顺序执行的（如覆盖的撤销 = 先 trash 新文件、再 restore 旧文件），
   * 所以预检必须在「虚拟文件系统」上按顺序模拟，而不是都对着当前磁盘状态判断。
   */
  check(e: JournalEntry): string | null {
    const virt = new Map<string, boolean>();
    const present = (p: string) => (virt.has(p) ? virt.get(p)! : fs.existsSync(p));
    for (const op of e.inverse) {
      if (op.op === 'move') {
        if (!present(op.from) || present(op.to))
          return t('electron.common.couldn-t-move-back', op.from);
        virt.set(op.from, false);
        virt.set(op.to, true);
      } else if (op.op === 'restore') {
        if (!present(op.stored) || present(op.original))
          return t('electron.common.couldn-t-restore', op.original);
        virt.set(op.stored, false);
        virt.set(op.original, true);
      } else if (op.op === 'trash') {
        if (!present(op.path)) return t('electron.common.file-no-longer-exists', op.path);
        if (op.expectSize !== undefined && !virt.has(op.path)) {
          let st: fs.Stats | null;
          try {
            st = fs.statSync(op.path);
          } catch {
            st = null;
          }
          if (
            !st ||
            st.size !== op.expectSize ||
            (op.expectMtimeMs !== undefined && st.mtimeMs !== op.expectMtimeMs)
          )
            return t('electron.common.the-file-was-modified-afterwards', op.path);
        }
        virt.set(op.path, false);
      } else if (op.op === 'custom') {
        const h = this.custom.get(op.kind);
        if (!h) return t('electron.common.can-t-undo', op.kind);
        const p = h.check(op.payload);
        if (p) return p;
      } else if (op.op === 'truncate') {
        if (!fs.existsSync(op.path) || fs.statSync(op.path).size !== op.expectSize)
          return t('electron.common.the-file-was-modified-afterwards', op.path);
      }
    }
    return null;
  }

  async undo(e: JournalEntry): Promise<void> {
    const problem = this.check(e);
    if (problem) throw Object.assign(new Error(problem), { code: 'conflict' });
    // 多步逆操作中途失败时，把已经执行的 move / trash 退回去，避免只做了一半
    // （例如覆盖的撤销：新文件已进回收站但旧文件恢复失败 → 把新文件放回原处，双方副本都保留）
    const rollback: Array<() => Promise<void>> = [];
    try {
      for (const op of e.inverse) {
        if (op.op === 'move') {
          await moveNoOverwrite(op.from, op.to);
          rollback.push(() => moveNoOverwrite(op.to, op.from));
        } else if (op.op === 'restore') {
          await this.trash.restore(op);
        } else if (op.op === 'trash') {
          const rec = await this.trash.trash(op.path);
          rollback.push(() => this.trash.restore(rec));
        } else if (op.op === 'truncate') {
          await fs.promises.truncate(op.path, op.size);
        } else if (op.op === 'custom') {
          await this.custom.get(op.kind)!.apply(op.payload);
        }
      }
    } catch (err) {
      for (const undoStep of rollback.reverse()) {
        try {
          await undoStep();
        } catch {
          /* 尽力回滚；回收站里仍保留副本 */
        }
      }
      throw err;
    }
    fs.appendFileSync(
      this.file,
      `${JSON.stringify({ undoOf: e.id, ts: this.now() } satisfies UndoMark)}\n`,
    );
  }
}
