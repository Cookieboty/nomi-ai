/**
 * 受限子进程：用来运行官方 CLI 的「只读状态」命令（claude -p /usage、claude auth status 等）。
 *
 * 约束：stdin 关闭；stderr 直接丢弃（不缓冲、不记录）；stdout 只收到上限为止（超出即终止）；
 * 超时终止；不经 shell（Windows 的 .cmd 垫片除外，参数逐个加引号）；调用方指定 cwd / env。
 *
 * 需要走 stdin ACP（Grok agent stdio / billing）时，优先把 Windows `.cmd` 解成
 * `node.exe + script.js` 再 spawn，避免 `cmd.exe /c` 打断管道。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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

export type CliLaunchVia = 'direct' | 'node-script' | 'cmd-shim';

export interface CliLaunch {
  file: string;
  args: string[];
  /** How the launch was resolved — callers that need verbatim cmd quoting check for `cmd-shim`. */
  via: CliLaunchVia;
}

export interface UnwrapCmdDeps {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
}

/**
 * Parse an npm / pnpm Windows `.cmd` shim into `{ node, script }`.
 * ACP / stdio protocols need a real node process: nesting through `cmd.exe /c`
 * often breaks stdin piping on Windows (Grok auth + billing).
 */
export function unwrapWindowsCmdShim(
  command: string,
  deps: UnwrapCmdDeps = {},
): { node: string; script: string } | null {
  if (!/\.(cmd|bat)$/i.test(command)) return null;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  let text: string;
  try {
    text = readFile(command);
  } catch {
    return null;
  }
  const dir = path.dirname(command);
  const dp0 = dir.endsWith('\\') || dir.endsWith('/') ? dir : dir + path.sep;
  const expand = (raw: string): string =>
    path.normalize(
      raw
        .replace(/%~dp0%?/gi, dp0)
        .replace(/%dp0%?/gi, dp0)
        .replace(/[\\/]/g, path.sep),
    );
  // Prefer the last quoted *.js / *.mjs / *.cjs path (npm shim puts the entry last).
  const quoted = [...text.matchAll(/"([^"\r\n]+)"/g)].map((m) => m[1]!).filter(Boolean);
  const scriptRaw = [...quoted].reverse().find((q) => /\.(?:m?js|cjs)$/i.test(q));
  if (!scriptRaw) return null;
  const script = expand(scriptRaw);
  if (/["%\r\n]/.test(script) || !exists(script)) return null;
  const localNode = path.join(dir, 'node.exe');
  const nodeFromShim = quoted
    .map(expand)
    .find((q) => /(?:^|[\\/])node(?:\.exe)?$/i.test(q) && exists(q));
  const node = exists(localNode) ? localNode : (nodeFromShim ?? 'node.exe');
  if (/["%\r\n]/.test(node)) return null;
  return { node, script };
}

/**
 * Resolve how to spawn a CLI on the current platform.
 * On Windows, prefer unwrapping `.cmd` to `node.exe + script.js` so stdin ACP works;
 * fall back to the quoted `cmd.exe /c` shim launch used by one-shot commands.
 */
export function resolveCliLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  deps: UnwrapCmdDeps = {},
): CliLaunch | null {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { file: command, args, via: 'direct' };
  }
  const unwrapped = unwrapWindowsCmdShim(command, deps);
  if (unwrapped) {
    return { file: unwrapped.node, args: [unwrapped.script, ...args], via: 'node-script' };
  }
  const shim = windowsShimLaunch(command, args, env);
  if (!shim) return null;
  return { file: shim.file, args: shim.args, via: 'cmd-shim' };
}

export function runLimited(command: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const platform = o.platform ?? process.platform;
    const launch = resolveCliLaunch(command, args, o.env, platform);
    if (!launch) return reject(new ProcessFailure('failed'));
    const file = launch.file;
    const argv = launch.args;
    const verbatim = launch.via === 'cmd-shim';
    let child: ChildProcess;
    try {
      child = spawn(file, argv, {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
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
