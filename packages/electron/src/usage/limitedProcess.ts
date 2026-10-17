/**
 * 受限子进程：用来运行官方 CLI 的「只读状态」命令（claude -p /usage、claude auth status 等）。
 *
 * 约束：stdin 关闭；stderr 直接丢弃（不缓冲、不记录）；stdout 只收到上限为止（超出即终止）；
 * 超时终止；不经 shell（Windows 的 .cmd 垫片除外，参数逐个加引号）；调用方指定 cwd / env。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type ProcessFailureKind = 'not-installed' | 'failed' | 'timeout' | 'output-limit';

export class ProcessFailure extends Error {
  constructor(readonly kind: ProcessFailureKind) {
    super(kind);
    this.name = 'ProcessFailure';
  }
}

export interface RunResult {
  stdout: string;
  code: number | null;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** stdout 上限（字节） */
  maxBytes: number;
  platform?: NodeJS.Platform;
}

export const STDOUT_LIMIT = 256 * 1024;

/** 终止子进程：先 SIGTERM，宽限后 SIGKILL */
export function killTree(child: ChildProcess, graceMs = 800): void {
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已退出 */
  }
  const t = setTimeout(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }, graceMs);
  t.unref?.();
}

/** Windows 的 npm / pnpm .cmd 垫片需要经 cmd.exe；逐个参数加引号，空字符串参数（--tools ''）才不会丢 */
export function windowsShimLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } | null {
  if ([command, ...args].some((v) => /["%\r\n]/.test(v))) return null;
  const quoted = [command, ...args].map((v) => `"${v}"`).join(' ');
  return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${quoted}"`] };
}

export function runLimited(command: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const platform = o.platform ?? process.platform;
    const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    let file = command;
    let argv = args;
    if (shim) {
      const l = windowsShimLaunch(command, args, o.env);
      if (!l) return reject(new ProcessFailure('failed'));
      file = l.file;
      argv = l.args;
    }
    let child: ChildProcess;
    try {
      child = spawn(file, argv, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: shim,
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return reject(new ProcessFailure(code === 'ENOENT' ? 'not-installed' : 'failed'));
    }
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (err?: ProcessFailure, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        killTree(child);
        reject(err);
      } else resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code });
    };
    const timer = setTimeout(() => finish(new ProcessFailure('timeout')), o.timeoutMs);
    child.once('error', (e) =>
      finish(
        new ProcessFailure(
          (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-installed' : 'failed',
        ),
      ),
    );
    child.once('close', (code) => finish(undefined, code));
    child.stdout?.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > o.maxBytes) finish(new ProcessFailure('output-limit'));
      else chunks.push(c);
    });
  });
}
