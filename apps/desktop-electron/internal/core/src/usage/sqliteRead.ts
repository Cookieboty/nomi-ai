/**
 * 只读 SQLite 来源（OpenCode / Copilot CLI）：用 Node 自带的 `node:sqlite`（无原生依赖、不新增包），
 * 以只读方式打开，只执行下面写死的 SELECT（只取记账列），参数只有整数游标。
 * 不读任何凭据 / 对话内容列；`node:sqlite` 不可用或库被锁 / 结构不符时静默返回空（不影响其它来源）。
 */
import fs from 'node:fs';

import type { CopilotRow, OpencodeRow } from './logParsers';

interface Stmt {
  all(...params: unknown[]): unknown[];
}
interface Db {
  prepare(sql: string): Stmt;
  close(): void;
}
type DbCtor = new (path: string, opts?: { readOnly?: boolean }) => Db;

function loadCtor(): DbCtor | null {
  try {
    // 运行时才加载：Electron / Node 太旧没有这个内置模块时降级为不支持
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('node:sqlite') as { DatabaseSync?: DbCtor };
    return m.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

/** 每轮最多读多少行（超大库分多轮追平） */
export const DB_BATCH = 20_000;

function select<T>(file: string, sql: string, params: number[]): T[] {
  const Ctor = loadCtor();
  if (!Ctor) return [];
  let db: Db | null = null;
  try {
    db = new Ctor(file, { readOnly: true });
    return db.prepare(sql).all(...params) as T[];
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

/** 数据库文件 + WAL 的「指纹」：没变就不用查 */
export function dbSignature(file: string): string | null {
  try {
    const a = fs.statSync(file);
    let w = '';
    try {
      const b = fs.statSync(`${file}-wal`);
      w = `${b.size}:${b.mtimeMs}`;
    } catch {
      /* 没有 WAL */
    }
    return `${a.size}:${a.mtimeMs}:${w}`;
  } catch {
    return null;
  }
}

/**
 * OpenCode：message 表里 role=assistant 且 time_updated >= since 的行（按 time_updated 升序）。
 * 只取：id、session_id、创建时间、模型 / 供应商、tokens 各项、工作目录。
 */
export function readOpencodeRows(
  file: string,
  sinceUpdated: number,
): Array<OpencodeRow & { updated: number }> {
  return select(
    file,
    `SELECT id, session_id, time_updated AS updated,
            COALESCE(json_extract(data,'$.time.created'), time_created) AS created,
            json_extract(data,'$.modelID') AS model,
            json_extract(data,'$.providerID') AS provider,
            json_extract(data,'$.tokens.input') AS input,
            json_extract(data,'$.tokens.output') AS output,
            json_extract(data,'$.tokens.reasoning') AS reasoning,
            json_extract(data,'$.tokens.cache.read') AS cache_read,
            json_extract(data,'$.tokens.cache.write') AS cache_write,
            json_extract(data,'$.path.cwd') AS cwd
     FROM message
     WHERE json_valid(data) AND json_extract(data,'$.role') = 'assistant' AND time_updated >= ?
     ORDER BY time_updated ASC
     LIMIT ${DB_BATCH}`,
    [sinceUpdated],
  );
}

/** Copilot CLI：assistant_usage_events 里 id > lastId 的行（按 id 升序），只取记账列。 */
export function readCopilotRows(file: string, lastId: number): CopilotRow[] {
  return select(
    file,
    `SELECT id, session_id, model, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, created_at
     FROM assistant_usage_events
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ${DB_BATCH}`,
    [lastId],
  );
}
