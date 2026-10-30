/**
 * CLI 安装 / 更新：计划（确切命令 + 前置检查）、白名单、Mock npm 执行、错误透出。
 * 用注入的 probe / runner 代替真实 npm；会真正生成 / 读取 Mock CLI 的只在 POSIX 上跑。
 */
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CliUpdateService,
  isAllowedUpdateArgv,
  userPrefix,
  type CliProbe,
  type CliRunner,
} from '../../../src/cli/CliUpdateService';
import { resetCliBinCache } from '../../../src/cli/detect';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

const posix = process.platform === 'win32' ? it.skip : it;

let tmp = '';
const saved = { ...process.env };
let events: Array<Record<string, unknown>> = [];
let appEvents = createRecordingAppEvents();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-install-'));
  // jest 的 process.env 是副本，改 HOME 不会影响 os.homedir()，所以直接 spy
  jest.spyOn(os, 'homedir').mockReturnValue(tmp);
  // 让 `which` 找不到任何真实的 claude / codex / dsh
  process.env.PATH = path.join(tmp, 'empty');
  // Windows 探测会从这些用户级目录补 PATH；指向临时目录，避免被开发机上的
  // npm / pnpm 全局 CLI 污染“未安装”场景。
  process.env.USERPROFILE = tmp;
  process.env.APPDATA = path.join(tmp, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(tmp, 'AppData', 'Local');
  delete process.env.NOMI_CLAUDE_BIN;
  delete process.env.NOMI_CODEX_BIN;
  delete process.env.NOMI_DSH_BIN;
  delete process.env.NOMI_NPM_BIN;
  // 兜底目录还会查 nvm / volta / pnpm 等（#76）：别命中开发机上真实安装的 CLI
  for (const k of ['NVM_BIN', 'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'NPM_CONFIG_PREFIX'])
    delete process.env[k];
  events = [];
  appEvents = createRecordingAppEvents();
  resetCliBinCache();
});
afterEach(() => {
  jest.restoreAllMocks();
  // 不能整体替换 process.env（会脱离真实环境变量，os.homedir() 不再跟随）
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const probe = (over: Partial<CliProbe> = {}): CliProbe => ({
  nodeVersion: () => '24.1.0',
  nodeBin: () => '/usr/bin/node',
  npmBin: () => '/usr/bin/npm',
  npmPrefix: () => '/usr/local',
  canWrite: () => true,
  ...over,
});

const make = (p: CliProbe, runner: CliRunner = async () => ({ code: 0, output: '' })) =>
  new CliUpdateService({
    root: path.join(tmp, 'cache'),
    logger: { info: jest.fn(), warn: jest.fn() },
    probe: p,
    runner,
    events: appEvents,
    emit: (e) => events.push(e as Record<string, unknown>),
  });

describe('install plan', () => {
  it('not-installed dsh: exact npm command, all requirements green', async () => {
    const plan = await make(probe()).previewUpdate('dsh');
    expect(plan.mode).toBe('install');
    expect(plan.command).toMatch(/^npm(\.cmd)? install -g @deepseek-ai\/dsh@latest$/);
    expect(plan.blockers).toEqual([]);
    expect(plan.requirements.map((r) => [r.id, r.ok])).toEqual([
      ['node', true],
      ['npm', true],
      ['write', true],
    ]);
  });

  it('dsh needs Node >= 24: blocks with the detected version', async () => {
    const plan = await make(probe({ nodeVersion: () => '22.14.0' })).previewUpdate('dsh');
    expect(plan.blockers.join()).toContain('24');
    expect(plan.blockers.join()).toContain('22.14.0');
    expect(plan.requirements.find((r) => r.id === 'node')?.ok).toBe(false);
    // 同一个 Node 装 Claude Code（≥22）没问题
    expect(
      (await make(probe({ nodeVersion: () => '22.14.0' })).previewUpdate('claude')).blockers,
    ).toEqual([]);
  });

  it('missing node / npm are reported, never silently ignored', async () => {
    const plan = await make(probe({ nodeVersion: () => null, npmBin: () => null })).previewUpdate(
      'dsh',
    );
    expect(plan.blockers).toHaveLength(2);
    expect(plan.requirements.find((r) => r.id === 'npm')?.ok).toBe(false);
  });

  it('read-only global prefix: no sudo, offers the user-directory command instead', async () => {
    const svc = make(probe({ canWrite: (d) => d !== '/usr/local' }));
    const plan = await svc.previewUpdate('claude');
    expect(plan.blockers.join()).toMatch(/sudo/);
    expect(plan.userScopeCommand).toContain(`--prefix`);
    expect(plan.userScopeCommand).toContain('.local');
    expect(plan.command).not.toMatch(/sudo/);
    const user = await svc.previewUpdate('claude', 'user');
    expect(user.blockers).toEqual([]);
    expect(user.argv.slice(-2)).toEqual(['--prefix', userPrefix()]);
    expect(isAllowedUpdateArgv(user.argv)).toBe(true);
  });

  it('whitelist: only the three packages, only the user prefix', () => {
    const base = ['npm', 'install', '-g'];
    expect(isAllowedUpdateArgv([...base, '@deepseek-ai/dsh@latest'])).toBe(true);
    expect(isAllowedUpdateArgv([...base, '@deepseek-ai/dsh@latest', '--prefix', '/etc'])).toBe(
      false,
    );
    expect(isAllowedUpdateArgv([...base, 'left-pad@latest'])).toBe(false);
    expect(isAllowedUpdateArgv(['sudo', ...base, '@openai/codex@latest'])).toBe(false);
    expect(isAllowedUpdateArgv([...base, '@openai/codex@latest', '--unsafe-perm'])).toBe(false);
  });
});

describe('run with a mock npm', () => {
  const installMock =
    (name: string, version: string): CliRunner =>
    async (argv, onLine) => {
      onLine(`added 1 package`);
      const prefix = argv.includes('--prefix') ? argv[argv.indexOf('--prefix') + 1]! : tmp;
      const bin = path.join(prefix, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const f = path.join(bin, name);
      fs.writeFileSync(f, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
      return { code: 0, output: 'added 1 package' };
    };

  posix(
    'installs dsh into the user directory, streams log lines, finds the new binary',
    async () => {
      const svc = make(probe({ canWrite: () => true }), installMock('dsh', '0.2.0-rc.2'));
      const res = await svc.run('dsh', 'user');
      expect(res.ok).toBe(true);
      expect(res.version).toBe('0.2.0-rc.2');
      expect(res.path).toBe(path.join(tmp, '.local', 'bin', 'dsh'));
      const phases = events.map((e) => e.phase);
      expect(phases[0]).toBe('start');
      expect(phases).toContain('log');
      expect(phases[phases.length - 1]).toBe('done');
      expect(events.find((e) => e.phase === 'start')).toMatchObject({
        kind: 'dsh',
        mode: 'install',
      });
      // 每个进度事件原样发给所有窗口（ai:cli-update:event）
      expect(appEvents.published.map((e) => [e.event, e.payload, e.surfaces])).toEqual(
        events.map((e) => ['cliUpdate.event', e, null]),
      );
      // PATH 上没有 ~/.local/bin → 给出提示
      expect(res.note).toContain('PATH');
      // 装完再看就是「更新」模式
      expect((await svc.previewUpdate('dsh')).mode).toBe('update');
    },
  );

  posix(
    'a user-directory install wins over an older copy earlier on PATH, also after a restart',
    async () => {
      // PATH 上已有旧版（如全局目录没有写权限，只好改装到用户目录）
      const onPath = path.join(tmp, 'empty');
      fs.mkdirSync(onPath, { recursive: true });
      fs.writeFileSync(path.join(onPath, 'dsh'), '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
      const svc = make(probe(), installMock('dsh', '0.2.0'));
      expect((await svc.inspect()).find((r) => r.kind === 'dsh')?.version).toBe('0.1.0');
      const res = await svc.run('dsh', 'user');
      expect(res.path).toBe(path.join(tmp, '.local', 'bin', 'dsh'));
      expect(res.version).toBe('0.2.0');
      // 重启：探测缓存清空，记下的路径仍然优先
      resetCliBinCache();
      const again = make(probe());
      expect((await again.inspect()).find((r) => r.kind === 'dsh')?.path).toBe(res.path);
      // 改用全局安装后回到按 PATH 找
      await make(probe(), installMock('dsh', '0.3.0')).run('dsh', 'global');
      resetCliBinCache();
      expect((await make(probe()).inspect()).find((r) => r.kind === 'dsh')?.path).toBe(
        path.join(onPath, 'dsh'),
      );
    },
  );

  posix(
    'global install into a custom npm prefix outside PATH / common dirs is found there (#76)',
    async () => {
      // npm 的全局前缀是自定义目录（nvm / ~/.npmrc prefix=…），bin 不在 PATH 和常见目录里
      const svc = make(probe({ npmPrefix: () => tmp }), installMock('codex', '0.130.0'));
      const res = await svc.run('codex');
      expect(res.ok).toBe(true);
      expect(res.path).toBe(path.join(tmp, 'bin', 'codex'));
      expect(res.version).toBe('0.130.0');
      expect(res.note).toBeUndefined();
      // 记住了这个目录：之后的探测直接能找到
      expect((await svc.previewUpdate('codex')).mode).toBe('update');
    },
  );

  posix('names the npm bin dir it checked when the binary is still missing', async () => {
    const svc = make(probe({ npmPrefix: () => path.join(tmp, 'elsewhere') }), async () => ({
      code: 0,
      output: 'added 2 packages',
    }));
    const res = await svc.run('codex');
    expect(res.ok).toBe(false);
    expect(res.note).toContain(path.join(tmp, 'elsewhere', 'bin'));
  });

  it('surfaces the npm error text and exit code when the command fails', async () => {
    const svc = make(probe(), async (_a, onLine) => {
      onLine('npm ERR! code EACCES');
      return { code: 243, output: 'npm ERR! code EACCES\nnpm ERR! permission denied' };
    });
    const res = await svc.run('codex');
    expect(res.ok).toBe(false);
    expect(res.log).toContain('EACCES');
    expect(res.log).toContain('243');
    expect(events[events.length - 1]).toMatchObject({ phase: 'error' });
  });

  it('refuses to run when a requirement is not met (runner never called)', async () => {
    const runner = jest.fn(async () => ({ code: 0, output: '' }));
    const svc = make(probe({ nodeVersion: () => '20.0.0' }), runner);
    const res = await svc.run('dsh');
    expect(res.ok).toBe(false);
    expect(res.log).toContain('24');
    expect(runner).not.toHaveBeenCalled();
  });

  posix('updating an installed claude falls back from `claude update` to npm', async () => {
    const bin = path.join(tmp, '.local', 'share', 'claude', 'claude');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
    process.env.NOMI_CLAUDE_BIN = bin;
    const calls: string[][] = [];
    const svc = make(probe(), async (argv) => {
      calls.push(argv);
      return argv[1] === 'update'
        ? { code: 1, output: 'not supported' }
        : { code: 0, output: 'ok' };
    });
    expect((await svc.previewUpdate('claude')).mode).toBe('update');
    const res = await svc.run('claude');
    expect(calls.map((c) => c.slice(1).join(' '))).toEqual([
      'update',
      'install -g @anthropic-ai/claude-code@latest',
    ]);
    expect(res.ok).toBe(true);
  });
});

describe('job state lives in the main process', () => {
  const gated = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const runner: CliRunner = async (_argv, onLine) => {
      calls++;
      onLine('added 1 package');
      await gate;
      onLine('done');
      return { code: 0, output: '' };
    };
    return { runner, release: () => release(), calls: () => calls };
  };
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(fn()).toBe(true);
  };

  it('keeps status and log lines while running, so a re-mounted page can restore them', async () => {
    const g = gated();
    const svc = make(probe(), g.runner);
    expect(svc.job('codex')).toBeNull();
    const first = svc.run('codex');
    await waitFor(() => (svc.job('codex')?.lines.length ?? 0) >= 2);
    const snap = svc.job('codex')!;
    expect(snap.status).toBe('running');
    expect(snap.command).toMatch(/npm(\.cmd)? install -g @openai\/codex@latest|codex/);
    expect(snap.lines).toContain('added 1 package');
    // 「卸载页面再挂载」= 再取一次快照，内容不丢；快照是副本，改它不影响主进程
    snap.lines.length = 0;
    expect(svc.job('codex')!.lines.length).toBeGreaterThanOrEqual(2);
    expect(svc.dismissJob('codex')).toBe(false); // 运行中不能关
    g.release();
    const res = await first;
    expect(typeof res.ok).toBe('boolean');
    expect(svc.job('codex')?.status).not.toBe('running');
  });

  it('a second click on the same endpoint reuses the running task', async () => {
    const g = gated();
    const svc = make(probe(), g.runner);
    const a = svc.run('codex');
    const b = svc.run('codex');
    await waitFor(() => g.calls() >= 1);
    g.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(rb).toBe(ra);
    expect(g.calls()).toBeLessThanOrEqual(2); // 至多一轮命令（含一次回退），不会并发起第二个任务
  });

  it('runs different endpoints at the same time, queueing only npm on the same prefix', async () => {
    const g = gated();
    const svc = make(probe(), g.runner);
    const a = svc.run('codex');
    await waitFor(() => g.calls() >= 1);
    const b = svc.run('dsh');
    // 两个任务都在跑；dsh 的 npm 命令排在 codex 后面，并在日志里说明在等
    await waitFor(() =>
      (svc.job('dsh')?.lines ?? []).some((l) => /npm/i.test(l) && /等|wait/i.test(l)),
    );
    expect(svc.busyKinds().sort()).toEqual(['codex', 'dsh']);
    expect(svc.job('dsh')?.status).toBe('running');
    expect(g.calls()).toBe(1);
    g.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(g.calls()).toBe(2);
    expect(ra.log).not.toMatch(/已有安装|already running/);
    expect(rb.log).not.toMatch(/已有安装|already running/);
    expect(svc.busyKinds()).toEqual([]);
  });

  it('npm installs into different prefixes (global / user) do not wait for each other', async () => {
    const g = gated();
    const svc = make(probe(), g.runner);
    const a = svc.run('codex', 'global');
    const b = svc.run('dsh', 'user');
    await waitFor(() => g.calls() >= 2);
    g.release();
    await Promise.all([a, b]);
  });

  it('a failed npm install releases the queue for the next one', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const svc = make(probe(), async () => {
      calls++;
      if (calls === 1) {
        await gate;
        return { code: 1, output: 'EACCES' };
      }
      return { code: 0, output: '' };
    });
    const a = svc.run('codex');
    await waitFor(() => calls >= 1);
    const b = svc.run('dsh');
    release();
    expect((await a).ok).toBe(false);
    await b;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('keeps the last result until dismissed, including failures', async () => {
    const svc = make(probe(), async () => ({ code: 1, output: 'EACCES: permission denied' }));
    const res = await svc.run('dsh');
    expect(res.ok).toBe(false);
    const snap = svc.job('dsh')!;
    expect(snap.status).toBe('error');
    expect(snap.result?.log).toContain('EACCES');
    expect(snap.finishedAt).toBeGreaterThan(0);
    expect(svc.dismissJob('dsh')).toBe(true);
    expect(svc.job('dsh')).toBeNull();
  });

  it('a blocked request (Node too old) is also kept as an error job', async () => {
    const svc = make(probe({ nodeVersion: () => '20.0.0' }));
    await svc.run('dsh');
    const snap = svc.job('dsh')!;
    expect(snap.status).toBe('error');
    expect(snap.result?.log).toContain('24');
  });

  it('endpoints keep separate jobs', async () => {
    const svc = make(probe(), async () => ({ code: 1, output: 'boom' }));
    await svc.run('claude');
    await svc.run('codex');
    expect(svc.job('claude')?.kind).toBe('claude');
    expect(svc.job('codex')?.kind).toBe('codex');
    svc.dismissJob('claude');
    expect(svc.job('claude')).toBeNull();
    expect(svc.job('codex')).not.toBeNull();
  });
});

describe('升级策略（P9.6）', () => {
  const mk = (
    runner: CliRunner,
    o: { platform?: NodeJS.Platform; drain?: (k: string) => Promise<number> } = {},
  ) => {
    const updated: Array<[string, string | null]> = [];
    const svc = new CliUpdateService({
      root: path.join(tmp, 'cache'),
      logger: { info: jest.fn(), warn: jest.fn() },
      probe: probe({ npmPrefix: () => tmp }),
      runner,
      events: createRecordingAppEvents(),
      platform: o.platform,
      drain: o.drain as never,
      onUpdated: (k, v) => updated.push([k, v]),
    });
    return { svc, updated };
  };
  const installMock: CliRunner = async () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho 0.200.0\n', { mode: 0o755 });
    return { code: 0, output: 'added 1 package' };
  };

  it('Windows：还有会话在用这个 CLI 时先排空，排不空就不升级（运行中的程序不能被替换）', async () => {
    const runner = jest.fn(installMock);
    const drain = jest.fn(async () => 2);
    const { svc, updated } = mk(runner, { platform: 'win32', drain });
    const res = await svc.run('codex');
    expect(drain).toHaveBeenCalledWith('codex');
    expect(res.ok).toBe(false);
    expect(res.log).toContain('2');
    expect(runner).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
  });

  it('macOS / Linux 不排空（替换文件不影响运行中的进程）', async () => {
    const drain = jest.fn(async () => 1);
    const { svc } = mk(jest.fn(installMock), { platform: 'darwin', drain });
    await svc.run('codex');
    expect(drain).not.toHaveBeenCalled();
  });

  posix('升级成功后通知编排层（空闲时用新版本重启续接）；失败不通知', async () => {
    const ok = mk(installMock);
    const res = await ok.svc.run('codex');
    expect(res.ok).toBe(true);
    expect(ok.updated).toEqual([['codex', '0.200.0']]);
    const bad = mk(async () => ({ code: 1, output: 'npm ERR!' }));
    expect((await bad.svc.run('codex')).ok).toBe(false);
    expect(bad.updated).toEqual([]);
  });
});

describe('environment', () => {
  it('reports node / npm and which CLIs the node version is enough for', async () => {
    const env = await make(probe({ nodeVersion: () => '22.14.0' })).environment();
    expect(env).toMatchObject({
      nodeVersion: '22.14.0',
      nodePath: '/usr/bin/node',
      npmPath: '/usr/bin/npm',
    });
    expect(Object.fromEntries(env.requirements.map((r) => [r.kind, [r.minNode, r.ok]]))).toEqual({
      claude: [22, true],
      codex: [16, true],
      dsh: [24, false],
      grok: [18, true],
      gemini: [20, true],
    });
  });

  it('no node on PATH: nothing is satisfied', async () => {
    const env = await make(
      probe({ nodeVersion: () => null, nodeBin: () => null, npmBin: () => null }),
    ).environment();
    expect(env.nodeVersion).toBeNull();
    expect(env.requirements.every((r) => !r.ok)).toBe(true);
  });
});
