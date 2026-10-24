/**
 * 诊断包（docs/design/cli-plugin-architecture.md §8.4）：最近 N 小时的 app.log、编程助手收发记录
 * （cli-*.jsonl）与网关追踪（gateway/trace/*.json）打成一个 zip。
 * 每个文件打包前再按 redactText 脱敏一遍（写入时已脱敏，这里兜底旧文件与漏网的格式）；
 * 只收这几类文件，目录里别的东西（含环境变量、凭据）一概不收。纯 Node，不依赖 Electron。
 */
import fs from 'node:fs';
import path from 'node:path';

import { redactText } from '@nomi-ai/gateway';
import { strToU8, zipSync, type Zippable } from 'fflate';

/** 默认打包最近 24 小时 */
export const BUNDLE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 单个文件最多收的字节数（超出只留末尾，日志的新内容在后面） */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const LOG_FILE = /^(app(\.\d+)?\.log|cli-\d{4}-\d{2}-\d{2}\.jsonl)$/;
const TRACE_FILE = /\.json$/;

export interface BundleSource {
  /** userData/logs */
  logDir: string;
  /** userData/gateway/trace */
  traceDir: string;
}

function pick(dir: string, re: RegExp, since: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => re.test(n))
    .filter((n) => {
      try {
        const st = fs.statSync(path.join(dir, n));
        return st.isFile() && st.mtimeMs >= since;
      } catch {
        return false;
      }
    })
    .sort();
}

function readTail(file: string): string {
  const size = fs.statSync(file).size;
  if (size <= MAX_FILE_BYTES) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    fs.readSync(fd, buf, 0, MAX_FILE_BYTES, size - MAX_FILE_BYTES);
    return `[truncated: kept last ${MAX_FILE_BYTES} bytes]\n${buf.toString('utf8')}`;
  } finally {
    fs.closeSync(fd);
  }
}

/** 打包；返回 zip 字节与收进去的文件（zip 内路径） */
export function buildDiagnosticsBundle(
  src: BundleSource,
  o: { now?: number; windowMs?: number; meta?: Record<string, unknown> } = {},
): { data: Uint8Array; files: string[] } {
  const now = o.now ?? Date.now();
  const since = now - (o.windowMs ?? BUNDLE_WINDOW_MS);
  const entries: Zippable = {};
  const files: string[] = [];
  const add = (dir: string, name: string, prefix: string) => {
    try {
      entries[`${prefix}/${name}`] = strToU8(redactText(readTail(path.join(dir, name))));
      files.push(`${prefix}/${name}`);
    } catch {
      /* 读不到的（并发删除等）跳过 */
    }
  };
  for (const n of pick(src.logDir, LOG_FILE, since)) add(src.logDir, n, 'logs');
  for (const n of pick(src.traceDir, TRACE_FILE, since)) add(src.traceDir, n, 'gateway-trace');
  entries['README.txt'] = strToU8(
    [
      'Nomi diagnostics bundle',
      `created: ${new Date(now).toISOString()}`,
      `window: last ${Math.round((now - since) / 3600_000)} h`,
      ...Object.entries(o.meta ?? {}).map(([k, v]) => `${k}: ${String(v)}`),
      '',
      'Contains coding-agent input/output and gateway request/response bodies (conversation',
      'content). API keys, tokens and known secret formats are redacted; environment variables',
      'are never recorded.',
      '',
    ].join('\n'),
  );
  return { data: zipSync(entries, { level: 6 }), files };
}
