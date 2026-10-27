import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

/**
 * 写入含敏感信息的配置文件并强制仅当前用户可读写。
 * - POSIX：0600（writeFileSync 的 mode 只在新建时生效，故对已存在文件再 chmod 一次）
 * - Windows：mode 位被忽略，用 icacls 去掉继承并只授予当前用户 (F)；能收紧所在目录时只收紧目录一次，
 *   之后目录里新建的文件靠继承就是私有的（见下方「Windows ACL 缓存」）
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

const ICACLS_TIMEOUT_MS = 15_000;

/** icacls 一次调用的结果（同步 / 异步两种实现统一成这个形状） */
interface AclRun {
  status: number | null;
  stderr?: string;
  error?: Error;
}

/** 异步 icacls：主进程里异步写入的路径不该被 icacls（Windows 上约 30–100ms）挡住事件循环 */
type SpawnAsync = (cmd: string, args: string[]) => Promise<AclRun>;

const defaultSpawnAsync: SpawnAsync = (cmd, args) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, encoding: 'utf8', timeout: ICACLS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        // 非零退出时 error.code 是退出码；启动失败 / 超时时是字符串或 null
        const code = (error as (Error & { code?: unknown }) | null)?.code;
        if (!error) resolve({ status: 0, stderr });
        else if (typeof code === 'number') resolve({ status: code, stderr });
        else resolve({ status: null, stderr, error });
      },
    );
  });

let spawnAsyncImpl: SpawnAsync = defaultSpawnAsync;

/** @internal 单测注入 */
export function __setSpawnAsyncForTest(fn: SpawnAsync | null): void {
  spawnAsyncImpl = fn ?? defaultSpawnAsync;
}

/** 参数一律走 argv 数组，不做 shell 拼接；拿不到用户名时返回 null */
function icaclsArgs(targetPath: string, kind: 'file' | 'dir'): string[] | null {
  const user = windowsAclUser();
  if (!user) {
    console.warn('[privateFile] win32 ACL: 无法确定当前用户，跳过', targetPath);
    return null;
  }
  const grant = kind === 'dir' ? `${user}:(OI)(CI)F` : `${user}:(F)`;
  return [targetPath, '/inheritance:r', '/grant:r', grant];
}

function aclOk(targetPath: string, r: AclRun): boolean {
  if (r.error || (typeof r.status === 'number' && r.status !== 0) || r.status === null) {
    console.warn(
      '[privateFile] icacls 收紧 ACL 失败',
      targetPath,
      r.status,
      r.stderr || r.error?.message,
    );
    return false;
  }
  return true;
}

/**
 * Windows：去掉继承 ACL，只保留当前用户完全控制。
 * - 文件：user:(F)
 * - 目录：user:(OI)(CI)F（对象/容器继承，令牌目录下新建文件也受限）
 * 返回是否成功（非 Windows 恒为 true）。显式调用总会真的跑一次 icacls，不走下面的缓存。
 */
export function tightenWindowsAcl(targetPath: string, kind: 'file' | 'dir' = 'file'): boolean {
  if (process.platform !== 'win32') return true;
  const args = icaclsArgs(targetPath, kind);
  if (!args) return false;
  try {
    const r = spawnSyncImpl('icacls', args, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: ICACLS_TIMEOUT_MS,
    });
    return aclOk(targetPath, { status: r.status, stderr: String(r.stderr ?? ''), error: r.error });
  } catch (e) {
    console.warn('[privateFile] icacls 收紧 ACL 异常', targetPath, e);
    return false;
  }
}

/** tightenWindowsAcl 的异步版本（同样的参数与安全效果，不阻塞主进程） */
export async function tightenWindowsAclAsync(
  targetPath: string,
  kind: 'file' | 'dir' = 'file',
): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const args = icaclsArgs(targetPath, kind);
  if (!args) return false;
  try {
    return aclOk(targetPath, await spawnAsyncImpl('icacls', args));
  } catch (e) {
    console.warn('[privateFile] icacls 收紧 ACL 异常', targetPath, e);
    return false;
  }
}

/*
 * ── Windows ACL 缓存 ──────────────────────────────────────────────────────────
 * 原来每次 writePrivateFile* 之后都同步 spawn 一次 icacls（Windows 上 30–100ms，超时 15 秒），
 * 用量游标、配置、隐私日志等频繁写入会反复卡主进程。现在：
 *
 * 1. 目录级收紧（首选）：文件所在目录在本进程里收紧过一次（/inheritance:r + user:(OI)(CI)F），
 *    目录里新建的文件会继承这条唯一的 ACE，于是就是私有的，不用再逐个 icacls。
 *    注意原子写是「新建临时文件 → rename 覆盖目标」：NTFS 上 rename 后的文件带的是临时文件自己的 ACL，
 *    不是旧目标的 ACL，所以必须保证临时文件「出生」时就是私有的——这正是目录继承提供的；
 *    因此目录检查放在写临时文件之前。
 * 2. 哪些目录可以自动收紧：只限应用 userData 之下的子目录（应用自己的数据目录）。userData 根本身
 *    不自动收紧——它下面还有 Chromium 的缓存 / Crashpad 等大量文件，收紧会把整棵树重新传播一遍；
 *    用户主目录、~/.claude、~/.codex 等共享目录更不能动。调用方用 ensurePrivateDir 显式收紧的目录
 *    也算私有目录。
 * 3. 逐文件兜底：目录不能（或没能）收紧时照旧对目标文件跑 icacls。普通覆盖写（writePrivateFile）
 *    打开的是同一个文件，ACL 不变，所以同一文件（按 ino + 创建时间识别）在本进程里收紧过一次后跳过；
 *    原子写每次都是新文件，兜底路径仍然每次收紧。
 * 4. 失效：缓存记录目录 / 文件的身份（ino + birthtime），被删除后重建身份会变，缓存随之失效、重新收紧；
 *    目录还不存在时不记失败，等它建好再试。
 */
