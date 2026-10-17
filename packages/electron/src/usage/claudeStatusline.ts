/**
 * Claude Code 订阅额度：官方 statusline 输入里的 `rate_limits`（five_hour / seven_day）。
 *
 * 官方文档（https://code.claude.com/docs/en/statusline）：statusLine 命令会在 stdin 收到会话 JSON，
 * 其中 `rate_limits.five_hour|seven_day.{used_percentage,resets_at}` 仅对 claude.ai Pro / Max 订阅出现，
 * 且要在会话第一次 API 响应之后。额度不会写进 ~/.claude 的会话日志，所以本地日志解析拿不到。
 *
 * 做法（用户在面板里主动开启，可随时关闭恢复原配置）：
 * 1. 在 userData/usage 下生成一个很小的 sh 脚本：把 stdin 的 JSON 落成本地快照文件（0600），
 *    再把原来的 statusLine 命令（如果有）原样串接执行，用户原本的状态栏不受影响；
 * 2. 在 ~/.claude/settings.json 里把 statusLine 指到这个脚本（先备份，原 statusLine 记下来用于恢复）。
 * 不读取 / 不转发任何凭据，不访问网络，不调用未文档接口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writePrivateFile, writePrivateFileAtomic } from '../utils/privateFile';

import { claudeConfigDir } from './cliHomes';
import type { QuotaReading, QuotaWindow } from './quota';

export const SNAPSHOT_FILE = 'claude-statusline.json';
export const SCRIPT_FILE = 'claude-statusline.sh';
const ORIG_FILE = 'claude-statusline.orig.json';
const ORIG_CMD_FILE = 'claude-statusline.orig.cmd';
const MARK = 'nomi-usage-statusline';

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** resets_at：官方是 Unix 秒；也容忍毫秒 / ISO 字符串 */
function toMs(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e11 ? n * 1000 : n;
}

/** 解析 statusline JSON：没有 rate_limits（API 用户 / 首次响应前）返回 null，不编造 */
export function parseStatuslineRateLimits(raw: string, updatedAt: number): QuotaReading | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  const rl = (o as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const windows: QuotaWindow[] = [];
  for (const [key, minutes] of [
    ['five_hour', 300],
    ['seven_day', 10080],
  ] as const) {
    const w = rl[key] as { used_percentage?: unknown; resets_at?: unknown } | undefined;
    const pct = num(w?.used_percentage);
    if (pct === undefined || pct < 0) continue;
    const resetAt = toMs(w?.resets_at);
    windows.push({
      id: key,
      usedPercent: Math.min(100, pct),
      windowMinutes: minutes,
      ...(resetAt ? { resetAt } : {}),
    });
  }
  return windows.length ? { windows, updatedAt } : null;
}

/** 读快照文件（只提取 rate_limits，其余字段一概忽略） */
export function readStatuslineSnapshot(root: string): QuotaReading | null {
  try {
    const f = path.join(root, SNAPSHOT_FILE);
    const st = fs.statSync(f);
    return parseStatuslineRateLimits(fs.readFileSync(f, 'utf8'), st.mtimeMs);
  } catch {
    return null;
  }
}

/** POSIX sh 单引号转义 */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 生成脚本：落快照 + 串接原命令（原命令在单独的文本文件里，用 sh -c 执行，脚本里不拼接任何用户输入） */
export function buildScript(root: string): string {
  return `#!/bin/sh
# ${MARK}: saves Claude Code's statusline JSON next to Nomi's usage data (local only, 0600),
# then runs your previous statusLine command, if any. Undo it in Nomi: Settings > Usage & cost.
SNAP=${shq(path.join(root, SNAPSHOT_FILE))}
ORIGCMD=${shq(path.join(root, ORIG_CMD_FILE))}
umask 077
tmp="$SNAP.$$"
cat > "$tmp" && mv "$tmp" "$SNAP" || exit 0
if [ -s "$ORIGCMD" ]; then
  sh -c "$(cat "$ORIGCMD")" < "$SNAP"
fi
exit 0
`;
}

export interface HookStatus {
  /** 仅 macOS / Linux（需要 sh）；Windows 暂不支持，给出手动方式 */
  supported: boolean;
  enabled: boolean;
  /** 原来就有自己的 statusLine：开启后会串接执行，关闭时恢复 */
  hadOwnStatusLine: boolean;
  /** 已有快照（说明 Claude Code 已经在会话里喂过数据） */
  hasSnapshot: boolean;
  /** 不能自动开启的原因（settings.json 不是合法 JSON / statusLine 类型不是 command 等） */
  problem?: 'invalid-settings' | 'unsupported-statusline';
}

interface HookDeps {
  root: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
}

/** 尊重 CLAUDE_CONFIG_DIR */
const settingsFile = (home: string, env: NodeJS.ProcessEnv | undefined) =>
  path.join(claudeConfigDir(home, env ?? process.env), 'settings.json');

