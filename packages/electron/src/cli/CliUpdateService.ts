/**
 * CLI 版本检测、安装与白名单更新（Claude Code / Codex / dsh / Grok 都可在应用内安装 / 更新；Cursor 仅检测）。
 *
 * - 安装 / 更新只会执行固定 argv 的白名单命令（`npm install -g <包>@latest [--prefix ~/.local]`、
 *   `claude|codex update`），永不经 shell 拼接；Windows 的 npm.cmd 例外地经 shell 执行，参数同样来自白名单。
 * - 执行前先出「计划」：确切命令 + 前置检查（Node 版本 / npm / 写权限）。不满足就给出原因，不执行。
 * - 全局目录没有写权限时**不会**偷偷用 sudo：提示用户改装到用户目录（`--prefix ~/.local`，不需要管理员权限）
 *   或自行在终端处理。
 * - 输出按行通过 `ai:cli-update:event` 推给界面（进度 / 日志 / 错误）。
 * - dsh 没有自更新命令，只走 npm 全局安装；Grok 支持 `grok update` 与 npm。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { AppEvents } from '../core/appEvents';
import { t } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';

import {
  CLI_MIN_NODE_MAJOR,
  NPM_PKG,
  dshRuntimeProblemAsync,
  fetchNpmLatest,
  guessInstallMethod,
  npmPrefixBinDir,
  readPathNodeVersionAsync,
  readVersionAsync,
  rememberCliDir,
  resolveCliBinAsync,
  resolveNpmBinAsync,
  withCliPath,
} from './detect';
import { isNewer } from './semver';
import type {
  CliInstallInfo,
  CliInstallPlan,
  CliInstallScope,
  CliJobSnapshot,
  CliKind,
  CliRequirement,
  CliRunResult,
  UpdatableCli,
} from './types';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export interface CliUpdateCache {
  checkedAt: number;
  latest: Partial<Record<CliKind, string | null>>;
}

/** 允许执行的命令模板（argv 固定，禁止任意 shell） */
export type UpdateRecipe =
  | { kind: 'claude' | 'codex' | 'grok'; via: 'self'; argv: string[] }
  | { kind: UpdatableCli; via: 'npm'; argv: string[] };

const isWin = () => process.platform === 'win32';

/** 用户目录安装前缀：bin 落在 ~/.local/bin（Windows 为 ~/.local），resolveCliBin 会去那里找 */
export function userPrefix(): string {
  return path.join(os.homedir(), '.local');
}

function npmCommand(): string {
  const env = process.env.NOMI_NPM_BIN?.trim();
  if (env) return env;
  return isWin() ? 'npm.cmd' : 'npm';
}

export function updateRecipes(
  kind: UpdatableCli,
  bin: string | null,
  method: 'npm' | 'native' | 'unknown',
  scope: CliInstallScope = 'global',
): UpdateRecipe[] {
  const recipes: UpdateRecipe[] = [];
  // dsh / Gemini 没有自更新子命令，只走 npm
  if (
    bin &&
    kind !== 'dsh' &&
    kind !== 'gemini' &&
    (method === 'native' || method === 'unknown' || kind === 'grok')
  ) {
    recipes.push({ kind: kind as 'claude' | 'codex' | 'grok', via: 'self', argv: [bin, 'update'] });
  }
  recipes.push({
    kind,
    via: 'npm',
    argv: [
      npmCommand(),
      'install',
      '-g',
      `${NPM_PKG[kind]}@latest`,
      ...(scope === 'user' ? ['--prefix', userPrefix()] : []),
    ],
  });
  return recipes;
}

