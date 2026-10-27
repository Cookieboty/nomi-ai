import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

/**
 * 写入含敏感信息的配置文件并强制仅当前用户可读写。
 * - POSIX：0600（writeFileSync 的 mode 只在新建时生效，故对已存在文件再 chmod 一次）
 * - Windows：mode 位被忽略，写后用 icacls 去掉继承并只授予当前用户 (F)
 * icacls 失败只打 warn，不抛错，避免挡住网关脚本生成。
 */

/** 供单测替换；生产路径走真实 spawnSync */
let spawnSyncImpl: typeof spawnSync = spawnSync;

/** @internal 单测注入 */
export function __setSpawnSyncForTest(fn: typeof spawnSync | null): void {
  spawnSyncImpl = fn ?? spawnSync;
}

/** 拼 icacls 用的用户名：优先 DOMAIN\user，避免同名本地账户歧义 */
export function windowsAclUser(): string {
  const fromOs = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return '';
    }
  })();
  const name = (process.env.USERNAME || fromOs || '').trim();
  if (!name) return '';
  if (name.includes('\\')) return name;
  const domain = (process.env.USERDOMAIN || '').trim();
  // 忽略单机常见的占位域名
  if (domain && !/^WORKGROUP$/i.test(domain)) return `${domain}\\${name}`;
  return name;
}

/**
 * Windows：去掉继承 ACL，只保留当前用户完全控制。
 * - 文件：user:(F)
 * - 目录：user:(OI)(CI)F（对象/容器继承，令牌目录下新建文件也受限）
 * 参数一律走 argv 数组，不做 shell 拼接。
 */
export function tightenWindowsAcl(targetPath: string, kind: 'file' | 'dir' = 'file'): void {
  if (process.platform !== 'win32') return;
  const user = windowsAclUser();
  if (!user) {
    console.warn('[privateFile] win32 ACL: 无法确定当前用户，跳过', targetPath);
    return;
  }
  const grant = kind === 'dir' ? `${user}:(OI)(CI)F` : `${user}:(F)`;
  try {
    const r = spawnSyncImpl('icacls', [targetPath, '/inheritance:r', '/grant:r', grant], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (r.error || (typeof r.status === 'number' && r.status !== 0)) {
      console.warn(
        '[privateFile] icacls 收紧 ACL 失败',
        targetPath,
        r.status,
        r.stderr || r.error?.message,
      );
    }
  } catch (e) {
    console.warn('[privateFile] icacls 收紧 ACL 异常', targetPath, e);
  }
}

/** 确保目录存在且仅当前用户可访问（POSIX 0700；Windows 再收紧 ACL） */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows 等平台忽略 */
  }
  tightenWindowsAcl(dir, 'dir');
}

export function writePrivateFile(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  tightenWindowsAcl(file, 'file');
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = 2_000;

/** @internal 单测注入 */
export const __renameDeps = {
  rename: (from: string, to: string) => fs.renameSync(from, to),
  platform: () => process.platform,
  sleep: (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  renameAsync: (from: string, to: string) => fsp.rename(from, to),
  sleepAsync: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const isTransientRenameError = (error: unknown) =>
  __renameDeps.platform() === 'win32' &&
  RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? '');

/**
 * Windows 上目标文件正被别的进程短暂打开（杀软 / 索引器扫描刚写的文件、其他进程读取）时
 * MoveFileEx 会报 EPERM/EACCES/EBUSY；这是瞬时占用，退避重试，超时仍失败才抛出。
 */
function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + RENAME_RETRY_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
    try {
      __renameDeps.rename(from, to);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || Date.now() >= deadline) throw error;
      __renameDeps.sleep(delay);
    }
  }
}

/**
 * 原子写：先写 0600 的 .tmp，再 rename；最后收紧目标权限（修正历史遗留文件）。
 * 同步版本在 Windows 文件被占用时会在当前线程里等待重试；主进程里响应界面操作（IPC）的写入用
 * writePrivateFileAtomicAsync，等待期间不挡事件循环（#154）。
 */
export function writePrivateFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  renameWithRetry(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  tightenWindowsAcl(file, 'file');
}

/** 每个目标文件的写入队列：同一路径的异步原子写按调用顺序串行，最后一次调用的内容最后落盘 */
const writeQueues = new Map<string, Promise<void>>();
let tmpSeq = 0;

/**
 * writePrivateFileAtomic 的异步版本：Windows 上目标被短暂占用时用定时器退避重试（同样约 2 秒的预算），
 * 等待期间主进程照常处理其他事件 / IPC。同一路径串行，各次写入用各自的临时文件，失败时清掉临时文件再抛出。
 */
export function writePrivateFileAtomicAsync(file: string, data: string): Promise<void> {
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => writeAtomicNow(file, data));
  const tail = run.catch(() => undefined);
  writeQueues.set(file, tail);
  void tail.then(() => {
    if (writeQueues.get(file) === tail) writeQueues.delete(file);
  });
  return run;
}

async function writeAtomicNow(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    const deadline = Date.now() + RENAME_RETRY_MS;
    for (let delay = 10; ; delay = Math.min(delay * 2, 100)) {
      try {
        await __renameDeps.renameAsync(tmp, file);
        break;
      } catch (error) {
        if (!isTransientRenameError(error) || Date.now() >= deadline) throw error;
        await __renameDeps.sleepAsync(delay);
      }
    }
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  tightenWindowsAcl(file, 'file');
}
