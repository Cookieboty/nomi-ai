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

import { waitForShellPath } from './shellPath';
import type { CliKind, UpdatableCli } from './types';

const ENV_BIN: Record<CliKind, string> = {
  claude: 'NOMI_CLAUDE_BIN',
  codex: 'NOMI_CODEX_BIN',
  dsh: 'NOMI_DSH_BIN',
  grok: 'NOMI_GROK_BIN',
  gemini: 'NOMI_GEMINI_BIN',
  cursor: 'NOMI_CURSOR_BIN',
};

const CANDIDATES: Record<CliKind, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  dsh: ['dsh'],
  grok: ['grok'],
  gemini: ['gemini'],
  cursor: ['cursor-agent', 'agent'],
};

/**
 * `NOMI_USE_MOCK_CLI=1` 时与 CliHarnessService 一致：把 mock-*.mjs 当作已安装，
 * 这样「模型」/「编程助手」页不会在 e2e / 开发环境下把 Mock CLI 显示成「未安装」。
 * cursor 没有 mock，返回 null。
 */
export function mockCliBin(kind: CliKind): string | null {
  if (process.env.NOMI_USE_MOCK_CLI !== '1' || kind === 'cursor') return null;
  const candidates = [
    path.resolve(__dirname, '../../scripts/mock-cli'),
    path.resolve(__dirname, '../scripts/mock-cli'),
    path.resolve(process.cwd(), 'packages/electron/scripts/mock-cli'),
    path.resolve(process.cwd(), 'scripts/mock-cli'),
  ];
  for (const dir of candidates) {
    const file = path.join(dir, `mock-${kind}.mjs`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 运行中发现的额外目录（npm 实际的全局 bin 等），优先于下面的兜底目录 */
const rememberedDirs: string[] = [];

/** 记住一个 CLI 所在目录（如 `npm config get prefix` 的 bin），之后的探测 / 子进程 PATH 都带上 */
export function rememberCliDir(dir: string | null | undefined): void {
  const d = dir?.trim();
  if (!d || rememberedDirs.includes(d)) return;
  rememberedDirs.unshift(d);
  forgetMissingCliBins();
}

/** 之前「没找到」的探测结果作废（PATH / 搜索目录变了，新目录里可能就有） */
export function forgetMissingCliBins(): void {
  for (const [kind, hit] of binCache) if (!hit.bin) binCache.delete(kind);
  nodeBinCache = null;
}

/** npm 全局前缀对应的 bin 目录（Windows 的全局 bin 就是前缀本身） */
export function npmPrefixBinDir(prefix: string, platform = process.platform): string {
  return platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

/** ~/.nvm/versions/node 下按版本从新到旧排的 bin 目录 */
function nvmBinDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.NVM_BIN?.trim()) out.push(env.NVM_BIN.trim());
  const root = path.join(env.NVM_DIR?.trim() || path.join(home, '.nvm'), 'versions', 'node');
  try {
    const versions = fs
      .readdirSync(root)
      .filter((v) => /^v?\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => {
        const pa = a.replace(/^v/, '').split('.').map(Number);
        const pb = b.replace(/^v/, '').split('.').map(Number);
        for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pb[i] ?? 0) - (pa[i] ?? 0);
        return 0;
      });
    for (const v of versions) out.push(path.join(root, v, 'bin'));
  } catch {
    /* 没装 nvm */
  }
  return out;
}

/**
 * 从 Dock / 开始菜单启动的应用拿到的 PATH 往往很短（macOS 没有 /opt/homebrew/bin、/usr/local/bin），
 * 探测与安装 CLI 时补上常见的 Node / npm / CLI 目录（只补不删，保持用户 PATH 的优先级）。
 * 启动时还会读一次登录 shell 的 PATH（shellPath.ts）；读不到时靠这里的兜底目录（#76）。
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
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(winHome, 'AppData', 'Local');
    return unique([
      ...rememberedDirs,
      ...(env.NPM_CONFIG_PREFIX?.trim() ? [env.NPM_CONFIG_PREFIX.trim()] : []),
      path.join(winHome, '.grok', 'bin'),
      path.join(appData, 'npm'),
      path.join(winHome, '.local'),
      ...(env.PNPM_HOME?.trim() ? [env.PNPM_HOME.trim()] : []),
      path.join(localAppData, 'pnpm'),
      path.join(env.VOLTA_HOME?.trim() || path.join(localAppData, 'Volta'), 'bin'),
      path.join(winHome, '.bun', 'bin'),
    ]);
  }
  return unique([
    ...rememberedDirs,
    ...(env.NPM_CONFIG_PREFIX?.trim() ? [path.join(env.NPM_CONFIG_PREFIX.trim(), 'bin')] : []),
    path.join(home, '.grok', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'npm-global', 'bin'),
    path.join(home, '.npm-packages', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // Node 版本管理器 / 其它包管理器
    ...nvmBinDirs(home, env),
    path.join(env.VOLTA_HOME?.trim() || path.join(home, '.volta'), 'bin'),
    ...(env.PNPM_HOME?.trim() ? [env.PNPM_HOME.trim()] : []),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.claude', 'local'),
  ]);
}

function unique(dirs: string[]): string[] {
  return [...new Set(dirs)];
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

/**
 * Windows 的 PATHEXT 常是大写（.CMD），而磁盘上的垫片是 dsh.cmd；文件系统大小写不敏感，
 * `exists` 两者都命中，直接拼出的路径会带上 PATHEXT 的大小写。像 `where` 一样返回磁盘上的真实
 * 文件名，使结果与 FS 大小写策略（含 macOS 默认的大小写不敏感卷）无关；读目录失败则原样返回。
 */
function onDiskCase(file: string): string {
  try {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const names = fs.readdirSync(dir);
    if (names.includes(base)) return file;
    const lower = base.toLowerCase();
    const real = names.find((n) => n.toLowerCase() === lower);
    return real ? path.join(dir, real) : file;
  } catch {
    return file;
  }
}

/**
 * 在 PATH 目录里找可执行文件（Windows 按 PATHEXT 补扩展名），纯 fs 扫描、不 spawn。
 *
 * 设计取舍（Windows CI / #windows-where）：
 * - 旧实现同步 spawn `where`/`which`，在 windows-latest 上偶发卡满 3s 超时；
 *   超时后 cliSearchDirs 又不扫 PATH，导致临时 PATH 垫片（及部分真实安装）探测为 null。
 * - 产品意图本就是「PATH 上有就能探测到」，用目录扫描比依赖 where 更稳、也更快，
 *   避免主进程被 where 拖住。App Paths 等注册表入口极少用于 npm CLI，此处不覆盖。
 */
export function findOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = fs.existsSync,
): string | null {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const dirs = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  if (!dirs.length) return null;

  const names: string[] = [];
  if (platform === 'win32') {
    // 已带扩展名则只找精确名；否则按 PATHEXT 顺序试（与 cmd.exe 解析一致）
    if (/\.[a-z0-9]+$/i.test(cmd)) {
      names.push(cmd);
    } else {
      const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
      for (const raw of pathext) {
        const ext = raw.trim();
        if (!ext) continue;
        names.push(`${cmd}${ext.startsWith('.') ? ext : `.${ext}`}`);
      }
      names.push(cmd); // 无扩展名脚本（再经 windowsExecutable 升到 .cmd）
    }
  } else {
    names.push(cmd);
  }

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!exists(candidate)) continue;
      const found = windowsExecutable(candidate, platform, exists);
      if (exists(found)) return platform === 'win32' ? onDiskCase(found) : found;
    }
  }
  return null;
}

