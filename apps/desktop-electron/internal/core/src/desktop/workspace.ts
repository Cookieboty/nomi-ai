/**
 * Nomi 对话的工作区（纯逻辑 + 注入的 realpath，便于单测）。
 *
 * 工作区是视图随每轮请求带来的目录（ChatOptions.extra.cwd），内核不能直接信它：
 * 1. 必须是用户选过的目录（编程助手服务的 knownDir：标签目录 / 最近列表 / 默认目录），由调用方判断；
 * 2. 这里再拦掉过宽的根：文件系统根、主目录及其上级、主目录下的文稿 / 桌面 / 下载 / 资源库本身、
 *    系统目录、命中路径黑名单的目录（.ssh、钥匙串、浏览器配置、应用自己的数据目录…）。
 * 通过后工作区当作一个读写作用域交给 guardPath：相对路径按工作区解析，目标（realpath 后）必须在工作区里，
 * 黑名单照旧生效，符号链接跑到外面按 symlink_escape 拒绝。
 */
import * as nodePath from 'path';

import { denyReason, isInside, type Scope } from './pathGuard';

export interface WorkspaceEnv {
  home: string;
  platform: NodeJS.Platform;
  realpath: (p: string) => Promise<string>;
  denyRoots?: string[];
}

export type WorkspaceCheck = { ok: true; real: string } | { ok: false; reason: string };

/** 主目录下这些文件夹本身太宽（里面是用户的全部文档 / 下载），只能选它们里面的子文件夹 */
const HOME_CONTAINERS = ['Documents', 'Desktop', 'Downloads', 'Library', 'OneDrive', 'Pictures'];

const POSIX_SYSTEM = [
  '/System',
  '/Library',
  '/Applications',
  '/Users',
  '/home',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/opt',
  '/private',
  '/private/var',
  '/private/etc',
  '/tmp',
  '/private/tmp',
  '/Volumes',
  '/root',
];

const WIN_SYSTEM = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users'];

function lib(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function same(a: string, b: string, platform: NodeJS.Platform): boolean {
  return isInside(a, b, platform) && isInside(b, a, platform);
}

/** 工作区根是否过宽（real 为 realpath 之后的绝对路径） */
export function isBroadWorkspace(real: string, home: string, platform: NodeJS.Platform): boolean {
  const P = lib(platform);
  const abs = P.resolve(real);
  if (P.dirname(abs) === abs) return true; // 根目录 / 盘符根
  // 主目录本身及其上级（/Users、C:\Users …）
  if (home && isInside(home, abs, platform)) return true;
  if (home && HOME_CONTAINERS.some((c) => same(abs, P.join(home, c), platform))) return true;
  if (platform === 'win32') {
    const root = P.parse(abs).root;
    return WIN_SYSTEM.some((d) => same(abs, P.join(root, d), platform));
  }
  return POSIX_SYSTEM.some((d) => same(abs, d, platform));
}

/** 检查工作区根本身：存在、是目录（调用方已确认）、不过宽、不在黑名单里 */
export async function checkWorkspaceRoot(dir: string, env: WorkspaceEnv): Promise<WorkspaceCheck> {
  const P = lib(env.platform);
  if (!dir || !P.isAbsolute(dir)) return { ok: false, reason: 'not absolute' };
  let real: string;
  try {
    real = await env.realpath(dir);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  for (const p of [dir, real]) {
    const deny = denyReason(p, env.platform, env.denyRoots);
    if (deny) return { ok: false, reason: `denied: ${deny}` };
    if (isBroadWorkspace(p, env.home, env.platform)) return { ok: false, reason: 'too broad' };
  }
  return { ok: true, real };
}

/** 工作区当作 guardPath 的唯一作用域（读写、文件夹） */
export function workspaceScope(real: string): Scope {
  return { id: 'workspace', path: real, mode: 'read-write', kind: 'folder', grantedAt: 0 };
}

/** 相对路径按工作区解析（~ 与绝对路径原样交给 guardPath） */
export function resolveInWorkspace(
  input: unknown,
  root: string,
  platform: NodeJS.Platform,
): unknown {
  if (typeof input !== 'string') return input;
  const p = input.trim();
  if (!p || p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return input;
  const P = lib(platform);
  if (P.isAbsolute(p) || /^[\\/]{2}/.test(p)) return input;
  return P.resolve(root, p);
}
