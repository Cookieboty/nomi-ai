/**
 * 探测本机 Claude Code / Codex / Cursor 可执行文件与版本。
 * 可通过环境变量覆盖路径（测试 / Mock）：
 *   NOMI_CLAUDE_BIN · NOMI_CODEX_BIN · NOMI_DSH_BIN · NOMI_GROK_BIN · NOMI_CURSOR_BIN
 */
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { CliKind, UpdatableCli } from './types';

const ENV_BIN: Record<CliKind, string> = {
  claude: 'NOMI_CLAUDE_BIN',
  codex: 'NOMI_CODEX_BIN',
  dsh: 'NOMI_DSH_BIN',
  grok: 'NOMI_GROK_BIN',
  cursor: 'NOMI_CURSOR_BIN',
};

const CANDIDATES: Record<CliKind, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  dsh: ['dsh'],
  grok: ['grok'],
  cursor: ['cursor-agent', 'agent'],
};

/**
 * 从 Dock / 开始菜单启动的应用拿到的 PATH 往往很短（macOS 没有 /opt/homebrew/bin、/usr/local/bin），
 * 探测与安装 CLI 时补上常见的 Node / npm / CLI 目录（只补不删，保持用户 PATH 的优先级）。
 */
export function cliSearchDirs(
  home = os.homedir(),
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    // GUI-launched Electron often has a short PATH; prefer USERPROFILE + APPDATA from the
    // env we will actually spawn with (not a stale process.env snapshot).
    const winHome = env.USERPROFILE?.trim() || home;
    const appData = env.APPDATA?.trim() || path.join(winHome, 'AppData', 'Roaming');
    return [
      path.join(winHome, '.grok', 'bin'),
      path.join(appData, 'npm'),
      path.join(winHome, '.local'),
    ];
  }
  return [
    path.join(home, '.grok', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

export function withCliPath(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const key = Object.keys(base).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const cur = (base[key] ?? '').split(path.delimiter).filter(Boolean);
  const home = base.USERPROFILE?.trim() || base.HOME?.trim() || os.homedir();
  const extra = cliSearchDirs(home, process.platform, base).filter(
    (d) => !cur.includes(d) && fs.existsSync(d),
  );
  return { ...base, [key]: [...cur, ...extra].join(path.delimiter) };
}

/**
 * Windows 的 npm 全局包会同时放下无扩展名的 shell 脚本和 `.cmd` 垫片。
 * `where` 先返回无扩展名路径，Node 的 spawn 对它报 ENOENT。
 * 旁边有 `.exe` / `.cmd` / `.bat` 时改用那个。
 */
export function windowsExecutable(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  if (platform !== 'win32') return bin;
  if (/\.(?:exe|cmd|bat|com)$/i.test(bin)) return bin;
  for (const ext of ['.exe', '.cmd', '.bat']) {
    const next = `${bin}${ext}`;
    if (exists(next)) return next;
  }
  return bin;
}

/** npm 可执行文件（NOMI_NPM_BIN 可覆盖，供测试 / 特殊安装）；找不到返回 null */
export function resolveNpmBin(): string | null {
  const env = process.env.NOMI_NPM_BIN?.trim();
  if (env && fs.existsSync(env)) return env;
  return which(process.platform === 'win32' ? 'npm.cmd' : 'npm') ?? which('npm');
}

function which(cmd: string): string | null {
  try {
    const lines = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      env: withCliPath(),
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      const found = windowsExecutable(line);
      if (fs.existsSync(found)) return found;
    }
    return null;
  } catch {
    return null;
  }
}

let nodeBinCache: { bin: string | null; at: number } | null = null;

/** PATH 上的 node 可执行文件（绝对路径）。Windows 解开 .cmd 后用它 spawn，避免再靠短 PATH。 */
export function resolveNodeBin(): string | null {
  if (
    nodeBinCache &&
    Date.now() - nodeBinCache.at < 30_000 &&
    (nodeBinCache.bin === null || fs.existsSync(nodeBinCache.bin))
  ) {
    return nodeBinCache.bin;
  }
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  const bin = which(name) ?? (name === 'node.exe' ? which('node') : null);
  nodeBinCache = { bin, at: Date.now() };
  return bin;
}

// ---------------------------------------------------------------------------
// 探测结果缓存：resolveCliBin 每个候选名都会同步 spawn `which` / `where`。
// 切换会话 / 标签、每次标签状态变化（changed → state()）都会走到这里，
// 实测 Linux 上 4 个后端累计 ~30ms 阻塞主进程（Windows 的 where 更慢），所有窗口一起停顿。
// 命中且文件仍在就直接返回；「未找到」只缓存很短时间，保证刚装好的 CLI 能很快被发现。
// ---------------------------------------------------------------------------

const MISSING_TTL_MS = 10_000;
const binCache = new Map<CliKind, { bin: string | null; at: number }>();

function cacheBin(kind: CliKind, bin: string | null): string | null {
  binCache.set(kind, { bin, at: Date.now() });
  return bin;
}

/** 缓存里的探测结果；未缓存 / 已过期 / 文件已不存在返回 undefined（调用方自行决定是否重新探测） */
export function peekCliBin(kind: CliKind): string | null | undefined {
  // 环境变量覆盖（测试 / Mock / 特殊安装）始终优先且改了立即生效，不经缓存
  const env = pickedBin(process.env[ENV_BIN[kind]]);
  if (env) return env;
  const hit = binCache.get(kind);
  if (!hit) return undefined;
  if (hit.bin) {
    if (fs.existsSync(hit.bin)) return hit.bin;
    binCache.delete(kind);
    return undefined;
  }
  if (Date.now() - hit.at > MISSING_TTL_MS) {
    binCache.delete(kind);
    return undefined;
  }
  return null;
}

/** 同步版：先看缓存，未命中才真正探测（spawn 前取可执行文件用） */
export function resolveCliBinCached(kind: CliKind): string | null {
  const hit = peekCliBin(kind);
  return hit !== undefined ? hit : cacheBin(kind, resolveCliBin(kind));
}

const inflight = new Map<CliKind, Promise<string | null>>();

/** 异步探测并写入缓存（同一后端的并发请求合并） */
export function refreshCliBin(kind: CliKind): Promise<string | null> {
  const pending = inflight.get(kind);
  if (pending) return pending;
  const p = resolveCliBinAsync(kind).finally(() => inflight.delete(kind));
  inflight.set(kind, p);
  return p;
}

/** 测试用：清空探测缓存 */
export function resetCliBinCache(): void {
  binCache.clear();
  inflight.clear();
  nodeBinCache = null;
}

/** 环境变量里的路径若指向 npm 的无扩展名脚本，改成旁边可 spawn 的垫片 */
function pickedBin(raw: string | undefined): string | null {
  const env = raw?.trim();
  if (!env) return null;
  const chosen = windowsExecutable(env);
  return fs.existsSync(chosen) ? chosen : null;
}

export function resolveCliBin(kind: CliKind): string | null {
  const env = pickedBin(process.env[ENV_BIN[kind]]);
  if (env) return env;
  for (const c of CANDIDATES[kind]) {
    const p = which(c);
    if (p) return p;
  }
  // 常见用户级 npm 前缀
  const names =
    process.platform === 'win32'
      ? CANDIDATES[kind].flatMap((c) => [`${c}.cmd`, `${c}.exe`, c])
      : CANDIDATES[kind];
  for (const dir of cliSearchDirs()) {
    for (const c of names) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function readVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      // Windows 上 npm 装出来的是 .cmd 垫片，必须经 shell 才能执行
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
      env: { ...withCliPath(), NO_COLOR: '1' },
    });
    // 保留预发布段（dsh 当前发布 0.2.0-rc.x）
    const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out);
    return m ? m[1]! : out.trim().slice(0, 64) || null;
  } catch {
    return null;
  }
}