function which(cmd: string): string | null {
  return findOnPath(cmd, withCliPath());
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
// 探测结果缓存：resolveCliBin 会扫 PATH + 兜底目录（findOnPath，不再 spawn where）。
// 切换会话 / 标签、每次标签状态变化（changed → state()）都会走到这里；
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
  const mock = mockCliBin(kind);
  if (mock) return mock;
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
  rememberedDirs.length = 0;
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
  const mock = mockCliBin(kind);
  if (mock) return mock;
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
  // Node 版本管理器 / pnpm / bun 的 bin 都是 npm 包的软链接（#76：nvm 的 /versions/ 曾被认成原生安装）
  if (
    /\/\.nvm\/versions\/node\/|\/\.volta\/|\/fnm|\/\.asdf\/|\/mise\/|\/pnpm\/|\/\.bun\/|\/\.npm-packages\//.test(
      n,
    )
  )
    return 'npm';
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
  gemini: '@google/gemini-cli',
};

/** 各 CLI 运行所需的最低 Node 主版本（claude-code engines ≥ 22；codex ≥ 16；dsh 需要 24） */
export const CLI_MIN_NODE_MAJOR: Record<UpdatableCli, number> = {
  claude: 22,
  codex: 16,
  dsh: 24,
  grok: 18,
  // @google/gemini-cli 0.62.0 package.json engines：node >= 20
  gemini: 20,
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
  // 与同步 which 相同：扫 PATH，避免 where 超时拖住 IPC
  return findOnPath(cmd, withCliPath());
}

export async function resolveNpmBinAsync(): Promise<string | null> {
  await waitForShellPath();
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
  await waitForShellPath();
  const env = pickedBin(process.env[ENV_BIN[kind]]);
  if (env) return env;
  const mock = mockCliBin(kind);
  if (mock) return mock;
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
