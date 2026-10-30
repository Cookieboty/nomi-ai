#!/usr/bin/env node
/**
 * 批次 7s：CliUpdateService golden。场景（脚本化 probe / runner + 真实可执行的假 CLI / 假 npm）随 golden
 * 一起写出，由 Go 端逐步回放。CI 各平台由 record-b7-drivers.mjs 链式调用现场录制（NOMI_GOLDEN_DIR）。
 * Usage: node --import tsx scripts/parity/record-b7s-update.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const isWin = process.platform === 'win32';
const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7su-')));

export const SCENARIOS = [
  {
    name: 'pure',
    steps: [
      ['recipes', 'claude', 'native'],
      ['recipes', 'claude', 'npm'],
      ['recipes', 'codex', 'unknown'],
      ['recipes', 'grok', 'npm'],
      ['recipes', 'dsh', 'native'],
      ['recipes', 'gemini', 'unknown'],
      ['recipesNoBin', 'claude', 'user'],
      ['recipesNoBin', 'gemini', 'global'],
      ['allow', ['npm', 'install', '-g', '@openai/codex@latest']],
      ['allow', ['npm.cmd', 'install', '-g', '@google/gemini-cli@latest']],
      ['allow', ['NPM.CMD', 'install', '-g', '@xai-official/grok@latest']],
      ['allow', ['npm', 'install', '-g', 'left-pad@latest']],
      ['allow', ['npm', 'install', '-g', '@openai/codex@latest', '--prefix', '/tmp']],
      ['allowUserPrefix', 'dsh'],
      ['allow', ['/x/bin/claude', 'update']],
      ['allow', ['/x/bin/myclaude', 'update']],
      ['allow', ['C:\\x\\codex.cmd', 'update']],
      ['allow', ['claude', 'update', '--force']],
      ['allow', []],
      ['allow', ['rm', '-rf', '/']],
      ['allowEnvNpm', ['install', '-g', '@deepseek-ai/dsh@latest']],
      ['cmdline', ['npm', 'install', '-g', '@a/b@latest']],
      ['cmdline', ['a b', 'say "hi"', 'x=1', '中文', '']],
      ['toUpdatable', 'codex'],
      ['toUpdatable', 'cursor'],
      ['toUpdatable', 7],
      ['toUpdatable', 'gemini'],
      ['toScope', 'user'],
      ['toScope', 'USER'],
      ['toScope', null],
      ['updatable', 'cursor'],
      ['updatable', 'dsh'],
    ],
  },
  {
    name: 'planInstall',
    probe: {},
    steps: [
      ['preview', 'dsh', 'global'],
      ['preview', 'claude', 'user'],
      ['preview', 'gemini', 'global'],
    ],
  },
  {
    name: 'planBlocked',
    probe: { nodeVersion: '20.3.0', npmBin: null },
    steps: [
      ['preview', 'dsh', 'global'],
      ['preview', 'codex', 'global'],
    ],
  },
  { name: 'planNoNode', probe: { nodeVersion: null }, steps: [['preview', 'claude', 'global']] },
  { name: 'planBadNode', probe: { nodeVersion: 'abc' }, steps: [['preview', 'grok', 'global']] },
  {
    name: 'planReadOnly',
    probe: { canWrite: false },
    steps: [
      ['preview', 'codex', 'global'],
      ['preview', 'codex', 'user'],
    ],
  },
  { name: 'planNoPrefix', probe: { npmPrefix: null }, steps: [['preview', 'codex', 'global']] },
  {
    name: 'planNoPrefixNoNpm',
    probe: { npmPrefix: null, npmBin: null },
    steps: [['preview', 'codex', 'global']],
  },
  {
    name: 'planInstalled',
    bins: {
      claude: ['native', '1.0.0'],
      codex: ['npm', '0.5.0'],
      dsh: ['plain', '0.1.0'],
      grok: ['plain', '0.9.0'],
    },
    probe: {},
    steps: [
      ['preview', 'claude', 'global'],
      ['preview', 'codex', 'global'],
      ['preview', 'dsh', 'user'],
      ['preview', 'grok', 'global'],
    ],
  },
  {
    name: 'installOk',
    probe: {},
    runner: [
      {
        code: 0,
        output: 'added 1 package',
        lines: ['added 1 package'],
        install: ['codex', '0.9.1'],
      },
    ],
    steps: [
      ['run', 'a', 'codex', 'global'],
      ['await', 'a'],
      ['job', 'codex'],
      ['busy'],
      ['events'],
      ['dismiss', 'codex'],
      ['job', 'codex'],
    ],
  },
  {
    name: 'installUserScope',
    probe: {},
    runner: [{ code: 0, output: 'ok', lines: ['ok'], install: ['dsh', '0.2.0'] }],
    steps: [['run', 'a', 'dsh', 'user'], ['await', 'a'], ['job', 'dsh'], ['events']],
  },
  {
    name: 'installNotFound',
    probe: {},
    runner: [{ code: 0, output: '' }],
    steps: [['run', 'a', 'grok', 'global'], ['await', 'a'], ['job', 'grok'], ['events']],
  },
  {
    name: 'installNotFoundUser',
    probe: {},
    runner: [{ code: 0, output: '' }],
    steps: [['run', 'a', 'grok', 'user'], ['await', 'a'], ['events']],
  },
  {
    name: 'installFails',
    probe: {},
    runner: [
      {
        code: 243,
        output: 'npm ERR! code EACCES\nnpm ERR! nope',
        lines: ['npm ERR! code EACCES', 'npm ERR! nope'],
      },
    ],
    steps: [
      ['run', 'a', 'claude', 'global'],
      ['await', 'a'],
      ['job', 'claude'],
      ['dismiss', 'claude'],
      ['events'],
    ],
  },
  {
    name: 'installNullCode',
    probe: {},
    runner: [{ code: null, output: 'spawn npm ENOENT' }],
    steps: [['run', 'a', 'gemini', 'global'], ['await', 'a'], ['events']],
  },
  {
    name: 'blocked',
    probe: { nodeVersion: '18.0.0' },
    steps: [
      ['run', 'a', 'dsh', 'global'],
      ['await', 'a'],
      ['job', 'dsh'],
      ['events'],
      ['runnerCalls'],
    ],
  },
  {
    name: 'selfFallback',
    bins: { claude: ['native', '1.0.0'] },
    probe: {},
    runner: [
      { code: 1, output: 'self update failed', lines: ['self update failed'] },
      { code: 0, output: 'npm ok', bump: ['claude', '1.2.0'] },
    ],
    steps: [
      ['run', 'a', 'claude', 'global'],
      ['await', 'a'],
      ['job', 'claude'],
      ['events'],
      ['runnerCalls'],
    ],
  },
  {
    name: 'selfFallbackBlocked',
    bins: { codex: ['native', '0.1.0'] },
    probe: { npmBin: null },
    runner: [{ code: 2, output: '' }],
    steps: [['run', 'a', 'codex', 'global'], ['await', 'a'], ['events'], ['runnerCalls']],
  },
  {
    name: 'selfOk',
    bins: { grok: ['plain', '0.9.0'] },
    probe: {},
    runner: [{ code: 0, output: 'updated', bump: ['grok', '1.0.0'] }],
    steps: [['run', 'a', 'grok', 'global'], ['await', 'a'], ['events'], ['runnerCalls']],
  },
  {
    name: 'reuseAndQueue',
    probe: {},
    runner: [
      { hold: true, code: 0, output: 'c1', lines: ['c-line'] },
      { hold: true, code: 0, output: 'd1' },
      { code: 0, output: 'u1' },
    ],
    steps: [
      ['run', 'a', 'codex', 'global'],
      ['idle'],
      ['run', 'b', 'codex', 'global'],
      ['same', 'a', 'b'],
      ['job', 'codex'],
      ['run', 'c', 'dsh', 'global'],
      ['idle'],
      ['busy'],
      ['job', 'dsh'],
      ['runnerCalls'],
      ['run', 'e', 'gemini', 'user'],
      ['idle'],
      ['job', 'gemini'],
      ['runnerCalls'],
      ['release', 0],
      ['await', 'a'],
      ['idle'],
      ['runnerCalls'],
      ['release', 1],
      ['await', 'c'],
      ['await', 'e'],
      ['busy'],
      ['events'],
    ],
  },
  {
    name: 'queueFailReleases',
    probe: {},
    runner: [
      { hold: true, code: 1, output: 'boom' },
      { code: 0, output: 'fine' },
    ],
    steps: [
      ['run', 'a', 'claude', 'global'],
      ['idle'],
      ['run', 'b', 'codex', 'global'],
      ['idle'],
      ['release', 0],
      ['await', 'a'],
      ['await', 'b'],
      ['events'],
    ],
  },
  {
    name: 'drainBusy',
    platform: 'win32',
    drain: 2,
    probe: {},
    steps: [
      ['run', 'a', 'codex', 'global'],
      ['await', 'a'],
      ['job', 'codex'],
      ['runnerCalls'],
      ['drainCalls'],
    ],
  },
  {
    name: 'drainReject',
    platform: 'win32',
    drain: 'reject',
    probe: {},
    runner: [{ code: 0, output: '' }],
    steps: [['run', 'a', 'codex', 'global'], ['await', 'a'], ['drainCalls']],
  },
  {
    name: 'drainDarwin',
    platform: 'darwin',
    drain: 3,
    probe: {},
    runner: [{ code: 0, output: '' }],
    steps: [['run', 'a', 'codex', 'global'], ['await', 'a'], ['drainCalls']],
  },
  {
    name: 'onUpdated',
    probe: {},
    onUpdated: true,
    runner: [
      { code: 0, output: '', install: ['codex', '0.7.0'] },
      { code: 5, output: 'x' },
    ],
    steps: [
      ['run', 'a', 'codex', 'global'],
      ['await', 'a'],
      ['run', 'b', 'claude', 'global'],
      ['await', 'b'],
      ['updatedCalls'],
    ],
  },
  {
    name: 'onUpdatedThrows',
    probe: {},
    onUpdated: 'throw',
    runner: [{ code: 0, output: '', install: ['codex', '0.7.0'] }],
    steps: [['run', 'a', 'codex', 'global'], ['await', 'a'], ['job', 'codex'], ['warns']],
  },
  {
    name: 'manyLines',
    probe: {},
    runner: [{ code: 0, output: 'x', many: 450 }],
    steps: [
      ['run', 'a', 'claude', 'global'],
      ['await', 'a'],
      ['jobLines', 'claude'],
    ],
  },
  {
    name: 'inspect',
    bins: {
      claude: ['native', '1.0.0'],
      codex: ['npm', '0.9.9'],
      dsh: ['plain', '0.1.0'],
      gemini: ['plain', '0.3.0-preview.1'],
    },
    npm: { claude: '1.0.5', codex: '0.9.9', dsh: '0.2.0', grok: '1.0.0' },
    steps: [
      ['inspect', false],
      ['cacheFile'],
      ['npmCalls'],
      ['inspect', false],
      ['npmCalls'],
      ['inspect', true],
      ['npmCalls'],
      ['inspectTwice'],
      ['npmCalls'],
      ['warns'],
    ],
  },
  {
    name: 'inspectCached',
    cache: {
      checkedAt: 'now',
      latest: { claude: '9.0.0', codex: '0.1.0', dsh: null, grok: '1', gemini: '2.0.0' },
    },
    bins: { claude: ['plain', '1.0.0'] },
    npm: { claude: '1.0.5' },
    steps: [['inspect', false], ['cacheFile']],
  },
  {
    name: 'inspectStale',
    cache: {
      checkedAt: 0,
      latest: { claude: '9.0.0', codex: '0.1.0', dsh: null, grok: '1', gemini: '2.0.0' },
    },
    bins: { claude: ['plain', '1.0.0'] },
    npm: { claude: '1.0.5', grok: null },
    slowNpm: true,
    steps: [['inspect', false], ['idle', 2500], ['cacheFile'], ['inspect', false]],
  },
  {
    name: 'inspectNetFail',
    cache: { checkedAt: 0, latest: { claude: '9.0.0' } },
    npm: null,
    steps: [['inspect', false], ['cacheFile']],
  },
  { name: 'inspectBadCache', cacheRaw: 'null', steps: [['inspect', false], ['warns']] },
  { name: 'inspectBadCache2', cacheRaw: '{"checkedAt":1,"latest":5}', steps: [['inspect', false]] },
  {
    name: 'inspectCorrupt',
    cacheRaw: '{nope',
    npm: { claude: '1.0.0' },
    steps: [['inspect', false], ['cacheFile']],
  },
  {
    name: 'inspectArrayLatest',
    cacheRaw: '{"checkedAt":1,"latest":[]}',
    npm: { claude: '1.0.0' },
    steps: [['inspect', false], ['cacheFile']],
  },
];

async function main() {
  const core = (p) =>
    import(pathToFileURL(path.join(root, 'apps/desktop-electron/internal/core/src', p)).href);
  const svc = await core('cli/CliUpdateService.ts');
  const detect = await core('cli/detect.ts');
  const out = { platform: process.platform, scenarios: [] };
  for (const sc of SCENARIOS)
    out.scenarios.push({ ...sc, log: await runScenario(sc, svc, detect) });
  const dir =
    process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'b7s_update.json'), JSON.stringify(out, null, 2) + '\n');
  fs.rmSync(SB, { recursive: true, force: true });
  console.log(`b7s update: ${out.scenarios.length} scenarios`);
}

const exe = (file, body) => {
  if (isWin) {
    fs.writeFileSync(file + '.cmd', `@echo off\r\n${body.win}\r\n`);
    return file + '.cmd';
  }
  fs.writeFileSync(file, `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
  return file;
};
const verBin = (file, v) => exe(file, { sh: `echo "${v}"`, win: `echo ${v}` });

const ENV_BIN = {
  claude: 'NOMI_CLAUDE_BIN',
  codex: 'NOMI_CODEX_BIN',
  dsh: 'NOMI_DSH_BIN',
  grok: 'NOMI_GROK_BIN',
  gemini: 'NOMI_GEMINI_BIN',
  cursor: 'NOMI_CURSOR_BIN',
};

async function runScenario(sc, svc, detect) {
  const dir = path.join(SB, sc.name);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const saved = { ...process.env };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  process.env.PATH = path.join(dir, 'empty');
  for (const k of [
    'NVM_BIN',
    'NVM_DIR',
    'VOLTA_HOME',
    'PNPM_HOME',
    'NPM_CONFIG_PREFIX',
    'NOMI_USE_MOCK_CLI',
    'NOMI_NPM_BIN',
    ...Object.values(ENV_BIN),
  ])
    delete process.env[k];
  // 假 npm：view <pkg> version --json → 场景给定的版本；没有则失败退出
  const npmMap = sc.npm === undefined ? {} : sc.npm;
  const lines = Object.entries(npmMap ?? {}).filter(([, v]) => v);
  const pkgs = {
    claude: '@anthropic-ai/claude-code',
    codex: '@openai/codex',
    dsh: '@deepseek-ai/dsh',
    grok: '@xai-official/grok',
    gemini: '@google/gemini-cli',
  };
  const npmBin = exe(path.join(dir, 'fakenpm'), {
    // slowNpm（绝对路径：沙箱 PATH 里没有 /bin）：后台刷新必须慢于本地探测，否则「先返回旧缓存」与刷新完成之间是竞态（Node / Go 都是）
    sh:
      `echo x >> "${path.join(dir, 'npm.log')}"\n` +
      (sc.slowNpm ? '/bin/sleep 1\n' : '') +
      lines.map(([k, v]) => `[ "$2" = "${pkgs[k]}" ] && { echo '"${v}"'; exit 0; }`).join('\n') +
      '\nexit 1',
    win:
      `:nomilog\r\n(echo x>>"${path.join(dir, 'npm.log')}") 2>nul || goto nomilog\r\n` +
      (sc.slowNpm ? '"%SystemRoot%\\System32\\ping.exe" -n 2 127.0.0.1 >nul\r\n' : '') +
      lines.map(([k, v]) => `if "%2"=="${pkgs[k]}" (echo "${v}"& exit /b 0)`).join('\r\n') +
      '\r\nexit /b 1',
  });
  process.env.NOMI_NPM_BIN = npmBin;
  for (const [kind, [where, v]] of Object.entries(sc.bins ?? {})) {
    const d = path.join(
      home,
      where === 'native' ? 'versions' : where === 'npm' ? 'node_modules' : 'bin',
      kind,
    );
    fs.mkdirSync(d, { recursive: true });
    process.env[ENV_BIN[kind]] = verBin(path.join(d, kind), v);
  }
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  if (sc.cache)
    fs.writeFileSync(
      path.join(cacheDir, 'cache.json'),
      JSON.stringify({
        ...sc.cache,
        checkedAt: sc.cache.checkedAt === 'now' ? Date.now() : sc.cache.checkedAt,
      }),
    );
  if (sc.cacheRaw !== undefined) fs.writeFileSync(path.join(cacheDir, 'cache.json'), sc.cacheRaw);
  detect.resetCliBinCache();

  const log = [];
  const norm = (v) =>
    JSON.parse(
      JSON.stringify(v ?? null)
        .split(JSON.stringify(SB).slice(1, -1))
        .join('<SB>'),
    );
  const P = {
    nodeVersion: '24.1.0',
    npmBin: '/usr/bin/npm',
    npmPrefix: path.join(dir, 'prefix'),
    canWrite: true,
    ...(sc.probe ?? {}),
  };
  const probe = {
    nodeVersion: () => P.nodeVersion,
    npmBin: () => P.npmBin,
    npmPrefix: () => P.npmPrefix,
    canWrite: () => P.canWrite,
  };
  const runnerCalls = [];
  const holds = [];
  let ri = 0;
  const runner = (argv, onLine) => {
    const r = (sc.runner ?? [])[ri++] ?? { code: 0, output: '' };
    runnerCalls.push(argv);
    const finish = () => {
      for (const l of r.lines ?? []) onLine(l);
      for (let i = 0; i < (r.many ?? 0); i++) onLine(`line ${i}`);
      if (r.install) {
        const [kind, v] = r.install;
        const binDir = detect.npmPrefixBinDir(
          argv.includes('--prefix') ? argv[argv.length - 1] : P.npmPrefix,
        );
        fs.mkdirSync(binDir, { recursive: true });
        verBin(path.join(binDir, kind), v);
      }
      if (r.bump) verBin(process.env[ENV_BIN[r.bump[0]]].replace(/\.cmd$/, ''), r.bump[1]);
      return { code: r.code, output: r.output };
    };
    if (!r.hold) return Promise.resolve().then(finish);
    return new Promise((res) => holds.push(() => res(finish())));
  };
  const events = [];
  const warns = [];
  const drainCalls = [];
  const updated = [];
  const s = new svc.CliUpdateService({
    root: cacheDir,
    logger: { info() {}, warn: (m) => warns.push(m) },
    probe,
    runner,
    events: {
      publish: (e, p) => {
        if (e !== 'cliUpdate.event') throw new Error(e);
      },
    },
    emit: (e) => events.push(e),
    platform: sc.platform ?? process.platform,
    drain:
      sc.drain === undefined
        ? undefined
        : async (k) => {
            drainCalls.push(k);
            if (sc.drain === 'reject') throw new Error('x');
            return sc.drain;
          },
    onUpdated: sc.onUpdated
      ? (k, v) => {
          updated.push([k, v]);
          if (sc.onUpdated === 'throw') throw new Error('hook');
        }
      : undefined,
  });
  const runs = {};
  const job = (j) =>
    j && {
      ...j,
      startedAt: typeof j.startedAt,
      ...(j.finishedAt !== undefined ? { finishedAt: typeof j.finishedAt } : {}),
    };
  for (const st of sc.steps) {
    const [op, a, b, c] = st;
    let v;
    switch (op) {
      case 'recipes':
        v = svc.updateRecipes(a, `/x/${a}`, b, 'global');
        break;
      case 'recipesNoBin':
        v = svc.updateRecipes(a, null, 'unknown', b);
        break;
      case 'allow':
        v = svc.isAllowedUpdateArgv(a);
        break;
      case 'allowUserPrefix':
        v = svc.isAllowedUpdateArgv([
          'npm',
          'install',
          '-g',
          '@deepseek-ai/dsh@latest',
          '--prefix',
          svc.userPrefix(),
        ]);
        break;
      case 'allowEnvNpm':
        v = [
          svc.isAllowedUpdateArgv([npmBin, ...a]),
          svc.isAllowedUpdateArgv(['/other/npmx', ...a]),
        ];
        break;
      case 'cmdline':
        v = svc.commandLine(a);
        break;
      case 'toUpdatable':
        v = svc.toUpdatable(a);
        break;
      case 'toScope':
        v = svc.toScope(a);
        break;
      case 'updatable':
        v = svc.isUpdatable(a);
        break;
      case 'preview':
        v = await s.previewUpdate(a, b);
        break;
      case 'inspect':
        v = await s.inspect(a);
        break;
      case 'run':
        runs[a] = s.run(b, c);
        v = null;
        break;
      case 'await':
        v = await runs[a];
        break;
      case 'inspectTwice': {
        const [x, y] = await Promise.all([s.inspect(true), s.inspect(true)]);
        v = JSON.stringify(x) === JSON.stringify(y);
        break;
      }
      case 'npmCalls': {
        const f = path.join(dir, 'npm.log');
        v = fs.existsSync(f)
          ? fs
              .readFileSync(f, 'utf8')
              .split('\n')
              .filter((l) => l.trim()).length
          : 0;
        fs.rmSync(f, { force: true });
        break;
      }
      case 'same':
        v = runs[a] === runs[b];
        break;
      case 'release':
        holds[a]();
        await new Promise((r) => setTimeout(r, 50));
        v = null;
        break;
      case 'idle':
        await new Promise((r) => setTimeout(r, a ?? 400));
        v = null;
        break;
      case 'job':
        v = job(s.job(a));
        break;
      case 'jobLines': {
        const j = s.job(a);
        v = [j.lines.length, j.lines[0], j.lines[j.lines.length - 1]];
        break;
      }
      case 'dismiss':
        v = s.dismissJob(a);
        break;
      case 'busy':
        v = s.busyKinds();
        break;
      case 'events': {
        const by = {};
        for (const e of events.splice(0)) (by[e.kind] ??= []).push(e);
        v = by;
        break;
      }
      case 'runnerCalls':
        v = runnerCalls.splice(0);
        break;
      case 'drainCalls':
        v = drainCalls;
        break;
      case 'updatedCalls':
        v = updated;
        break;
      case 'warns':
        v = warns.splice(0);
        break;
      case 'cacheFile': {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(cacheDir, 'cache.json'), 'utf8'));
          v =
            c && typeof c === 'object'
              ? {
                  ...c,
                  checkedAt:
                    typeof c.checkedAt === 'number' && c.checkedAt > 1e12 ? 'recent' : c.checkedAt,
                }
              : c;
        } catch (e) {
          v = 'unreadable';
        }
        break;
      }
      default:
        throw new Error(op);
    }
    log.push([op, norm(v)]);
  }
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  return log;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main();