export function guessInstallMethod(bin: string | null): 'npm' | 'native' | 'unknown' {
  if (!bin) return 'unknown';
  const n = bin.replace(/\\/g, '/').toLowerCase();
  if (n.includes('node_modules') || n.includes('npm-global')) return 'npm';
  if (n.includes('/.local/share/claude') || n.includes('/versions/')) return 'native';
  return 'unknown';
}

/** 异步拉 npm latest（失败返回 null） */
export function fetchNpmLatest(pkg: string, timeoutMs = 12_000): Promise<string | null> {
  return new Promise((resolve) => {
    const npm = resolveNpmBin() ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    execFile(
      npm,
      ['view', pkg, 'version', '--json'],
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        env: withCliPath(),
        shell: process.platform === 'win32',
      },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const v = JSON.parse(String(stdout).trim()) as unknown;
          resolve(typeof v === 'string' ? v : null);
        } catch {
          const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
          resolve(m ? m[1] : null);
        }
      },
    );
  });
}

export const NPM_PKG: Record<UpdatableCli, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  dsh: '@deepseek-ai/dsh',
  grok: '@xai-official/grok',
};

/** 各 CLI 运行所需的最低 Node 主版本（claude-code engines ≥ 22；codex ≥ 16；dsh 需要 24） */
export const CLI_MIN_NODE_MAJOR: Record<UpdatableCli, number> = {
  claude: 22,
  codex: 16,
  dsh: 24,
  grok: 18,
};

