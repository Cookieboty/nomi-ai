/**
 * 把一个文件夹写进 Gemini CLI 自己的受信任文件夹列表（trustedFolders.json）。
 *
 * 只在用户在错误卡片上点了「信任此文件夹」并确认后调用，一次只信任那一个文件夹，
 * 等同于用户在 Gemini 的信任对话框里选「信任此文件夹」（TRUST_FOLDER）。不设任何全局跳过信任的环境变量。
 *
 * 文件位置与格式按 Gemini CLI 文档（docs/cli/trusted-folders.md）：
 * - 默认 `<GEMINI_CLI_HOME 或用户主目录>/.gemini/trustedFolders.json`，`GEMINI_CLI_TRUSTED_FOLDERS_PATH` 可整体覆盖；
 * - 内容是 `{ "<文件夹路径>": "TRUST_FOLDER" | "TRUST_PARENT" | "DO_NOT_TRUST" }`。
 *
 * 写入方式：
 * - 与 Gemini 用同一个锁（`<文件>.lock` 目录，mkdir 原子创建），避免和正在运行的 Gemini 同时改；
 * - 先写同目录临时文件（0600）再 rename 覆盖，任何时刻文件要么是旧的要么是新的；
 * - 保留已有的所有条目；文件解析不了就拒绝改动，绝不覆盖用户的文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t } from '../../i18n';
import { geminiDir } from '../../usage/cliHomes';

export const GEMINI_TRUST_FOLDER = 'TRUST_FOLDER';

/** 锁超过这么久没更新就视为上一个进程崩溃留下的（与 proper-lockfile 默认一致） */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 50;
const LOCK_WAIT_MS = 100;

export function geminiTrustedFoldersPath(
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.GEMINI_CLI_TRUSTED_FOLDERS_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(geminiDir(home, env), 'trustedFolders.json');
}

/** 环境变量强制不信任时，写文件也没用：直接说明原因 */
export function geminiTrustBlockedByEnv(env: NodeJS.ProcessEnv): string | null {
  if (env.GEMINI_CLI_TRUST_WORKSPACE === 'false') return 'GEMINI_CLI_TRUST_WORKSPACE=false';
  if (env.GEMINI_RESTRICTED_MODE === 'true') return 'GEMINI_RESTRICTED_MODE=true';
  return null;
}

/** Gemini 比较路径时的规范形式：绝对路径、正斜杠，Windows / macOS 不区分大小写 */
export function geminiPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  const abs = mod.resolve(p).replace(/\\/g, '/');
  return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
}

/** 去掉 JSONC 注释（Gemini 读这个文件时允许注释），字符串里的 // 与 /* 保持原样 */
export function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && n !== undefined) {
        out += n;
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function parseTrustFile(file: string, content: string): Record<string, unknown> {
  if (!content.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(stripJsonComments(content));
  } catch {
    v = undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(t('electron.common.gemini-s-trusted-folders-list-is-malformed-so', file));
  return v as Record<string, unknown>;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  // 与 Gemini（proper-lockfile）相同：锁放在文件真实路径旁边
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    /* 文件还不存在 */
  }
  const lock = `${real}.lock`;
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale: boolean;
      try {
        stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue; // 刚被释放
      }
      if (stale) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (i >= LOCK_RETRIES)
        throw new Error(t('electron.common.gemini-is-updating-its-trusted-folders-list-please'), {
          cause: e,
        });
      await sleep(LOCK_WAIT_MS);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

async function writeAtomic(file: string, content: string) {
  const tmp = `${file}.nomi-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    // Windows 上目标文件可能正被别的进程短暂占用：重试几次
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
        await sleep(50);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface GeminiTrustResult {
  /** 写进列表的文件夹（真实路径） */
  folder: string;
  /** trustedFolders.json 的位置 */
  file: string;
  /** 这个文件夹之前的设置（没有则为 null） */
  previous: string | null;
}

/**
 * 信任一个文件夹（只此一个，TRUST_FOLDER）。已有条目原样保留；同一文件夹已有条目（大小写 / 分隔符不同也算）
 * 就改那一条，不重复添加。
 */
export async function trustGeminiFolder(
  folder: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<GeminiTrustResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const blocked = geminiTrustBlockedByEnv(env);
  if (blocked)
    throw new Error(
      t('electron.common.the-environment-variable-makes-gemini-distrust-every-folder', blocked),
    );
  if (!path.isAbsolute(folder)) throw new Error(t('electron.common.invalid-working-directory'));
  let real: string;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(t('electron.common.invalid-working-directory'));
  }
  const file = geminiTrustedFoldersPath(opts.home ?? os.homedir(), env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, async () => {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const entries = parseTrustFile(file, content);
    const want = geminiPathKey(real, platform);
    const existing = Object.keys(entries).find((k) => geminiPathKey(k, platform) === want);
    const key = existing ?? real;
    const previous = existing !== undefined ? String(entries[existing]) : null;
    if (previous !== GEMINI_TRUST_FOLDER) {
      entries[key] = GEMINI_TRUST_FOLDER;
      await writeAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
    }
    return { folder: real, file, previous };
  });
}

/**
 * 范围很大的文件夹：根目录 / 盘符根、用户主目录本身、主目录下的一级文件夹（文稿、桌面、下载……）、
 * 以及 Nomi 的默认对话目录。信任它们等于信任里面的所有项目，确认时要额外提醒。
 */
export function isBroadGeminiFolder(
  folder: string,
  home: string,
  extra: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): boolean {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  const key = geminiPathKey(folder, platform);
  const parent = geminiPathKey(mod.dirname(mod.resolve(folder)), platform);
  if (key === parent) return true; // 根目录 / 盘符根
  const h = geminiPathKey(home, platform);
  if (key === h || parent === h) return true;
  return extra.some((x) => x && geminiPathKey(x, platform) === key);
}
