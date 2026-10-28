/**
 * 代码沙箱的平台隔离（CodeSandbox Python 路径）：
 * - macOS：sandbox-exec + 内置 Seatbelt profile（可写仅 tmp，默认可禁网）
 * - Linux：bwrap（只读系统目录、可写 tmp、默认 --unshare-net）
 * - Windows：本阶段无 FS jail；元数据 isolation:'none'，诚实回落（Job Object 留待后续）
 *
 * 纯参数构造可单测；探测二进制用 which，CI 可不装 bwrap/sandbox-exec。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type PlatformSandboxIsolation = 'sandbox-exec' | 'bwrap' | 'job' | 'none' | 'fallback';

export interface PlatformSandboxPlan {
  cmd: string;
  args: string[];
  isolation: PlatformSandboxIsolation;
  /** 未启用真实隔离时的原因（给日志 / 结果元数据） */
  reason?: string;
  platform: NodeJS.Platform;
}

export interface PlanPythonSandboxOpts {
  python: string;
  scriptPath: string;
  tmpDir: string;
  /** 默认禁网 */
  allowNetwork?: boolean;
  /** 测试注入 */
  platform?: NodeJS.Platform;
  bwrapPath?: string | null;
  sandboxExecPath?: string | null;
  /** 跳过 existsSync 探测（单测用） */
  existsSync?: (p: string) => boolean;
}

/** 在 PATH 里找可执行文件；找不到返回 null */
export function findOnPath(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [bin], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) return null;
    const line = String(r.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return line || null;
  } catch {
    return null;
  }
}

/**
 * Seatbelt（sandbox-exec）限制性 profile：
 * 允许读系统与脚本所在 tmp，写仅 tmp；默认同网络拒绝。
 */
export function buildSeatbeltProfile(o: {
  tmpDir: string;
  python: string;
  allowNetwork?: boolean;
}): string {
  const tmp = o.tmpDir;
  const py = o.python;
  const net = o.allowNetwork
    ? '(allow network*)'
    : '(deny network*)\n(deny network-outbound)\n(deny network-inbound)';
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec
  (literal "${escapeSb(py)}")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read*
  (subpath "/usr")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/private/var/db")
  (subpath "${escapeSb(tmp)}")
  (literal "${escapeSb(py)}")
)
(allow file-write*
  (subpath "${escapeSb(tmp)}")
)
(allow file-ioctl (subpath "${escapeSb(tmp)}"))
${net}
`;
}

function escapeSb(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 构造 bwrap argv（不含 bwrap 自身）：只读系统树 + 可写 tmp + 可选禁网 */
export function buildBwrapArgs(o: {
  python: string;
  scriptPath: string;
  tmpDir: string;
  allowNetwork?: boolean;
  pythonArgs?: string[];
  existsSync?: (p: string) => boolean;
}): string[] {
  const exists = o.existsSync ?? ((p: string) => fs.existsSync(p));
  const binds: string[] = [];
  for (const dir of [
    '/usr',
    '/lib',
    '/lib64',
    '/lib32',
    '/bin',
    '/sbin',
    '/etc',
    '/proc',
    '/dev',
  ]) {
    try {
      if (!exists(dir)) continue;
      if (dir === '/proc') binds.push('--proc', '/proc');
      else if (dir === '/dev') binds.push('--dev', '/dev');
      else binds.push('--ro-bind', dir, dir);
    } catch {
      /* ignore */
    }
  }
  try {
    const realPy = fs.realpathSync(o.python);
    const pyDir = path.dirname(realPy);
    if (pyDir.startsWith('/') && !pyDir.startsWith(o.tmpDir)) {
      if (!pyDir.startsWith('/usr') && !pyDir.startsWith('/bin') && !binds.includes(pyDir)) {
        binds.push('--ro-bind', pyDir, pyDir);
      }
    }
  } catch {
    /* ignore — 单测注入的假 python 路径 */
  }

  const args = [
    ...binds,
    '--bind',
    o.tmpDir,
    o.tmpDir,
    '--chdir',
    o.tmpDir,
    '--die-with-parent',
    '--unshare-pid',
  ];
  if (!o.allowNetwork) args.push('--unshare-net');
  args.push('--', o.python, ...(o.pythonArgs ?? ['-I']), o.scriptPath);
  return args;
}

/**
 * 为 Python 生成平台隔离启动计划。
 * 无可用二进制时 isolation='fallback'，cmd/args 退回裸 python -I。
 */
export function planPythonSandbox(o: PlanPythonSandboxOpts): PlatformSandboxPlan {
  const platform = o.platform ?? process.platform;
  const pythonArgs = ['-I', o.scriptPath];
  const exists = o.existsSync ?? ((p: string) => fs.existsSync(p));

  if (platform === 'darwin') {
    let sb: string | null;
    if (o.sandboxExecPath === null) sb = null;
    else if (o.sandboxExecPath) sb = o.sandboxExecPath;
    else if (exists('/usr/bin/sandbox-exec')) sb = '/usr/bin/sandbox-exec';
    else sb = findOnPath('sandbox-exec', platform);

    if (sb) {
      const profile = buildSeatbeltProfile({
        tmpDir: o.tmpDir,
        python: o.python,
        allowNetwork: o.allowNetwork,
      });
      return {
        cmd: sb,
        args: ['-p', profile, o.python, ...pythonArgs],
        isolation: 'sandbox-exec',
        platform,
      };
    }
    return {
      cmd: o.python,
      args: pythonArgs,
      isolation: 'fallback',
      reason: 'sandbox-exec unavailable',
      platform,
    };
  }

  if (platform === 'linux') {
    const bwrap = o.bwrapPath !== undefined ? o.bwrapPath : findOnPath('bwrap', platform);
    if (bwrap) {
      return {
        cmd: bwrap,
        args: buildBwrapArgs({
          python: o.python,
          scriptPath: o.scriptPath,
          tmpDir: o.tmpDir,
          allowNetwork: o.allowNetwork,
          existsSync: exists,
        }),
        isolation: 'bwrap',
        platform,
      };
    }
    return {
      cmd: o.python,
      args: pythonArgs,
      isolation: 'fallback',
      reason: 'bwrap not found on PATH',
      platform,
    };
  }

  // win32 及其他：无 FS jail；诚实标记（Job Object 未接）
  return {
    cmd: o.python,
    args: pythonArgs,
    isolation: 'none',
    reason: 'windows-no-fs-jail',
    platform,
  };
}

/** 当前进程上 Python 平台隔离是否可用（供 UI / 确认文案） */
export function pythonPlatformSandboxAvailable(platform: NodeJS.Platform = process.platform): {
  available: boolean;
  kind: PlatformSandboxIsolation;
  reason?: string;
} {
  if (platform === 'darwin') {
    const ok = fs.existsSync('/usr/bin/sandbox-exec');
    return ok
      ? { available: true, kind: 'sandbox-exec' }
      : { available: false, kind: 'fallback', reason: 'sandbox-exec unavailable' };
  }
  if (platform === 'linux') {
    const b = findOnPath('bwrap', platform);
    return b
      ? { available: true, kind: 'bwrap' }
      : { available: false, kind: 'fallback', reason: 'bwrap not found on PATH' };
  }
  return { available: false, kind: 'none', reason: 'windows-no-fs-jail' };
}
