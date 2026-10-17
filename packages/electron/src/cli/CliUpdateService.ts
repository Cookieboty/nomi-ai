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

import { BrowserWindow, ipcMain } from 'electron';

import { t } from '../i18n';

import {
  CLI_MIN_NODE_MAJOR,
  NPM_PKG,
  dshRuntimeProblemAsync,
  fetchNpmLatest,
  guessInstallMethod,
  readPathNodeVersionAsync,
  readVersionAsync,
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
  if (bin && kind !== 'dsh' && (method === 'native' || method === 'unknown' || kind === 'grok')) {
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
      pkg === '@xai-official/grok@latest';
    if (!pkgOk) return false;
    if (rest.length === 3) return true;
    return rest.length === 5 && rest[3] === '--prefix' && rest[4] === userPrefix();
  }
  return false;
}

export function isUpdatable(kind: CliKind): kind is UpdatableCli {
  return kind === 'claude' || kind === 'codex' || kind === 'dsh' || kind === 'grok';
}

function toUpdatable(kind: unknown): UpdatableCli {
  return kind === 'codex' || kind === 'dsh' || kind === 'grok' ? kind : 'claude';
}

function toScope(v: unknown): CliInstallScope {
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
      output += '\n' + t('超时，已终止');
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

export class CliUpdateService {
  private cache: CliUpdateCache = { checkedAt: 0, latest: {} };
  private readonly cachePath: string;
  /** 每个端点最近一次任务（运行中 / 已结束，直到用户关闭） */
  private readonly jobs = new Map<UpdatableCli, CliJobSnapshot>();
  private readonly inflight = new Map<UpdatableCli, Promise<CliRunResult>>();
  /** 正在跑安装 / 更新的端点（同一时刻只允许一个，npm 全局操作并发会互相干扰） */
  private busyWith: UpdatableCli | null = null;
  private readonly probe: CliProbe;
  private readonly runner: CliRunner;

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      probe?: CliProbe;
      runner?: CliRunner;
      /** 测试：不向窗口广播 */
      silent?: boolean;
      /** 观察所有进度事件（测试 / 日志） */
      emit?: (payload: unknown) => void;
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

  async inspect(refreshLatest = false): Promise<CliInstallInfo[]> {
    const kinds: CliKind[] = ['claude', 'codex', 'dsh', 'grok', 'cursor'];
    try {
      if (refreshLatest || Date.now() - this.cache.checkedAt > 6 * 60 * 60_000) {
        const [cl, cx, ds, gk] = await Promise.all([
          fetchNpmLatest(NPM_PKG.claude),
          fetchNpmLatest(NPM_PKG.codex),
          fetchNpmLatest(NPM_PKG.dsh),
          fetchNpmLatest(NPM_PKG.grok),
        ]);
        this.cache = {
          checkedAt: Date.now(),
          latest: { claude: cl, codex: cx, dsh: ds, grok: gk, cursor: null },
        };
        try {
          this.save();
        } catch {
          /* cache 写失败不影响探测结果 */
        }
      }
      return Promise.all(
        kinds.map(async (kind) => {
          let bin: string | null = null;
          let version: string | null = null;
          try {
            const resolved = await resolveCliBinAsync(kind);
            bin = resolved;
            version = resolved ? await readVersionAsync(resolved) : null;
          } catch {
            /* 探测失败当作未安装 */
          }
          const latest = this.cache.latest[kind] ?? null;
          const method = kind === 'dsh' && bin ? 'npm' : guessInstallMethod(bin);
          const updateSupported = isUpdatable(kind);
          // 真实 dsh（非 .mjs Mock）才检查 Node 版本
          const runtimeWarning =
            kind === 'dsh' && bin && !/\.(mjs|js)$/.test(bin)
              ? await dshRuntimeProblemAsync()
              : null;
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
        }),
      );
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
      detail: nodeV ? `v${nodeV}` : t('未找到'),
    });
    if (!nodeOk)
      blockers.push(
        nodeV
          ? t('需要 Node.js ≥ {0}，当前是 v{1}。请先升级 Node.js 再安装。', need, nodeV)
          : t('找不到 Node.js（需要 ≥ {0}）。请先安装 Node.js。', need),
      );

    const npm = await this.probe.npmBin();
    requirements.push({
      id: 'npm',
      ok: Boolean(npm),
      label: 'npm',
      detail: npm ?? t('未找到'),
    });
    if (!npm) blockers.push(t('找不到 npm（随 Node.js 一起安装）。请先安装 Node.js。'));

    const target =
      scope === 'user' ? userPrefix() : (await this.probe.npmPrefix()) || (npm ? '' : userPrefix());
    if (npm && target) {
      const writable = await this.probe.canWrite(target);
      requirements.push({
        id: 'write',
        ok: writable,
        label: t('目录可写'),
        detail: target,
      });
      if (!writable) {
        if (scope === 'global') needsUserScope = true;
        blockers.push(
          scope === 'global'
            ? t(
                'npm 全局目录 {0} 没有写入权限。Nomi 不会自动使用 sudo / 管理员权限；可改为安装到用户目录，或自行在终端里用管理员权限安装。',
                target,
              )
            : t('用户目录 {0} 没有写入权限。', target),
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
    if (!isAllowedUpdateArgv(first.argv)) blockers.unshift(t('命令未通过白名单'));
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
    const j = this.jobs.get(kind);
    if (!j || j.status !== 'running') return;
    j.status = r.ok ? 'done' : 'error';
    j.result = r;
    j.finishedAt = Date.now();
  }

  /**
   * 安装 / 更新入口。任务状态由主进程按端点持有：同一端点重复调用复用当前任务；
   * 界面卸载、切换页面 / 端点都不影响运行，回来后用 `job()` 取回快照。
   */
  run(kind: UpdatableCli, scope: CliInstallScope = 'global'): Promise<CliRunResult> {
    const cur = this.inflight.get(kind);
    if (cur) return cur;
    // 另一个端点正在装 / 更新：直接拒绝，不留 running 占位任务（界面已禁用，这里是兜底）
    if (this.busyWith && this.busyWith !== kind) {
      return Promise.resolve({ ok: false, log: t('已有安装 / 更新在进行'), version: null });
    }
    this.busyWith = kind;
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
        this.busyWith = null;
      });
    this.inflight.set(kind, p);
    return p;
  }

  /** 当前是否有安装 / 更新在跑（界面据此禁用所有端点的操作按钮） */
  busyKind(): UpdatableCli | null {
    return this.busyWith;
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
          logs.push(t('拒绝：命令不在白名单'));
          continue;
        }
        const line = `$ ${commandLine(recipe.argv)}`;
        logs.push(line);
        this.broadcast({ kind, mode: plan.mode, phase: 'log', line });
        const res = await this.runner(
          recipe.argv,
          (l) => this.broadcast({ kind, mode: plan.mode, phase: 'log', line: l }),
          { timeoutMs: 10 * 60_000 },
        );
        if (res.output) logs.push(res.output);
        if (res.code === 0) {
          ok = true;
          break;
        }
        logs.push(t('命令失败（退出码 {0}）', res.code ?? '—'));
      }
      const log = logs.join('\n').slice(-8000);
      const bin = await resolveCliBinAsync(kind);
      const version = bin ? await readVersionAsync(bin) : null;
      if (!ok) {
        this.finishJob(kind, { ok: false, log, version });
        this.broadcast({ kind, mode: plan.mode, phase: 'error', message: log });
        return { ok: false, log, version };
      }
      let note: string | undefined;
      if (!bin) {
        note = t(
          '命令已执行完成，但在 PATH 和常见目录里没有找到 {0}；请检查 npm 的全局 bin 目录是否在 PATH 里。',
          kind,
        );
      } else if (scope === 'user') {
        const dir = path.dirname(bin);
        const inPath = (process.env.PATH ?? '').split(path.delimiter).includes(dir);
        if (!inPath)
          note = t(
            '已安装到 {0}；如需在终端直接使用，请把该目录加入 PATH（Nomi 内可直接使用）。',
            dir,
          );
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
    if (this.d.silent) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.webContents.send('ai:cli-update:event', payload);
      } catch {
        /* */
      }
    }
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (_e, ...a) => {
        try {
          return await fn(...a);
        } catch (err) {
          return { __error: { message: err instanceof Error ? err.message : String(err) } };
        }
      });
    };
    handle('ai:cli-update:inspect', (refresh) => this.inspect(refresh === true));
    handle('ai:cli-update:preview', (kind, scope) =>
      this.previewUpdate(toUpdatable(kind), toScope(scope)),
    );
    handle('ai:cli-update:job', (kind) => this.job(toUpdatable(kind)));
    handle('ai:cli-update:busy', () => this.busyKind());
    handle('ai:cli-update:dismiss', (kind) => this.dismissJob(toUpdatable(kind)));
    handle('ai:cli-update:run', (kind, scope) => this.run(toUpdatable(kind), toScope(scope)));
  }
}

let inst: CliUpdateService | null = null;
export function initCliUpdateService(d: {
  root: string;
  logger: Logger;
  probe?: CliProbe;
  runner?: CliRunner;
}): CliUpdateService {
  inst = new CliUpdateService(d);
  return inst;
}
export function getCliUpdateService(): CliUpdateService | null {
  return inst;
}
