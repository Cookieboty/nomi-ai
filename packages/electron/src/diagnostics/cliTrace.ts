/**
 * 诊断日志：编程助手子进程的原始收发（stdin / stdout / stderr、启动参数与退出码）。
 * 只在诊断日志开着时记录（开发版必开，正式版在「设置 → 隐私与权限」里由用户打开），
 * 写到 userData/logs/cli-YYYY-MM-DD.jsonl，每行一条；单日超过上限后停写并留一行说明。
 * 文本按常见密钥格式脱敏（Bearer、sk-…等）；令牌只在子进程环境变量里，环境变量不记录。
 * 文件与 app.log 在同一目录，随旧日志清理一起删除（7 天）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { redactText } from '@nomi-ai/gateway';

/** 单日文件上限 */
const MAX_DAY_BYTES = 200 * 1024 * 1024;
/** 单条记录最多保留的字符数 */
const MAX_CHUNK_CHARS = 64 * 1024;

interface TapTarget {
  pid?: number;
  stdin: { write: (...a: never[]) => boolean };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

let dir: string | null = null;
let enabled: () => boolean = () => false;
let day = '';
let written = 0;
let capped = false;

/** 主进程启动时配置一次：日志目录与「现在开没开」 */
export function configureCliTrace(o: { dir: string; enabled: () => boolean }): void {
  dir = o.dir;
  enabled = o.enabled;
}

function file(now: Date): string | null {
  if (!dir) return null;
  const d = now.toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    capped = false;
    try {
      written = fs.statSync(path.join(dir, `cli-${d}.jsonl`)).size;
    } catch {
      written = 0;
    }
  }
  return path.join(dir, `cli-${d}.jsonl`);
}

function write(rec: Record<string, unknown>): void {
  const now = new Date();
  const f = file(now);
  if (!f || capped) return;
  let line = `${JSON.stringify({ t: now.toISOString(), ...rec })}\n`;
  if (written + line.length > MAX_DAY_BYTES) {
    capped = true;
    line = `${JSON.stringify({ t: now.toISOString(), note: 'daily size limit reached, stop logging' })}\n`;
  }
  written += line.length;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, line, { mode: 0o600 });
  } catch {
    /* 诊断日志写不了不能影响编程助手 */
  }
}

function text(chunk: unknown): string {
  const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const cut = s.length > MAX_CHUNK_CHARS ? `${s.slice(0, MAX_CHUNK_CHARS)}…[truncated]` : s;
  return redactText(cut);
}

/**
 * 给一个刚 spawn 的 CLI 子进程挂上记录：没开诊断日志时什么都不做。
 * stdout / stderr 加的是额外的 data 监听，不影响原有的读取。
 */
export function traceCliChild(child: TapTarget, command: string, args: readonly string[]): void {
  if (!enabled()) return;
  const cli = path.basename(command);
  const pid = child.pid;
  write({ pid, cli, ev: 'spawn', args: args.map((a) => redactText(a)) });
  const stdin = child.stdin as unknown as { write: (...a: unknown[]) => boolean };
  const orig = stdin.write.bind(stdin);
  stdin.write = (...a: unknown[]) => {
    write({ pid, cli, ev: 'in', data: text(a[0]) });
    return orig(...a);
  };
  child.stdout.on('data', (c: unknown) => write({ pid, cli, ev: 'out', data: text(c) }));
  child.stderr.on('data', (c: unknown) => write({ pid, cli, ev: 'err', data: text(c) }));
  child.on('close', (code, signal) => write({ pid, cli, ev: 'exit', code, signal }));
}