export function isAllowedUpdateArgv(argv: string[]): boolean {
  if (!argv.length) return false;
  const [cmd, ...rest] = argv;
  const base = path
    .basename(cmd)
    .replace(/\.cmd$/i, '')
    .toLowerCase();
  // claude update / codex update
  if (
    (base === 'claude' ||
      base === 'codex' ||
      base === 'grok' ||
      cmd.endsWith('claude') ||
      cmd.endsWith('codex') ||
      cmd.endsWith('grok')) &&
    rest.length === 1 &&
    rest[0] === 'update'
  ) {
    return true;
  }
  // npm install -g @scope/pkg@latest [--prefix <用户目录>]
  const envNpm = process.env.NOMI_NPM_BIN?.trim();
  if ((base === 'npm' || (envNpm && cmd === envNpm)) && rest[0] === 'install' && rest[1] === '-g') {
    const pkg = rest[2] ?? '';
    const pkgOk =
      pkg === '@anthropic-ai/claude-code@latest' ||
      pkg === '@openai/codex@latest' ||
      pkg === '@deepseek-ai/dsh@latest' ||
      pkg === '@xai-official/grok@latest' ||
      pkg === '@google/gemini-cli@latest';
    if (!pkgOk) return false;
    if (rest.length === 3) return true;
    return rest.length === 5 && rest[3] === '--prefix' && rest[4] === userPrefix();
  }
  return false;
}

export function isUpdatable(kind: CliKind): kind is UpdatableCli {
  return (
    kind === 'claude' || kind === 'codex' || kind === 'dsh' || kind === 'grok' || kind === 'gemini'
  );
}

/** 渲染层传来的 id → 可更新的 CLI；认不出时按 claude（旧 IPC 与契约处理函数共用） */
export function toUpdatable(kind: unknown): UpdatableCli {
  return kind === 'codex' || kind === 'dsh' || kind === 'grok' || kind === 'gemini'
    ? kind
    : 'claude';
}

export function toScope(v: unknown): CliInstallScope {
  return v === 'user' ? 'user' : 'global';
}

