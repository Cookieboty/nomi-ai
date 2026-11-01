/**
 * 持续任务的存储（docs/design/persistent-tasks.md §4.3）。
 *
 * 目录 `userData/tasks/`：
 * - `<taskId>.json`：任务 + 最近 KEEP_ATTEMPTS 次执行，原子写（先写 .tmp 再 rename），崩溃时要么旧要么新；
 * - `<taskId>.events.jsonl`：只追加的事件日志（状态变化、对外动作的 intent / done、投递），也是审计记录；
 *   崩溃可能留下写了一半的最后一行，读取时跳过解析不了的行；
 * - `<taskId>.attempts.jsonl`：超出 KEEP_ATTEMPTS 的旧执行归档（只追加）。
 *
 * 写入顺序：先存快照、再追加日志（「先存再做」由 TaskRuntime 保证：effects 在 save 之后执行）。
 * Go 版：apps/desktop-go/internal/core/tasks/store.go，读写同一格式。
 */
import fs from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir, writePrivateFileAtomic } from '../utils/privateFile';

import type { Attempt, Task } from './types';
import { TASK_SCHEMA_VERSION } from './types';

/** 快照里保留的执行条数；更早的移到 attempts.jsonl */
export const KEEP_ATTEMPTS = 50;

export interface TaskRecord {
  task: Task;
  /** 按开始时间升序，最后一个是最近一次 */
  attempts: Attempt[];
}

export type JournalEntry =
  /** 状态变化（审计） */
  | {
      t: 'state';
      at: number;
      event: string;
      from: string;
      to: string;
      gen: number;
      attemptId?: string;
    }
  /** 对外动作执行前：幂等键 taskId:attemptId:seq 与内容哈希（§10.2） */
  | {
      t: 'intent';
      at: number;
      attemptId: string;
      seq: number;
      action: string;
      hash: string;
    }
  /** 对外动作成功后 */
  | { t: 'done'; at: number; attemptId: string; seq: number; externalId?: string }
  /** 晚到的回报被丢弃等运行时记录 */
  | { t: 'note'; at: number; msg: string; attemptId?: string };

interface Logger {
  warn(m: string, x?: unknown): void;
}

/** @internal 单测注入：模拟写到一半崩溃 */
export const __storeDeps = {
  writeAtomic: (file: string, data: string) => writePrivateFileAtomic(file, data),
  append: (file: string, data: string) => fs.appendFileSync(file, data, { mode: 0o600 }),
};

/** 上次崩溃可能留下没有换行结尾的半行：先补换行，免得新行粘在半行后面一起丢掉 */
function appendLines(file: string, data: string): void {
  let prefix = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) prefix = '\n';
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* 文件还不存在 */
  }
  __storeDeps.append(file, prefix + data);
}

const ID_RE = /^task_[A-Za-z0-9_-]{1,80}$/;

export function isTaskId(id: string): boolean {
  return ID_RE.test(id);
}

/** 读 jsonl：跳过空行和解析不了的行（崩溃留下的半行） */
function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 半行 */
    }
  }
  return out;
}

function looksLikeRecord(v: unknown, id: string): v is TaskRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<TaskRecord>;
  return (
    !!r.task &&
    typeof r.task === 'object' &&
    r.task.id === id &&
    typeof r.task.status === 'string' &&
    r.task.schemaVersion === TASK_SCHEMA_VERSION &&
    Array.isArray(r.attempts)
  );
}

export class TaskStore {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  private file(id: string, suffix: string): string {
    if (!isTaskId(id)) throw new Error(`invalid task id: ${id}`);
    return path.join(this.dir, `${id}${suffix}`);
  }

  /** 读全部任务；坏文件记日志后跳过（不删，留给人查），按 id 排序 */
  loadAll(): TaskRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: TaskRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!isTaskId(id)) continue;
      const rec = this.load(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  load(id: string): TaskRecord | null {
    const file = this.file(id, '.json');
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.logger.warn('任务文件读取失败', { id, error: String(error) });
      return null;
    }
    if (!looksLikeRecord(raw, id)) {
      this.logger.warn('任务文件格式不对，已跳过', { id });
      return null;
    }
    return raw;
  }

  /** 原子写快照；执行超过 KEEP_ATTEMPTS 时把最旧的先追加进归档再截掉 */
  save(rec: TaskRecord): TaskRecord {
    ensurePrivateDir(this.dir);
    let attempts = rec.attempts;
    if (attempts.length > KEEP_ATTEMPTS) {
      const old = attempts.slice(0, attempts.length - KEEP_ATTEMPTS);
      appendLines(
        this.file(rec.task.id, '.attempts.jsonl'),
        old.map((a) => `${JSON.stringify(a)}\n`).join(''),
      );
      attempts = attempts.slice(-KEEP_ATTEMPTS);
    }
    const next = { task: rec.task, attempts };
    __storeDeps.writeAtomic(this.file(rec.task.id, '.json'), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  append(id: string, entry: JournalEntry): void {
    ensurePrivateDir(this.dir);
    appendLines(this.file(id, '.events.jsonl'), `${JSON.stringify(entry)}\n`);
  }

  journal(id: string): JournalEntry[] {
    return readJsonl<JournalEntry>(this.file(id, '.events.jsonl'));
  }

  archivedAttempts(id: string): Attempt[] {
    return readJsonl<Attempt>(this.file(id, '.attempts.jsonl'));
  }

  /** 这次执行有没有「写了 intent 却没有 done」的对外动作（§10.3） */
  unconfirmedExternal(id: string, attemptId: string): boolean {
    const open = new Set<number>();
    for (const e of this.journal(id)) {
      if (e.t === 'intent' && e.attemptId === attemptId) open.add(e.seq);
      else if (e.t === 'done' && e.attemptId === attemptId) open.delete(e.seq);
    }
    return open.size > 0;
  }

  /** 删除任务的全部文件（快照、日志、归档） */
  remove(id: string): void {
    for (const s of ['.json', '.events.jsonl', '.attempts.jsonl'])
      fs.rmSync(this.file(id, s), { force: true });
  }
}