function readSettings(
  file: string,
): { ok: true; raw: string | null; obj: Record<string, unknown> } | { ok: false } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: true, raw: null, obj: {} };
  }
  if (!raw.trim()) return { ok: true, raw, obj: {} };
  try {
    const o = JSON.parse(raw) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o))
      return { ok: true, raw, obj: o as Record<string, unknown> };
  } catch {
    /* 落到下面 */
  }
  return { ok: false };
}

/** 原子写 settings.json，并保持原文件权限位（writePrivateFileAtomic 默认收紧到 0600） */
function writeSettings(file: string, text: string): void {
  let mode: number | null = null;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* 新文件 */
  }
  writePrivateFileAtomic(file, text);
  if (mode !== null) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      /* 忽略 */
    }
  }
}

const isOurs = (sl: unknown, root: string): boolean => {
  const c = (sl as { command?: unknown } | undefined)?.command;
  return typeof c === 'string' && c.includes(path.join(root, SCRIPT_FILE));
};

export function hookStatus(d: HookDeps): HookStatus {
  const home = d.home ?? os.homedir();
  const platform = d.platform ?? process.platform;
  const s = readSettings(settingsFile(home, d.env));
  const hasSnapshot = fs.existsSync(path.join(d.root, SNAPSHOT_FILE));
  const base = { supported: platform !== 'win32', hasSnapshot };
  if (!s.ok)
    return { ...base, enabled: false, hadOwnStatusLine: false, problem: 'invalid-settings' };
  const sl = s.obj.statusLine as { type?: unknown } | undefined;
  const enabled = isOurs(sl, d.root);
  const hadOwn = enabled
    ? fs.existsSync(path.join(d.root, ORIG_FILE))
    : !!sl && typeof sl === 'object';
  const problem =
    !enabled && sl && typeof sl === 'object' && sl.type !== 'command'
      ? ('unsupported-statusline' as const)
      : undefined;
  return { ...base, enabled, hadOwnStatusLine: hadOwn, ...(problem ? { problem } : {}) };
}

/** 开启：写脚本、备份并改写 settings.json 的 statusLine。出问题抛 Error，且不会改动 settings.json。 */
export function enableHook(d: HookDeps): HookStatus {
  const home = d.home ?? os.homedir();
  const st = hookStatus(d);
  if (!st.supported) throw new Error('unsupported-platform');
  if (st.problem) throw new Error(st.problem);
  if (st.enabled) return st;
  const file = settingsFile(home, d.env);
  const s = readSettings(file);
  if (!s.ok) throw new Error('invalid-settings');

  fs.mkdirSync(d.root, { recursive: true });
  const prev = s.obj.statusLine as Record<string, unknown> | undefined;
  const script = path.join(d.root, SCRIPT_FILE);
  // 1) 脚本与原命令
  fs.writeFileSync(script, buildScript(d.root), { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  if (prev && typeof prev === 'object') {
    writePrivateFile(path.join(d.root, ORIG_FILE), JSON.stringify(prev));
    writePrivateFile(
      path.join(d.root, ORIG_CMD_FILE),
      typeof prev.command === 'string' ? prev.command : '',
    );
  } else {
    fs.rmSync(path.join(d.root, ORIG_FILE), { force: true });
    fs.rmSync(path.join(d.root, ORIG_CMD_FILE), { force: true });
  }
  // 2) 备份 settings.json，再改写 statusLine（保留其它所有字段；沿用原来的 padding / refreshInterval）
  if (s.raw !== null) {
    const bdir = path.join(d.root, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    writePrivateFile(
      path.join(bdir, `claude-settings.${d.now ? d.now() : Date.now()}.json`),
      s.raw,
    );
  }
  const next: Record<string, unknown> = { type: 'command', command: shq(script) };
  if (prev && typeof prev.padding === 'number') next.padding = prev.padding;
  if (prev && typeof prev.refreshInterval === 'number') next.refreshInterval = prev.refreshInterval;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSettings(file, `${JSON.stringify({ ...s.obj, statusLine: next }, null, 2)}\n`);
  return hookStatus(d);
}

/** 关闭：恢复原 statusLine（没有就删掉这个键），清理脚本 / 快照。当前不是我们的配置则只清理自己的文件。 */
export function disableHook(d: HookDeps): HookStatus {
  const home = d.home ?? os.homedir();
  const file = settingsFile(home, d.env);
  const s = readSettings(file);
  if (s.ok && isOurs(s.obj.statusLine, d.root)) {
    let orig: unknown;
    try {
      orig = JSON.parse(fs.readFileSync(path.join(d.root, ORIG_FILE), 'utf8'));
    } catch {
      orig = undefined;
    }
    const next = { ...s.obj };
    if (orig && typeof orig === 'object') next.statusLine = orig;
    else delete next.statusLine;
    writeSettings(file, `${JSON.stringify(next, null, 2)}\n`);
  }
  for (const f of [SCRIPT_FILE, SNAPSHOT_FILE, ORIG_FILE, ORIG_CMD_FILE])
    fs.rmSync(path.join(d.root, f), { force: true });
  return hookStatus(d);
}