function quoteArg(a: string): string {
  return /^[A-Za-z0-9_@./:\\=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`;
}
export const commandLine = (argv: string[]): string => argv.map(quoteArg).join(' ');

/** 环境探测（可注入，便于用 Mock 测试） */
type MaybeAsync<T> = T | Promise<T>;
export interface CliProbe {
  nodeVersion(): MaybeAsync<string | null>;
  npmBin(): MaybeAsync<string | null>;
  /** `npm config get prefix` */
  npmPrefix(): MaybeAsync<string | null>;
  canWrite(dir: string): MaybeAsync<boolean>;
}

export const defaultProbe: CliProbe = {
  nodeVersion: () => readPathNodeVersionAsync(),
  npmBin: () => resolveNpmBinAsync(),
  // 异步执行：不阻塞主进程（Windows 上 npm.cmd 经 shell 启动较慢）
  npmPrefix: async () => {
    const npm = await resolveNpmBinAsync();
    if (!npm) return null;
    try {
      const { stdout } = await promisify(execFile)(npm, ['config', 'get', 'prefix'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        env: withCliPath(),
        shell: isWin(),
      });
      const out = String(stdout).trim().split(/\r?\n/).pop();
      return out || null;
    } catch {
      return null;
    }
  },
  canWrite: (dir) => {
    // 目录不存在时看最近的已存在父目录（npm 会 mkdir -p）
    let d = dir;
    for (let i = 0; i < 8 && !fs.existsSync(d); i++) d = path.dirname(d);
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export type CliRunner = (
  argv: string[],
  onLine: (line: string) => void,
  opts: { timeoutMs: number },
) => Promise<{ code: number | null; output: string }>;

export const defaultRunner: CliRunner = (argv, onLine, { timeoutMs }) =>
  new Promise((resolve) => {
    const useShell = isWin() && /\.(cmd|bat)$/i.test(argv[0]!);
    const child = useShell
      ? spawn(commandLine(argv), { shell: true, windowsHide: true, env: withCliPath() })
      : spawn(argv[0]!, argv.slice(1), { windowsHide: true, env: withCliPath() });
    let output = '';
    let pending = '';
    const feed = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-64 * 1024);
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l);
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    const timer = setTimeout(() => {
      output += '\n' + t('electron.common.timed-out-and-stopped');
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${e.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim()) onLine(pending);
      resolve({ code, output: output.trim() });
    });
  });

const INSPECT_KINDS: readonly CliKind[] = ['claude', 'codex', 'dsh', 'grok', 'gemini', 'cursor'];
/** 本机探测结果的有效期：设置页来回切换不再反复起进程；终端里自己升级的版本最晚这么久后显示 */
const PROBE_TTL_MS = 5 * 60_000;
const LATEST_TTL_MS = 6 * 60 * 60_000;

interface LocalProbe {
  kind: CliKind;
  bin: string | null;
  version: string | null;
  runtimeWarning: CliInstallInfo['runtimeWarning'];
}

export class CliUpdateService {
  private cache: CliUpdateCache = { checkedAt: 0, latest: {} };
  private probed: { at: number; rows: Promise<LocalProbe[]> } | null = null;
  private latestRefresh: Promise<void> | null = null;
  private readonly cachePath: string;
  /** 每个端点最近一次任务（运行中 / 已结束，直到用户关闭） */
  private readonly jobs = new Map<UpdatableCli, CliJobSnapshot>();
  private readonly inflight = new Map<UpdatableCli, Promise<CliRunResult>>();
  /**
   * 按安装位置排队的 npm 命令：同一个前缀上并发 `npm install -g` 会互相覆盖链接与 node_modules，
   * 所以只把这一步串起来；不同端点的任务本身可以同时进行（自带 update、前置检查、探测都不排队）。
   */
  private readonly npmQueue = new Map<CliInstallScope, Promise<void>>();
  private readonly probe: CliProbe;
  private readonly runner: CliRunner;

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      probe?: CliProbe;
      runner?: CliRunner;
      /** 进度通知界面（ai:cli-update:event） */
      events: AppEvents;
      /** 观察所有进度事件（测试 / 日志） */
      emit?: (payload: unknown) => void;
      /** 平台（测试注入） */
      platform?: NodeJS.Platform;
      /**
       * Windows 上升级前排空（P9.6）：运行中的程序文件不能被替换。拆掉这个 CLI 空闲的进程、
       * 等进行中的轮次结束，返回仍在进行的轮次数（> 0 时不升级）。
       */
      drain?: (kind: UpdatableCli) => Promise<number>;
      /** 安装 / 更新成功：编排层在空闲时用新版本重启会话并续接 */
      onUpdated?: (kind: UpdatableCli, version: string | null) => void;
    },
  ) {
    this.probe = d.probe ?? defaultProbe;
    this.runner = d.runner ?? defaultRunner;
    this.cachePath = path.join(d.root, 'cache.json');
    fs.mkdirSync(d.root, { recursive: true });
    this.load();
  }

  private load() {
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as CliUpdateCache;
    } catch {
      this.cache = { checkedAt: 0, latest: {} };
    }
  }

  private save() {
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  /** 「最新版本」查询（npm registry）；并发调用共用一次 */
  private refreshLatest(): Promise<void> {
    this.latestRefresh ??= (async () => {
      const [cl, cx, ds, gk, gm] = await Promise.all([
        fetchNpmLatest(NPM_PKG.claude),
        fetchNpmLatest(NPM_PKG.codex),
        fetchNpmLatest(NPM_PKG.dsh),
        fetchNpmLatest(NPM_PKG.grok),
        fetchNpmLatest(NPM_PKG.gemini),
      ]);
      // 网络失败（null）时保留上次查到的值，不要把已知的最新版本冲掉
      const old = this.cache.latest;
      this.cache = {
        checkedAt: Date.now(),
        latest: {
          claude: cl ?? old.claude ?? null,
          codex: cx ?? old.codex ?? null,
          dsh: ds ?? old.dsh ?? null,
          grok: gk ?? old.grok ?? null,
          gemini: gm ?? old.gemini ?? null,
          cursor: null,
        },
      };
      try {
        this.save();
      } catch {
        /* cache 写失败不影响探测结果 */
      }
    })()
      .catch((err) => this.d.logger.warn('cli-update latest check failed', err))
      .finally(() => {
        this.latestRefresh = null;
      });
    return this.latestRefresh;
  }

  /** 本机探测：可执行文件路径 + `--version`（每个 CLI 起一个进程，较慢） */
  private probeLocal(): Promise<LocalProbe[]> {
    return Promise.all(
      INSPECT_KINDS.map(async (kind) => {
        let bin: string | null = null;
        let version: string | null = null;
        try {
          const resolved = await resolveCliBinAsync(kind);
          bin = resolved;
          version = resolved ? await readVersionAsync(resolved) : null;
        } catch {
          /* 探测失败当作未安装 */
        }
        // 真实 dsh（非 .mjs Mock）才检查 Node 版本
        const runtimeWarning =
          kind === 'dsh' && bin && !/\.(mjs|js)$/.test(bin) ? await dshRuntimeProblemAsync() : null;
        return { kind, bin, version, runtimeWarning };
      }),
    );
  }

  /**
   * 已装版本 + 最新版本。
   * - 本机探测结果缓存 PROBE_TTL_MS，并发调用共用一次；安装 / 更新结束或显式「检查更新」时重新探测。
   * - 最新版本缓存 6 小时：过期时先返回旧值、后台刷新（不让打开页面卡在网络请求上）；
   *   缓存里缺某个端点（例如新加入的 Gemini）或显式「检查更新」时才等待查询。
   */
  async inspect(refreshLatest = false): Promise<CliInstallInfo[]> {
    const kinds = INSPECT_KINDS;
    try {
      const missing = (['claude', 'codex', 'dsh', 'grok', 'gemini'] as const).some(
        (k) => !(k in this.cache.latest),
      );
      let latestTask: Promise<void> | null = null;
      if (refreshLatest || missing) latestTask = this.refreshLatest();
      else if (Date.now() - this.cache.checkedAt > LATEST_TTL_MS) void this.refreshLatest();
      let probed = this.probed;
      if (refreshLatest || !probed || Date.now() - probed.at > PROBE_TTL_MS) {
        const entry = { at: Date.now(), rows: this.probeLocal() };
        probed = this.probed = entry;
        entry.rows.catch(() => {
          if (this.probed === entry) this.probed = null;
        });
      }
      const [local] = await Promise.all([probed.rows, latestTask]);
      return local.map(({ kind, bin, version, runtimeWarning }) => {
        const latest = this.cache.latest[kind] ?? null;
        const method = kind === 'dsh' && bin ? 'npm' : guessInstallMethod(bin);
        const updateSupported = isUpdatable(kind);
        return {
          kind,
          runtimeWarning,
          path: bin,
          version,
          latest,
          installMethod: method,
          updateAvailable: Boolean(
            updateSupported && version && latest && isNewer(latest, version),
          ),
          updateSupported,
          installSupported: updateSupported,
        };
      });
    } catch (err) {
      this.d.logger.warn('cli-update inspect failed', err);
      return kinds.map((kind) => ({
        kind,
        path: null,
        version: null,
        latest: null,
        installMethod: 'unknown' as const,
        updateAvailable: false,
        updateSupported: isUpdatable(kind),
        installSupported: isUpdatable(kind),
      }));
    }
  }

  /** 前置检查：Node 版本 / npm / 目标目录写权限（只在会执行 npm 时检查） */
  private async checkRequirements(
    kind: UpdatableCli,
    scope: CliInstallScope,
  ): Promise<{ requirements: CliRequirement[]; blockers: string[]; needsUserScope: boolean }> {
    const requirements: CliRequirement[] = [];
    const blockers: string[] = [];
    let needsUserScope = false;

    const need = CLI_MIN_NODE_MAJOR[kind];
    const nodeV = await this.probe.nodeVersion();
    const major = nodeV ? Number(nodeV.split('.')[0]) : NaN;
    const nodeOk = Number.isFinite(major) && major >= need;
    requirements.push({
      id: 'node',
      ok: nodeOk,
      label: t('Node.js ≥ {0}', need),
      detail: nodeV ? `v${nodeV}` : t('electron.common.not-found'),
    });
    if (!nodeOk)
      blockers.push(
        nodeV
          ? t('electron.common.node-js-is-required-found-v-please-upgrade', need, nodeV)
          : t('electron.common.node-js-was-not-found-please-install-node', need),
      );

    const npm = await this.probe.npmBin();
    requirements.push({
      id: 'npm',
      ok: Boolean(npm),
      label: 'npm',
      detail: npm ?? t('electron.common.not-found'),
    });
    if (!npm) blockers.push(t('electron.common.npm-was-not-found-it-ships-with-node'));

    const target =
      scope === 'user' ? userPrefix() : (await this.probe.npmPrefix()) || (npm ? '' : userPrefix());
    if (npm && target) {
      const writable = await this.probe.canWrite(target);
      requirements.push({
        id: 'write',
        ok: writable,
        label: t('electron.common.directory-writable'),
        detail: target,
      });
      if (!writable) {
        if (scope === 'global') needsUserScope = true;
        blockers.push(
          scope === 'global'
            ? t('electron.common.the-npm-global-directory-is-not-writable-nomi', target)
            : t('electron.common.the-user-directory-is-not-writable', target),
        );
      }
    }
    return { requirements, blockers, needsUserScope };
  }

  /** 生成安装 / 更新计划（不执行） */
  async plan(
    kind: UpdatableCli,
    scope: CliInstallScope = 'global',
  ): Promise<{ plan: CliInstallPlan; recipes: UpdateRecipe[] }> {
    const bin = await resolveCliBinAsync(kind);
    const mode: 'install' | 'update' = bin ? 'update' : 'install';
    const method = kind === 'dsh' && bin ? 'npm' : guessInstallMethod(bin);
    // 用户目录方案只对 npm 有意义；已有 native 安装的 claude/codex 先走自带 update
    const recipes = updateRecipes(kind, bin, method, scope);
    const first = recipes[0]!;
    const usesNpm = first.via === 'npm';
    const checks = usesNpm
      ? await this.checkRequirements(kind, scope)
      : { requirements: [], blockers: [], needsUserScope: false };
    const blockers = [...checks.blockers];
    if (!isAllowedUpdateArgv(first.argv))
      blockers.unshift(t('electron.common.the-command-is-not-on-the-allow-list'));
    const plan: CliInstallPlan = {
      kind,
      mode,
      scope,
      argv: first.argv,
      command: commandLine(first.argv),
      requirements: checks.requirements,
      blockers,
    };
    if (checks.needsUserScope) {
      plan.userScopeCommand = commandLine(updateRecipes(kind, bin, 'npm', 'user')[0]!.argv);
    }
    return { plan, recipes };
  }

  /** 预览将执行的命令（不跑） */
  async previewUpdate(
    kind: UpdatableCli,
    scope: CliInstallScope = 'global',
  ): Promise<CliInstallPlan> {
    return (await this.plan(kind, scope)).plan;
  }

  /** 当前（或最近一次）任务快照；界面挂载时先取它，再订阅增量 */
  job(kind: UpdatableCli): CliJobSnapshot | null {
    const j = this.jobs.get(kind);
    return j ? { ...j, lines: [...j.lines] } : null;
  }

  /** 关闭已结束任务的结果（运行中的不能关） */
  dismissJob(kind: UpdatableCli): boolean {
    const j = this.jobs.get(kind);
    if (!j || j.status === 'running') return false;
    this.jobs.delete(kind);
    return true;
  }

  private finishJob(kind: UpdatableCli, r: CliRunResult): void {
    // 装 / 更新过：下次 inspect 重新探测本机版本
    this.probed = null;
    const j = this.jobs.get(kind);
    if (!j || j.status !== 'running') return;
    j.status = r.ok ? 'done' : 'error';
    j.result = r;
    j.finishedAt = Date.now();
    if (r.ok) {
      try {
        this.d.onUpdated?.(kind, r.version);
      } catch (e) {
        this.d.logger.warn('cli onUpdated hook failed', { kind, error: String(e) });
      }
    }
  }

  /**
   * 安装 / 更新入口。任务状态由主进程按端点持有：同一端点重复调用复用当前任务；
   * 界面卸载、切换页面 / 端点都不影响运行，回来后用 `job()` 取回快照。
   */
  run(kind: UpdatableCli, scope: CliInstallScope = 'global'): Promise<CliRunResult> {
    const cur = this.inflight.get(kind);
    if (cur) return cur;
    this.jobs.set(kind, {
      kind,
      mode: 'update',
      scope,
      status: 'running',
      argv: [],
      command: '',
      lines: [],
      startedAt: Date.now(),
    });
    const p = this.runJob(kind, scope)
      .then((r) => {
        this.finishJob(kind, r);
        return r;
      })
      .finally(() => {
        this.inflight.delete(kind);
      });
    this.inflight.set(kind, p);
    return p;
  }

  /** 正在安装 / 更新的端点（可以同时有多个） */
  busyKinds(): UpdatableCli[] {
    return [...this.inflight.keys()];
  }

  /** 在同一安装位置的 npm 队列里执行 `fn`；前面还有任务时先调 `onWait` */
  private async inNpmQueue<T>(
    scope: CliInstallScope,
    onWait: () => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.npmQueue.get(scope);
    let release: () => void = () => undefined;
    const mine = new Promise<void>((r) => (release = r));
    const tail = (prev ?? Promise.resolve()).then(() => mine);
    this.npmQueue.set(scope, tail);
    if (prev) {
      onWait();
      await prev;
    }
    try {
      return await fn();
    } finally {
      release();
      if (this.npmQueue.get(scope) === tail) this.npmQueue.delete(scope);
    }
  }

  private async runJob(kind: UpdatableCli, scope: CliInstallScope): Promise<CliRunResult> {
    // 先占位再做（异步的）前置检查，避免两次点击同时通过
    let planned: Awaited<ReturnType<CliUpdateService['plan']>>;
    try {
      planned = await this.plan(kind, scope);
    } catch (e) {
      return { ok: false, log: e instanceof Error ? e.message : String(e), version: null };
    }
    const { plan, recipes } = planned;
    if (plan.blockers.length) {
      return { ok: false, log: plan.blockers.join('\n'), version: null };
    }
    if ((this.d.platform ?? process.platform) === 'win32' && this.d.drain) {
      const busy = await this.d.drain(kind).catch(() => 0);
      if (busy > 0)
        return {
          ok: false,
          log: t('electron.common.session-s-are-still-using-this-cli-windows', busy),
          version: null,
        };
    }
    {
      const j = this.jobs.get(kind);
      if (j) {
        j.mode = plan.mode;
        j.argv = plan.argv;
        j.command = plan.command;
      }
    }
    this.broadcast({ kind, mode: plan.mode, phase: 'start', argv: plan.argv });
    const logs: string[] = [];
    try {
      let ok = false;
      for (const recipe of recipes) {
        // 自带 update 失败时回退到 npm（此时才检查 npm 前置条件）
        if (recipe.via === 'npm' && recipe !== recipes[0]) {
          const again = await this.checkRequirements(kind, scope);
          if (again.blockers.length) {
            logs.push(...again.blockers);
            break;
          }
        }
        if (!isAllowedUpdateArgv(recipe.argv)) {
          logs.push(t('electron.common.rejected-command-not-on-whitelist'));
          continue;
        }
        const line = `$ ${commandLine(recipe.argv)}`;
        logs.push(line);
        this.broadcast({ kind, mode: plan.mode, phase: 'log', line });
        const exec = () =>
          this.runner(
            recipe.argv,
            (l) => this.broadcast({ kind, mode: plan.mode, phase: 'log', line: l }),
            { timeoutMs: 10 * 60_000 },
          );
        const res =
          recipe.via === 'npm'
            ? await this.inNpmQueue(
                scope,
                () =>
                  this.broadcast({
                    kind,
                    mode: plan.mode,
                    phase: 'log',
                    line: t('electron.common.waiting-for-another-npm-install-to-finish'),
                  }),
                exec,
              )
            : await exec();
        if (res.output) logs.push(res.output);
        if (res.code === 0) {
          ok = true;
          break;
        }
        logs.push(t('electron.common.command-failed-exit-code', res.code ?? '—'));
      }
      const log = logs.join('\n').slice(-8000);
      let bin = await resolveCliBinAsync(kind);
      // npm 装到了不在 PATH / 常见目录里的前缀（nvm、自定义 prefix 等，#76）：去 npm 实际的全局 bin 找，
      // 找到就记住这个目录，之后探测与启动都能用
      let npmBinDir: string | null = null;
      if (!bin && ok) {
        const prefix = scope === 'user' ? userPrefix() : await this.probe.npmPrefix();
        if (prefix) {
          npmBinDir = npmPrefixBinDir(prefix);
          rememberCliDir(npmBinDir);
          bin = await resolveCliBinAsync(kind);
        }
      }
      const version = bin ? await readVersionAsync(bin) : null;
      if (!ok) {
        this.finishJob(kind, { ok: false, log, version });
        this.broadcast({ kind, mode: plan.mode, phase: 'error', message: log });
        return { ok: false, log, version };
      }
      let note: string | undefined;
      if (!bin) {
        note = npmBinDir
          ? t('electron.common.the-command-finished-but-wasn-t-found-in', kind, npmBinDir)
          : t('electron.common.the-command-finished-but-was-not-found-on', kind);
      } else if (scope === 'user') {
        const dir = path.dirname(bin);
        const inPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir);
        if (!inPath) note = t('electron.common.installed-to-to-use-it-from-a-terminal', dir);
      }
      const result: CliRunResult = { ok: Boolean(bin), log, version, path: bin, note };
      this.finishJob(kind, result);
      this.broadcast({ kind, mode: plan.mode, phase: 'done', version });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.finishJob(kind, { ok: false, log: msg, version: null });
      this.broadcast({ kind, mode: plan.mode, phase: 'error', message: msg });
      return { ok: false, log: msg, version: null };
    }
  }

  /** 兼容旧名 */
  runUpdate(kind: UpdatableCli, scope: CliInstallScope = 'global'): Promise<CliRunResult> {
    return this.run(kind, scope);
  }

  private broadcast(payload: unknown) {
    const ev = payload as { kind?: UpdatableCli; phase?: string; line?: string };
    const job = ev.kind ? this.jobs.get(ev.kind) : undefined;
    if (job && job.status === 'running' && ev.phase === 'log' && typeof ev.line === 'string') {
      job.lines.push(ev.line);
      if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
    }
    this.d.emit?.(payload);
    this.d.events.publish('ai:cli-update:event', payload);
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'CliUpdateService' });
    handle('ai:cli-update:inspect', (refresh) => this.inspect(refresh === true));
    handle('ai:cli-update:preview', (kind, scope) =>
      this.previewUpdate(toUpdatable(kind), toScope(scope)),
    );
    handle('ai:cli-update:job', (kind) => this.job(toUpdatable(kind)));
    handle('ai:cli-update:busy', () => this.busyKinds());
    handle('ai:cli-update:dismiss', (kind) => this.dismissJob(toUpdatable(kind)));
    handle('ai:cli-update:run', (kind, scope) => this.run(toUpdatable(kind), toScope(scope)));
  }
}

let inst: CliUpdateService | null = null;
export function initCliUpdateService(d: {
  root: string;
  logger: Logger;
  events: AppEvents;
  probe?: CliProbe;
  runner?: CliRunner;
  drain?: (kind: UpdatableCli) => Promise<number>;
  onUpdated?: (kind: UpdatableCli, version: string | null) => void;
}): CliUpdateService {
  inst = new CliUpdateService(d);
  return inst;
}
export function getCliUpdateService(): CliUpdateService | null {
  return inst;
}
