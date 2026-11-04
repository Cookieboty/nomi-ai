/**
 * 开发者工具（对话消息旁的「执行轨迹」抽屉）读诊断日志：
 * - readCliRecords：从 logs/cli-YYYY-MM-DD.jsonl 取某个标签在一段时间里的子进程原始收发；
 * - readGatewayTrace：按追踪 id 取网关写的请求 / 响应正文（gateway/trace/<时间>-<客户端>-<id>.json）。
 * 两类文件写入时已脱敏；这里只读、限量，不再改写。Go 版同名移植在 internal/core/diagnostics/devtools.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** 一次最多返回的收发记录条数 */
export const MAX_CLI_RECORDS = 2000;
/** 一次最多返回的收发正文字符数 */
export const MAX_CLI_CHARS = 2_000_000;
/** 时间窗两端放宽（ms）：子进程的输出可能比界面记下的开始 / 结束略早或略晚 */
export const CLI_WINDOW_SLACK_MS = 2000;
/** 网关正文最多返回的字符数 */
export const MAX_GATEWAY_TRACE_CHARS = 4_000_000;
/** 一次最多跨的天数（按 UTC 日期分文件） */
const MAX_DAYS = 7;
const DAY_MS = 86_400_000;

const TAB_ID = /^[A-Za-z0-9_:.-]{1,80}$/;
const TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface CliRecordsQuery {
  tabId: string;
  from: number;
  to: number;
}

export interface CliRecord {
  t: string;
  ev?: string;
  pid?: number;
  cli?: string;
  data?: string;
  args?: string[];
  code?: number | null;
  signal?: string | null;
  note?: string;
}

export interface CliRecordsResult {
  enabled: boolean;
  records: CliRecord[];
  /** 超过条数 / 字符上限，后面的没有返回 */
  truncated: boolean;
}

export interface GatewayTraceResult {
  found: boolean;
  text?: string;
  truncated?: boolean;
}

function pick(raw: Record<string, unknown>): CliRecord | null {
  if (typeof raw.t !== 'string') return null;
  const r: CliRecord = { t: raw.t };
  if (typeof raw.ev === 'string') r.ev = raw.ev;
  if (typeof raw.pid === 'number') r.pid = raw.pid;
  if (typeof raw.cli === 'string') r.cli = raw.cli;
  if (typeof raw.data === 'string') r.data = raw.data;
  if (Array.isArray(raw.args)) r.args = raw.args.filter((a): a is string => typeof a === 'string');
  if (typeof raw.code === 'number' || raw.code === null) r.code = raw.code;
  if (typeof raw.signal === 'string' || raw.signal === null) r.signal = raw.signal;
  if (typeof raw.note === 'string') r.note = raw.note;
  return r;
}

/** 某个标签在 [from, to] 里的收发记录（按时间顺序）；不合法的查询返回空 */
export async function readCliRecords(
  dir: string,
  q: CliRecordsQuery,
  enabled: boolean,
): Promise<CliRecordsResult> {
  const out: CliRecordsResult = { enabled, records: [], truncated: false };
  if (!TAB_ID.test(q.tabId) || !Number.isFinite(q.from) || !Number.isFinite(q.to)) return out;
  const from = q.from - CLI_WINDOW_SLACK_MS;
  const to = Math.max(q.to, q.from) + CLI_WINDOW_SLACK_MS;
  const firstDay = Math.floor(from / DAY_MS);
  const lastDay = Math.min(Math.floor(to / DAY_MS), firstDay + MAX_DAYS - 1);
  const needle = `"tab":${JSON.stringify(q.tabId)}`;
  let chars = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const file = path.join(dir, `cli-${new Date(day * DAY_MS).toISOString().slice(0, 10)}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line.includes(needle)) continue;
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (raw.tab !== q.tabId || typeof raw.t !== 'string') continue;
        const at = Date.parse(raw.t);
        if (!(at >= from && at <= to)) continue;
        const rec = pick(raw);
        if (!rec) continue;
        const size = (rec.data?.length ?? 0) + (rec.args?.join(' ').length ?? 0);
        if (out.records.length >= MAX_CLI_RECORDS || chars + size > MAX_CLI_CHARS) {
          out.truncated = true;
          return out;
        }
        chars += size;
        out.records.push(rec);
      }
    } finally {
      rl.close();
    }
  }
  return out;
}

/** 按追踪 id 读网关正文追踪文件（找不到 / id 不合法返回 found: false） */
export async function readGatewayTrace(dir: string, traceId: string): Promise<GatewayTraceResult> {
  if (!TRACE_ID.test(traceId)) return { found: false };
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return { found: false };
  }
  const name = names.find((n) => n.endsWith(`-${traceId}.json`));
  if (!name) return { found: false };
  try {
    const text = await fs.promises.readFile(path.join(dir, name), 'utf8');
    return text.length > MAX_GATEWAY_TRACE_CHARS
      ? { found: true, text: text.slice(0, MAX_GATEWAY_TRACE_CHARS), truncated: true }
      : { found: true, text };
  } catch {
    return { found: false };
  }
}
