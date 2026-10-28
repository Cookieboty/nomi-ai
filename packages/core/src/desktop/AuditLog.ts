import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface AuditEntry {
  ts: number;
  tool: string;
  /** 参数（路径保留；长文本只记哈希与长度） */
  args: Record<string, unknown>;
  decision: 'auto' | 'allowed' | 'denied' | 'timeout' | 'user' | 'error';
  result: string; // 'ok' | 错误码
  ms?: number;
  provider?: string;
  source?:
    | 'agent'
    | 'drop'
    | 'settings'
    | 'undo'
    | 'scheduler'
    | 'voice'
    | 'memory'
    | 'mcp'
    | 'skill'
    | 'sandbox';
}

const TEXT_KEYS = new Set(['text', 'content', 'body', 'notes', 'code', 'stdin']);

/** 参数脱敏：文本内容只保留 sha256 前 12 位与长度，绝不记录文件 / 剪贴板内容 */
export function redactArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (TEXT_KEYS.has(k) && typeof v === 'string') {
      out[k] = {
        sha256: createHash('sha256').update(v).digest('hex').slice(0, 12),
        length: v.length,
      };
    } else if (typeof v === 'string') {
      out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      out[k] = '[object]';
    }
  }
  return out;
}

/** 本地审计日志：userData/desktop/audit/desktop-YYYY-MM.jsonl，只追加；保留 6 个月 */
export class AuditLog {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fileFor(ts: number): string {
    const d = new Date(ts);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return path.join(this.dir, `desktop-${m}.jsonl`);
  }

  append(e: Omit<AuditEntry, 'ts'> & { ts?: number }): AuditEntry {
    const entry: AuditEntry = { ...e, ts: e.ts ?? this.now(), args: redactArgs(e.args) };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(entry.ts), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  list(limit = 200): AuditEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs
      .readdirSync(this.dir)
      .filter((f) => /^desktop-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse();
    const out: AuditEntry[] = [];
    for (const f of files) {
      const lines = fs
        .readFileSync(path.join(this.dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .reverse();
      for (const l of lines) {
        try {
          out.push(JSON.parse(l) as AuditEntry);
        } catch {
          /* 损坏的行跳过 */
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  clear(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** 删除 6 个月以前的文件 */
  rotate(): void {
    if (!fs.existsSync(this.dir)) return;
    const cutoff = new Date(this.now());
    cutoff.setMonth(cutoff.getMonth() - 6);
    const keep = path.basename(this.fileFor(cutoff.getTime()));
    for (const f of fs.readdirSync(this.dir)) {
      if (/^desktop-\d{4}-\d{2}\.jsonl$/.test(f) && f < keep)
        fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}