const privateDirs = new Map<string, string>();
/** 自动收紧失败的目录：本进程不再反复尝试，直接走逐文件兜底 */
const fallbackDirs = new Set<string>();
/** 逐文件兜底下已收紧过的文件 → 身份 */
const privateFiles = new Map<string, string>();
/** 同一目录并发的异步收紧只跑一次 icacls */
const dirInflight = new Map<string, Promise<boolean>>();

/** undefined = 按 electron app 的 userData 推断；null = 不自动收紧任何目录 */
let autoRootOverride: string | null | undefined;
let autoRootCached: string | null | undefined;

/** @internal 单测注入：允许自动收紧的根目录（其子目录可自动收紧） */
export function __setPrivateRootForTest(root: string | null | undefined): void {
  autoRootOverride = root;
  autoRootCached = undefined;
}

/** @internal 单测：清空本进程的 ACL 缓存 */
export function __resetAclCacheForTest(): void {
  privateDirs.clear();
  fallbackDirs.clear();
  privateFiles.clear();
  dirInflight.clear();
  autoRootCached = undefined;
}

function autoRoot(): string | null {
  if (autoRootOverride !== undefined) return autoRootOverride;
  if (autoRootCached !== undefined) return autoRootCached;
  try {
    // 工具进程等没有 app 的环境里拿不到，视为不自动收紧
    autoRootCached = app?.getPath?.('userData') || null;
  } catch {
    autoRootCached = null;
  }
  return autoRootCached;
}

const keyOf = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

const idOf = (st: fs.Stats) => `${st.ino}:${st.birthtimeMs}`;

function identity(p: string): string | null {
  try {
    return idOf(fs.statSync(p));
  } catch {
    return null;
  }
}

async function identityAsync(p: string): Promise<string | null> {
  try {
    return idOf(await fsp.stat(p));
  } catch {
    return null;
  }
}

/** userData 的严格子目录才允许自动收紧（根本身与 userData 之外都不行） */
function canAutoTighten(dir: string): boolean {
  const root = autoRoot();
  if (!root) return false;
  return keyOf(dir).startsWith(keyOf(root) + path.sep);
}

/** 缓存命中且目录还是同一个；目录被重建时清掉旧记录 */
function cachedPrivateDir(k: string, id: string | null): boolean {
  const want = privateDirs.get(k);
  if (want === undefined) return false;
  if (want === id) return true;
  privateDirs.delete(k);
  return false;
}

/** 收紧目录并记入缓存；auto = 自动收紧（失败后记入兜底，不再重试） */
function tightenDirSync(dir: string, k: string, id: string, auto: boolean): boolean {
  if (tightenWindowsAcl(dir, 'dir')) {
    privateDirs.set(k, id);
    return true;
  }
  if (auto) fallbackDirs.add(k);
  return false;
}

/** Windows：目录是否（已经或现在）是私有目录——里面新建的文件继承私有 ACL */
function dirIsPrivate(dir: string): boolean {
  const k = keyOf(dir);
  const id = identity(dir);
  if (id === null) return false;
  if (cachedPrivateDir(k, id)) return true;
  if (fallbackDirs.has(k) || !canAutoTighten(dir)) return false;
  return tightenDirSync(dir, k, id, true);
}

async function dirIsPrivateAsync(dir: string): Promise<boolean> {
  const k = keyOf(dir);
  const id = await identityAsync(dir);
  if (id === null) return false;
  if (cachedPrivateDir(k, id)) return true;
  if (fallbackDirs.has(k) || !canAutoTighten(dir)) return false;
  const running = dirInflight.get(k);
  if (running) return running;
  const job = tightenWindowsAclAsync(dir, 'dir').then((ok) => {
    if (ok) privateDirs.set(k, id);
    else fallbackDirs.add(k);
    return ok;
  });
  dirInflight.set(k, job);
  try {
    return await job;
  } finally {
    dirInflight.delete(k);
  }
}

/**
 * 自己创建文件（不经 writePrivateFile*）的调用方用：确保目录是私有目录（userData 子目录会自动收紧，
 * 本进程同一目录只收紧一次），返回「目录里接下来新建的文件是否靠继承就是私有的」。
 * - 非 Windows：恒为 true（权限靠新建时的 0600 mode，与 ACL 无关）
 * - Windows：false 时调用方必须对自己新建的文件逐个收紧（tightenWindowsAclAsync）
 * 注意：只对「新建」的文件成立；打开已存在的文件沿用它自己的旧 ACL，调用方应先删掉同名残留。
 */