/** dsh 依赖 Node ≥ 24（import.meta.main）；更低版本下静默无输出 */
export const DSH_MIN_NODE_MAJOR = 24;

/** PATH 上 node 的版本（dsh 的 shebang 为 `/usr/bin/env node`） */
export function readPathNodeVersion(): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'node.exe' : 'node', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env: withCliPath(),
    });
    const m = /v?(\d+\.\d+\.\d+)/.exec(out);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * dsh 运行时检查：返回 null 表示正常；否则返回检测到的 node 版本（或 'missing'）。
 */
export function dshRuntimeProblem(
  nodeVersion: string | null = readPathNodeVersion(),
): { nodeVersion: string | null; required: number } | null {
  const major = nodeVersion ? Number(nodeVersion.split('.')[0]) : NaN;
  if (Number.isFinite(major) && major >= DSH_MIN_NODE_MAJOR) return null;
  return { nodeVersion, required: DSH_MIN_NODE_MAJOR };
}

// ---------------------------------------------------------------------------
// 异步探测：IPC（检查 / 预览）里使用，避免同步 execFileSync 卡住主进程
// （Windows 上 where / npm.cmd 经 shell 启动较慢，会让整个应用的输入停顿）
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

async function whichAsync(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      env: withCliPath(),
    });
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const line of lines) {
      const found = windowsExecutable(line);
      if (fs.existsSync(found)) return found;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveNpmBinAsync(): Promise<string | null> {
  const env = process.env.NOMI_NPM_BIN?.trim();
  if (env && fs.existsSync(env)) return env;
  return (
    (await whichAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm')) ??
    (await whichAsync('npm'))
  );
}

export async function resolveCliBinAsync(kind: CliKind): Promise<string | null> {
  return cacheBin(kind, await probeCliBinAsync(kind));
}

async function probeCliBinAsync(kind: CliKind): Promise<string | null> {
  const env = pickedBin(process.env[ENV_BIN[kind]]);
  if (env) return env;
  for (const c of CANDIDATES[kind]) {
    const p = await whichAsync(c);
    if (p) return p;
  }
  const names =
    process.platform === 'win32'
      ? CANDIDATES[kind].flatMap((c) => [`${c}.cmd`, `${c}.exe`, c])
      : CANDIDATES[kind];
  for (const dir of cliSearchDirs()) {
    for (const c of names) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export async function readVersionAsync(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin),
      env: { ...withCliPath(), NO_COLOR: '1' },
    });
    const out = String(stdout);
    const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(out);
    return m ? m[1]! : out.trim().slice(0, 64) || null;
  } catch {
    return null;
  }
}

export async function readPathNodeVersionAsync(): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      process.platform === 'win32' ? 'node.exe' : 'node',
      ['--version'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, env: withCliPath() },
    );
    const m = /v?(\d+\.\d+\.\d+)/.exec(String(stdout));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export async function dshRuntimeProblemAsync(): Promise<{
  nodeVersion: string | null;
  required: number;
} | null> {
  return dshRuntimeProblem(await readPathNodeVersionAsync());
}
