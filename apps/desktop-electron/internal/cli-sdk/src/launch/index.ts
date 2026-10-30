/**
 * 启动注入的通用实现（docs/design/cli-plugin-architecture.md §5.3 AgentLaunch）：插件只声明，
 * 宿主统一执行——环境变量叠加与剔除、进程级文件（叠加配置、模型目录）、私有 HOME（共享条目软链回用户目录）、
 * 账号目录（同样是「私有目录 + 共享条目」，见 §5.10）。
 *
 * 账号目录的现有实现在 electron `cli/accounts/homes.ts`（按 CLI 的布局表）；这里的 ensureSharedHome 是同一套规则的
 * 通用版本，插件化（P9）时账号模块改用它。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AgentLaunch } from '../plugin';

/** 继承环境 → 子进程环境：先剔除 strip 列出的变量，再叠加插件给的 env */
export function applyLaunchEnv(
  base: NodeJS.ProcessEnv,
  launch: Pick<AgentLaunch, 'env' | 'strip'>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const k of launch.strip) delete out[k];
  return { ...out, ...launch.env };
}

/** 写进程级文件（目录 0700、文件默认 0600）；返回写下的路径，进程结束后由宿主回收 */
export function writeLaunchFiles(files: AgentLaunch['files'] = []): string[] {
  const written: string[] = [];
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f.path, f.content, { mode: f.mode ?? 0o600 });
    try {
      fs.chmodSync(f.path, f.mode ?? 0o600);
    } catch {
      /* Windows 上 mode 无效 */
    }
    written.push(f.path);
  }
  return written;
}

/**
 * 导出给 CLI 的目录路径：绝对、NFC、无结尾分隔符、父目录经过 realpath（不含软链成分）。
 * 有的 CLI 用路径字符串的哈希区分钥匙串条目，导出一个本身已经规范化的路径才稳定。
 */
export function canonicalDir(p: string): string {
  const abs = path
    .resolve(p)
    .normalize('NFC')
    .replace(/[\\/]+$/, '');
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur).normalize('NFC');
      return path.join(real, ...rest.reverse()).replace(/[\\/]+$/, '');
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export interface LinkProblem {
  entry: string;
  reason: string;
}

/** 建一条共享软链（Windows 目录用 junction）；已有同名真实文件 / 目录时保留不动。失败返回原因 */
export function linkShared(
  target: string,
  link: string,
  dir: boolean,
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) {
      if (fs.readlinkSync(link) === target) return null;
      fs.rmSync(link, { force: true });
    } else {
      return null;
    }
  } catch {
    /* 不存在：创建 */
  }
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, dir ? (platform === 'win32' ? 'junction' : 'dir') : 'file');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export interface SharedEntry {
  /** 相对目录的路径 */
  name: string;
  dir: boolean;
  /** 用户目录里还没有时先建空目录再链（会话目录等：保证从第一次起就写回用户目录） */
  createIfMissing?: boolean;
}

/**
 * 私有目录 + 按布局表共享的条目（账号目录的通用形态）：目录 0700，共享条目软链回 userDir。
 * 可重复调用（每次启动前补上用户后来新建的条目）。返回链不上的条目，不静默复制。
 */
export function ensureSharedHome(o: {
  dir: string;
  userDir: string;
  entries: SharedEntry[];
  platform?: NodeJS.Platform;
}): LinkProblem[] {
  fs.mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(o.dir, 0o700);
  } catch {
    /* */
  }
  const problems: LinkProblem[] = [];
  for (const e of o.entries) {
    const target = path.join(o.userDir, e.name);
    if (!fs.existsSync(target)) {
      if (!e.createIfMissing) continue;
      if (e.dir) fs.mkdirSync(target, { recursive: true });
    }
    const reason = linkShared(target, path.join(o.dir, e.name), e.dir, o.platform);
    if (reason) problems.push({ entry: e.name, reason });
  }
  return problems;
}

/**
 * 私有 HOME（§5.3 privateHome，Grok 的 GROK_HOME 就是这种）：用户目录里匹配 shared 的顶层条目软链进来，
 * 匹配 keepPrivate 的（凭据、锁文件、Nomi 自己写的配置）一律不链。正则用字符串，清单可序列化。
 */
export function ensurePrivateHome(o: {
  dir: string;
  userDir: string;
  shared: string;
  keepPrivate: string[];
  platform?: NodeJS.Platform;
}): LinkProblem[] {
  const shared = new RegExp(o.shared);
  const keep = o.keepPrivate.map((r) => new RegExp(r));
  let names: string[];
  try {
    names = fs.readdirSync(o.userDir);
  } catch {
    names = [];
  }
  const entries: SharedEntry[] = [];
  for (const name of names) {
    if (!shared.test(name) || keep.some((r) => r.test(name))) continue;
    let dir: boolean;
    try {
      dir = fs.statSync(path.join(o.userDir, name)).isDirectory();
    } catch {
      continue;
    }
    entries.push({ name, dir });
  }
  return ensureSharedHome({ dir: o.dir, userDir: o.userDir, entries, platform: o.platform });
}