export async function ensureInheritedPrivateDirAsync(dir: string): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  return dirIsPrivateAsync(dir);
}

/**
 * 普通覆盖写之后的 Windows 收紧。dirPrivate = 写之前目录已是私有；before = 写之前文件的身份（不存在为 null）。
 * - 新建文件 + 私有目录：继承来的 ACE 已经私有，跳过
 * - 本进程收紧过的同一文件：覆盖写不改 ACL，跳过
 * - 其余（含私有目录里的历史遗留文件，首次修正一次）：逐文件收紧并记下身份
 */
function secureOverwrittenFile(file: string, dirPrivate: boolean, before: string | null): void {
  if (before === null && dirPrivate) {
    rememberPrivateFile(file, identity(file));
    return;
  }
  if (before !== null && privateFiles.get(keyOf(file)) === before) return;
  if (tightenWindowsAcl(file, 'file')) rememberPrivateFile(file, identity(file));
}

/** 记下「本进程确认是私有的」文件身份，之后对同一文件的覆盖写跳过 icacls */
function rememberPrivateFile(file: string, id: string | null): void {
  if (id) privateFiles.set(keyOf(file), id);
}

/** 确保目录存在且仅当前用户可访问（POSIX 0700；Windows 再收紧 ACL，本进程同一目录只收紧一次） */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* Windows 等平台忽略 */
  }
  if (process.platform !== 'win32') return;
  const k = keyOf(dir);
  const id = identity(dir);
  if (id !== null && cachedPrivateDir(k, id)) return;
  if (id === null) tightenWindowsAcl(dir, 'dir');
  else if (tightenDirSync(dir, k, id, false)) fallbackDirs.delete(k);
}

export function writePrivateFile(file: string, data: string): void {
  const win = process.platform === 'win32';
  // 目录检查放在写之前：目录此刻收紧的话，接下来新建的文件直接继承私有 ACL
  const dirPrivate = win && dirIsPrivate(path.dirname(file));
  const before = win ? identity(file) : null;
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  if (win) secureOverwrittenFile(file, dirPrivate, before);
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
 * 同步版本只能用 Atomics.wait 原地等待（会挡住当前线程），但只在真的遇到瞬时占用时才等：
 * 退避从 10ms 起、单次最多 100ms，正常写入一次 rename 成功、完全不等。总预算保留 2 秒——杀软扫描
 * 常见占用就是几百毫秒，再缩短会把可恢复的占用变成保存失败；不想等的调用方用异步版本（定时器退避）。
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
 * 原子写：先写 0600 的 .tmp，再 rename；目录不是私有目录时最后逐文件收紧目标权限。
 * 同步版本在 Windows 文件被占用时会在当前线程里等待重试；主进程里响应界面操作（IPC）的写入用
 * writePrivateFileAtomicAsync，等待期间不挡事件循环（#154）。
 */
export function writePrivateFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const win = process.platform === 'win32';
  // 先确定目录是否私有，再建临时文件：rename 后目标带的是临时文件的 ACL
  const dirPrivate = win && dirIsPrivate(path.dirname(file));
  if (dirPrivate) {
    // 崩溃残留的同名 .tmp 会沿用它自己的旧 ACL；删掉后重建，保证继承目录的私有 ACE
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 删不掉时下面的写入会给出真正的错误 */
    }
  }
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  // 逐文件兜底在 rename 之前收紧临时文件：显式 ACE 随文件一起 rename，目标出现时就已私有；
  // 失败时 rename 后再对目标补一次
  const tmpPrivate = win && !dirPrivate && tightenWindowsAcl(tmp, 'file');
  renameWithRetry(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 等平台忽略 */
  }
  if (!win) return;
  // 私有目录：rename 过来的新文件继承了私有 ACE，记下身份；否则逐文件兜底（原子写每次都是新文件）
  if (dirPrivate || tmpPrivate || tightenWindowsAcl(file, 'file'))
    rememberPrivateFile(file, identity(file));
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

/** 等当前排队 / 进行中的异步原子写全部结束（不管成败）；单测与需要落盘确认的调用方用 */
export async function whenPrivateWritesIdle(): Promise<void> {
  while (writeQueues.size) await Promise.all(writeQueues.values());
}

async function writeAtomicNow(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  const win = process.platform === 'win32';
  const dirPrivate = win && (await dirIsPrivateAsync(path.dirname(file)));
  let tmpPrivate: boolean;
  try {
    await fsp.writeFile(tmp, data, { mode: 0o600 });
    // 同步版本的说明：兜底时先收紧临时文件，rename 后目标即私有，没有非私有的窗口期
    tmpPrivate = win && !dirPrivate && (await tightenWindowsAclAsync(tmp, 'file'));
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
  if (!win) return;
  if (dirPrivate || tmpPrivate || (await tightenWindowsAclAsync(file, 'file'))) {
    rememberPrivateFile(file, await identityAsync(file));
  }
}
