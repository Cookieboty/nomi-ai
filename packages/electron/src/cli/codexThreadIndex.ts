/**
 * Codex 会话索引（`$CODEX_HOME/state_5.sqlite` 的 threads 表），供历史列表读标题、目录、来源等元信息。
 * 用 Node 自带的 `node:sqlite` 以只读方式打开（无原生依赖、不新增包），只执行这里写死的 SELECT，
 * 不读任何凭据。`node:sqlite` 不可用、库被锁或结构不符时返回空，由调用方退回解析 rollout 文件。
 * 这是历史功能专用的读取器；用量记账的只读来源在 usage/sqliteRead.ts，约束更严（只取计量列）。
 */

/** 历史列表用到的列 */
export interface CodexThreadRow {
  id: string;
  source?: string | null;
  originator?: string | null;
  model_provider?: string | null;
  cwd?: string | null;
  title?: string | null;
  name?: string | null;
  first_user_message?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  creator_account_id?: string | null;
}

const COLS: readonly (keyof CodexThreadRow)[] = [
  'id',
  'source',
  'originator',
  'model_provider',
  'cwd',
  'title',
  'name',
  'first_user_message',
  'model',
  'reasoning_effort',
  'creator_account_id',
];

interface Db {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
type DbCtor = new (path: string, opts?: { readOnly?: boolean }) => Db;

function loadCtor(): DbCtor | null {
  try {
    // 运行时才加载：Electron / Node 太旧没有这个内置模块时降级为不支持
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sqlite') as { DatabaseSync?: DbCtor }).DatabaseSync ?? null;
  } catch {
    return null;
  }
}

/**
 * 读出全部会话的元信息。各版本的列不完全一样：先读表结构，只选存在的列；没有 id 列时返回空。
 */
export function readCodexThreads(file: string): CodexThreadRow[] {
  const Ctor = loadCtor();
  if (!Ctor) return [];
  let db: Db | null = null;
  try {
    db = new Ctor(file, { readOnly: true });
    const cols = (
      db.prepare(`SELECT name FROM pragma_table_info('threads')`).all() as {
        name: string;
      }[]
    )
      .map((c) => c.name)
      .filter((n): n is keyof CodexThreadRow => (COLS as readonly string[]).includes(n));
    if (!cols.includes('id')) return [];
    return db.prepare(`SELECT ${cols.join(', ')} FROM threads`).all() as CodexThreadRow[];
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
  }
}
