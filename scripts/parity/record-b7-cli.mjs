#!/usr/bin/env node
/**
 * 批次 7 item 2：core/cli 叶子模块（semver / textCursor / cliEnv / cliLaunch / legacyCliKey / processTree /
 * detect / shellPath）与 usage 叶子（cliHomes / limitedProcess / grokAuth / sqliteRead / cliTokens）的 golden。
 * 每个平台在 CI 现场录制（record-b7-drivers.mjs 链式调用，NOMI_GOLDEN_DIR），Windows 的 .cmd/.exe 解析、
 * cmd.exe 垫片、taskkill 进程树、cliSearchDirs / withCliPath 的 Windows 分支都在 windows-latest 上录真实 Node 行为。
 * 输出 {fixtures, cases:[{name,out}]}；沙箱路径记为 <SB>，node 可执行文件记为 <NODE>。
 * Usage: node --import tsx scripts/parity/record-b7-cli.mjs
 */
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const require = createRequire(import.meta.url);

// processTree：拦截 execFileSync / spawnSync / process.kill，记录调用（不真的杀进程）
const cp = require('node:child_process');
const calls = [];
let pgrepTree = {};
const realExecFileSync = cp.execFileSync;
const realSpawnSync = cp.spawnSync;
cp.execFileSync = (file, args, opts) => {
  if (file === 'pgrep') {
    calls.push(['pgrep', args]);
    const kids = pgrepTree[args[1]];
    if (!kids) {
      const e = new Error('exit 1');
      e.status = 1;
      throw e;
    }
    return kids;
  }
  return realExecFileSync(file, args, opts);
};
cp.spawnSync = (file, args, opts) => {
  if (file === 'taskkill') {
    calls.push(['taskkill', args, { timeout: opts.timeout, stdio: opts.stdio }]);
    return { status: 0 };
  }
  return realSpawnSync(file, args, opts);
};
syncBuiltinESMExports();
const realKill = process.kill;

const core = (p) => import(pathToFileURL(path.join(root, 'packages/core/src', p)).href);
const semver = await core('cli/semver.ts');
const textCursor = await core('cli/textCursor.ts');
const cliEnv = await core('cli/cliEnv.ts');
const cliLaunch = await core('cli/cliLaunch.ts');
const legacy = await core('cli/legacyCliKey.ts');
const tree = await core('cli/processTree.ts');
const detect = await core('cli/detect.ts');
const shellPath = await core('cli/shellPath.ts');
const homes = await core('usage/cliHomes.ts');
const limited = await core('usage/limitedProcess.ts');
const grok = await core('usage/grokAuth.ts');
const sqlite = await core('usage/sqliteRead.ts');
const tokens = await core('usage/quality/cliTokens.ts');

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7cli-')));
const NODE = process.execPath;
const cases = [];
const add = (name, fn) => {
  let out;
  try {
    out = { v: fn() };
    if (out.v === undefined) out = { undef: true };
  } catch (e) {
    out = { err: String(e?.message ?? e) };
  }
  cases.push({ name, out });
};
const addAsync = async (name, fn) => {
  let out;
  try {
    out = { v: await fn() };
    if (out.v === undefined) out = { undef: true };
  } catch (e) {
    out = { err: String(e?.message ?? e), kind: e?.kind };
  }
  cases.push({ name, out });
};

// —— fixtures（Go 测试按同样的列表在自己的沙箱里重建）——
const isWin = process.platform === 'win32';
const fixtures = [
  { p: 'bin/claude', c: '#!/bin/sh\necho claude\n', mode: 0o755 },
  { p: 'bin/claude.cmd', c: '@echo off\r\n' },
  { p: 'bin/codex.exe', c: 'MZ' },
  { p: 'bin/Dsh.CMD', c: '@echo off\r\n' },
  { p: 'bin2/grok', c: '#!/bin/sh\n', mode: 0o755 },
  { p: 'bin2/node.exe', c: 'MZ' },
  { p: 'npm/pkg/cli.js', c: 'console.log(1)\n' },
  { p: 'npm/claude.cmd', c: '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\pkg\\cli.js" %*\r\n' },
  { p: 'npm/nojs.cmd', c: '@echo off\r\necho hi %1\r\n' },
  { p: 'npm/missing.cmd', c: '"%~dp0\\pkg\\gone.js" %*\r\n' },
  { p: 'npm/bad%.cmd', c: '"%~dp0\\pkg\\cli.js"\r\n' },
  { p: 'npm2/node.exe', c: 'MZ' },
  { p: 'npm2/pkg/main.mjs', c: '' },
  { p: 'npm2/tool.bat', c: '"%dp0%\\pkg\\main.mjs" "%~dp0\\node.exe" %*' },
  { p: 'npm3/x.cmd', c: '"C:/abs/node" "%~dp0/pkg/z.cjs"\r\n' },
  { p: 'npm3/pkg/z.cjs', c: '' },
  { p: 'home/.nvm/versions/node/v18.2.0/bin/.keep', c: '' },
  { p: 'home/.nvm/versions/node/v20.11.1/bin/.keep', c: '' },
  { p: 'home/.nvm/versions/node/v20.9.0/bin/.keep', c: '' },
  { p: 'home/.nvm/versions/node/v9.0.0/bin/.keep', c: '' },
  { p: 'home/.nvm/versions/node/system/.keep', c: '' },
  { p: 'home/.local/bin/.keep', c: '' },
  { p: 'home/.grok/bin/.keep', c: '' },
  { p: 'home/AppData/Roaming/npm/.keep', c: '' },
  { p: 'mock/grok-agent.js', c: [
    "process.stdin.setEncoding('utf8');let b='';",
    "process.stdin.on('data',(d)=>{b+=d;const i=b.indexOf('\\n');if(i<0)return;const m=JSON.parse(b.slice(0,i));",
    "process.stdout.write('log line\\n');",
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,authMethods:[{id:'cached_token',name:'x'}],_meta:{cwdBase:require('path').basename(process.cwd()).slice(0,15),noColor:process.env.NO_COLOR,args:process.argv.slice(2)}}})+'\\n');",
    "setTimeout(()=>{},60000);});",
  ].join('') },
  { p: 'mock/grok.cmd', c: '@"%~dp0\\missing\\node.exe" "%~dp0\\grok-agent.js" %*\r\n' },
  { p: 'mock/grok', c: `#!/bin/sh\nexec "${'$'}NOMI_TEST_NODE" "$(dirname "$0")/grok-agent.js" "$@"\n`, mode: 0o755 },
  { p: 'mock/echo.js', c: "process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:require('path').basename(process.cwd()),nc:process.env.NOMI_X??null}));" },
  { p: 'mock/big.js', c: "process.stdout.write('x'.repeat(5000));setTimeout(()=>{},2000);" },
  { p: 'mock/hang.js', c: 'setTimeout(()=>{},60000);' },
  { p: 'mock/exit3.js', c: "process.stdout.write('partial');process.exit(3);" },
  { p: 'mock/shim.cmd', c: '@echo off\r\necho shim:%~1:%~2:\r\n' },
  { p: 'cwd/.keep', c: '' },
];
for (const f of fixtures) {
  const abs = path.join(SB, ...f.p.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, f.c);
  if (f.mode) fs.chmodSync(abs, f.mode);
}
const sb = (...p) => path.join(SB, ...p);

// —— semver ——
const vers = ['1.0.0', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-rc.2.1', '1.0.0-alpha', '1.0.0-1', '1.0.0-a.b',
  '2.0.0', 'v1.2.3', 'x', '0.2.0-rc.1', '0.2.0-rc.1a', '10.0.0', '1.0.0-rc.02', '1.0.0+build', ''];
for (const a of vers) add(`parseSemver:${a}`, () => semver.parseSemver(a));
for (const a of vers) for (const b of vers) add(`isNewer:${a}|${b}`, () => semver.isNewer(a, b));

// —— textCursor ——
const mt = [
  ['', 'hi', [], 'segment'], ['hi', '  ', [3], 'segment'], ['hello', 'lo', [], 'segment'],
  ['hello', 'hello world', [1], 'segment'], ['abc', 'xyz', [], 'segment'], ['abc def', ' def ', [], 'final'],
  ['abc def', ' def ', [], 'segment'], ['你好', '世界', [0], 'final'], ['😀a', 'b', [], 'segment'],
];
for (const [i, a] of mt.entries()) add(`mergeAssistantText:${i}`, () => textCursor.mergeAssistantText(...a));
const evs = [
  { type: 'text-delta', text: '!' }, { type: 'text', text: 'new' }, { type: 'done', text: 'pre' },
  { type: 'tool', id: 't' }, { type: 'thinking', text: 'x', textAt: 1 }, { type: 'thinking', textAt: null },
  { type: 'error', message: 'm' },
];
for (const [i, ev] of evs.entries()) add(`foldAssistantEvent:${i}`, () => textCursor.foldAssistantEvent('pre😀', [2], ev));

// —— cliEnv ——
for (const n of ['NOMI_X', 'NOMI_MOCK_Y', 'COMPANION_A', 'IG_B', 'CD_', 'MCP_SERVERS', 'MCP_SERVERS_X', 'PATH', 'nomi_x', 'ANTHROPIC_API_KEY'])
  add(`isNomiInternalEnv:${n}`, () => cliEnv.isNomiInternalEnv(n));
add('buildCliEnv', () => cliEnv.buildCliEnv({ PATH: '/b', NOMI_A: '1', NOMI_MOCK_B: '2', NO_COLOR: '0', MCP_AUTO_CONNECT: 'x', Z: '' }, { NOMI_DSH_API_KEY: 'k', PATH: '/c' }));
add('buildCliEnv:noextra', () => cliEnv.buildCliEnv({ B: '1', A: '2' }));

// —— legacyCliKey ——
const sec = (mode) => ({
  available: () => { if (mode === 'throwAvail') throw new Error('x'); return mode !== 'off'; },
  decrypt: (buf) => { if (mode === 'throw') throw new Error('bad'); return `dec(${buf.toString('hex')})`; },
});
for (const mode of ['on', 'off', 'throw', 'throwAvail'])
  for (const enc of ['', 'aGVsbG8=', 'aGVsbG8', 'aGV sbG8=', 'YQ==YQ==', 'a-_b', '5L2g5aW9', '/w==', 'Zg'])
    add(`legacyCliKey:${mode}:${enc}`, () => legacy.legacyCliKeyDecryptor(sec(mode))(enc));

// —— processTree（调用记录） ——
const fakeChild = (pid) => {
  const log = [];
  return { log, c: { pid, kill: (s) => { log.push(s); if (pid === 99) throw new Error('gone'); return true; } } };
};
const treeCase = (name, pid, t) => {
  calls.length = 0;
  pgrepTree = t;
  const kills = [];
  process.kill = (p, s) => { kills.push([p, s]); if (p === 13) throw new Error('ESRCH'); return true; };
  const f = fakeChild(pid);
  try { tree.killProcessTree(f.c); } finally { process.kill = realKill; }
  add(`killProcessTree:${name}`, () => ({ calls: [...calls], kills, childKill: f.log }));
};
treeCase('nopid', undefined, {});
treeCase('leaf', 10, {});
treeCase('tree', 10, { 10: '11\n12\n', 11: '13\n', 12: 'x\n\n0\n14 \n', 13: '', 14: '-1\n1.5\n' });
treeCase('throwing', 99, { 99: '13\n' });
{
  calls.length = 0;
  pgrepTree = { 1: '2\n', 2: '3\n', 3: '4\n', 4: '5\n' };
  add('listDescendants:depth2', () => ({ out: tree.listDescendants(1, 2), calls: [...calls] }));
}

// —— shellPath ——
for (const [i, s] of ['x__NOMI_PATH_START__/a:/b__NOMI_PATH_END__y', '__NOMI_PATH_START__1__NOMI_PATH_END__ __NOMI_PATH_START__ /z \n__NOMI_PATH_END__',
  '__NOMI_PATH_START__no end', 'nothing', '__NOMI_PATH_START__  __NOMI_PATH_END__', '__NOMI_PATH_END____NOMI_PATH_START__q__NOMI_PATH_END__'].entries())
  add(`parseShellPath:${i}`, () => shellPath.parseShellPath(s));
add('mergePath:colon', () => shellPath.mergePath('/a:/b::/a', ' /c :/b:/d', ':'));
add('mergePath:semi', () => shellPath.mergePath('C:\\a;C:\\b', 'C:\\b;;C:\\c', ';'));
add('mergePath:default', () => shellPath.mergePath(['a', 'b'].join(path.delimiter), ['b', 'c'].join(path.delimiter)));
add('LOGIN_SHELL_ARGS', () => shellPath.LOGIN_SHELL_ARGS);
{
  shellPath.resetShellPathForTest();
  const before = process.env.PATH;
  const added = [];
  await shellPath.loadLoginShellPath((a) => added.push(...a), { run: async (shell, args) => `${['/x/new1', before.split(path.delimiter)[0], '/x/new2'].join(path.delimiter)}` });
  const after = process.env.PATH;
  process.env.PATH = before;
  add('loadLoginShellPath', () => ({ added: process.platform === 'win32' ? null : added, changed: after !== before }));
  shellPath.resetShellPathForTest();
}

// —— cliHomes / cliTokens ——
const H = '/home/u';
const envs = [{}, { CLAUDE_CONFIG_DIR: '~', CODEX_HOME: '~/cx', GEMINI_CLI_HOME: ' ~\\g ', QWEN_HOME: '/abs/q', OPENCODE_HOME: '', XDG_DATA_HOME: '~/xdg', COPILOT_HOME: '  ', KIMI_HOME: '~/k', KIMI_CODE_HOME: '/kc', GROK_HOME: '/g/' }, { OPENCODE_HOME: '~/oc' }];
for (const [i, e] of envs.entries())
  add(`cliHomes:${i}`, () => ({ claude: homes.claudeConfigDir(H, e), codex: homes.codexHomeDir(H, e), gemini: homes.geminiDir(H, e), qwen: homes.qwenDir(H, e), opencode: homes.opencodeDir(H, e), copilot: homes.copilotDir(H, e), kimi: homes.kimiDirs(H, e), grok: homes.grokHomeDir(H, e) }));
for (const [c, u] of [['codex', { inputTokens: 10, cacheReadTokens: 3 }], ['codex', { inputTokens: 1, cacheReadTokens: 3 }], ['codex', { inputTokens: 5 }], ['claude', { inputTokens: 10, cacheReadTokens: 3 }], ['codex', {}]])
  add(`qualityLedgerInput:${c}:${JSON.stringify(u)}`, () => tokens.qualityLedgerInput(c, u));

// —— limitedProcess：纯函数 + 真实 fs 的 .cmd 解包 ——
add('windowsShimLaunch:plain', () => limited.windowsShimLaunch('C:\\x\\a.cmd', ['--tools', '', 'a b'], {}));
add('windowsShimLaunch:comspec', () => limited.windowsShimLaunch('a.cmd', [], { ComSpec: 'C:\\W\\cmd.exe' }));
for (const bad of ['a"b', 'a%b', 'a\nb', 'a\rb']) add(`windowsShimLaunch:bad:${JSON.stringify(bad)}`, () => limited.windowsShimLaunch('a.cmd', [bad], {}));
for (const f of ['npm/claude.cmd', 'npm/nojs.cmd', 'npm/missing.cmd', 'npm/bad%.cmd', 'npm2/tool.bat', 'npm3/x.cmd', 'npm/none.cmd', 'bin/claude', 'npm/CLAUDE.CMD'])
  add(`unwrapWindowsCmdShim:${f}`, () => limited.unwrapWindowsCmdShim(sb(...f.split('/'))));
for (const plat of ['win32', 'linux'])
  for (const f of ['npm/claude.cmd', 'npm/nojs.cmd', 'npm/missing.cmd', 'bin/codex.exe'])
    add(`resolveCliLaunch:${plat}:${f}`, () => limited.resolveCliLaunch(sb(...f.split('/')), ['-p', ''], { ComSpec: 'CS' }, plat));
add('resolveCliLaunch:win32:quote', () => limited.resolveCliLaunch(sb('npm', 'nojs.cmd'), ['a"b'], {}, 'win32'));

// —— detect ——
for (const plat of ['win32', 'linux'])
  for (const f of ['bin/claude', 'bin/codex', 'bin/dsh', 'bin/claude.CMD', 'bin2/grok', 'bin/none'])
    add(`windowsExecutable:${plat}:${f}`, () => detect.windowsExecutable(sb(...f.split('/')), plat));
for (const plat of ['win32', 'darwin']) add(`npmPrefixBinDir:${plat}`, () => detect.npmPrefixBinDir('/p', plat));
const pathEnv = (dirs, extra = {}) => ({ Path: dirs.map((d) => sb(d)).join(path.delimiter), ...extra });
for (const plat of ['win32', 'linux']) {
  for (const cmd of ['claude', 'codex', 'dsh', 'grok', 'node', 'claude.cmd', 'none', 'cli.js'])
    add(`findOnPath:${plat}:${cmd}`, () => detect.findOnPath(cmd, pathEnv(['bin', 'bin2', 'npm/pkg']), plat));
  add(`findOnPath:${plat}:pathext`, () => detect.findOnPath('claude', pathEnv(['bin'], { PATHEXT: 'CMD; .EXE;;' }), plat));
  add(`findOnPath:${plat}:empty`, () => detect.findOnPath('claude', { PATH: '' }, plat));
}
for (const plat of ['win32', 'linux']) {
  add(`cliSearchDirs:${plat}:bare`, () => detect.cliSearchDirs(sb('home'), plat, {}));
  add(`cliSearchDirs:${plat}:env`, () => detect.cliSearchDirs(sb('home'), plat, {
    USERPROFILE: ` ${sb('home')} `, APPDATA: '', LOCALAPPDATA: sb('lad'), NPM_CONFIG_PREFIX: ' /np ', PNPM_HOME: '/pn', VOLTA_HOME: '/vo',
    NVM_BIN: '/nvm/bin', NVM_DIR: sb('home', '.nvm'),
  }));
}
add('withCliPath', () => {
  const r = detect.withCliPath({ HOME: sb('home'), USERPROFILE: sb('home'), APPDATA: sb('home', 'AppData', 'Roaming'), path: [sb('home', '.local', 'bin'), '/zz'].join(path.delimiter), X: '1' });
  return r;
});
add('withCliPath:nopath', () => detect.withCliPath({ HOME: sb('home'), USERPROFILE: sb('home') }));
for (const b of [null, '/usr/lib/node_modules/x', 'C:\\Users\\u\\AppData\\Roaming\\npm-global\\claude', '/h/.nvm/versions/node/v20/bin/claude', '/h/.local/share/claude/versions/1/claude',
  '/h/.volta/bin/c', '/opt/fnm/c', '/h/.asdf/shims/c', '/h/mise/c', '/h/pnpm/c', '/h/.bun/bin/c', '/h/.npm-packages/c', '/x/versions/c', '/usr/local/bin/claude', 'C:\\X\\PNPM\\c'])
  add(`guessInstallMethod:${b}`, () => detect.guessInstallMethod(b));
for (const v of ['24.0.0', '23.9.9', '', 'x.1', '100.0.0', null]) add(`dshRuntimeProblem:${v}`, () => detect.dshRuntimeProblem(v));
add('NPM_PKG', () => detect.NPM_PKG);
add('CLI_MIN_NODE_MAJOR', () => detect.CLI_MIN_NODE_MAJOR);

// —— cliLaunch ——
for (const plat of ['win32', 'linux'])
  for (const [f, nb] of [['npm/claude', '/n/node'], ['npm/claude.cmd', null], ['npm/nojs', '/n/node'], ['npm3/x.cmd', '/n/node'], ['bin/codex', null], ['npm/missing.cmd', '/n/node']])
    add(`resolveHarnessLaunch:${plat}:${f}:${nb}`, () => {
      const r = cliLaunch.resolveHarnessLaunch(sb(...f.split('/')), ['a'], { HOME: sb('home'), USERPROFILE: sb('home'), PATH: '/p' }, plat, nb);
      return r;
    });

// —— grokAuth：解析 ——
const grokTexts = [
  '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"cached_token"}]}}',
  'log\n{"result":{"authMethods":[],"_meta":{"defaultAuthMethodId":"oauth"}}}\r\n',
  '{"authMethods":[{"id":"x"}],"defaultAuthMethodId":"xai-api-key"}',
  '{"authMethods":[{"id":"x"}],"_meta":{"defaultAuthMethodId":"grok.com"}}',
  '{"authMethods":[{"id":"x"}],"_meta":{"defaultAuthMethodId":5},"defaultAuthMethodId":"deployment"}',
  '{"authMethods":[{"id":"cached-token"}],"defaultAuthMethodId":"other"}',
  '{"authMethods":"no"}', 'not json', '', '[1]', '{"result":{"result":{"authMethods":[{"id":"CachedToken"}]}}}',
  '  {"authMethods":[{"id":"cachedtoken"}]}  ', '{"a":1}\n{"authMethods":[{"id":"env_key"}],"defaultAuthMethodId":"ENV-KEY"}',
];
for (const [i, t] of grokTexts.entries()) add(`parseGrokAuthStatus:${i}`, () => grok.parseGrokAuthStatus(t));

// —— 真实子进程往返：runLimited / readGrokAuthStatus（Windows 走 .cmd 解包与 cmd.exe 垫片）——
const env = { ...process.env, NOMI_TEST_NODE: NODE, NOMI_X: 'v' };
const run = (cmd, args, o = {}) => limited.runLimited(cmd, args, { cwd: sb('cwd'), env, timeoutMs: 8000, maxBytes: 4096, ...o });
await addAsync('runLimited:ok', () => run(NODE, [sb('mock', 'echo.js'), 'a b', '', 'c"d']));
await addAsync('runLimited:exit3', () => run(NODE, [sb('mock', 'exit3.js')]));
await addAsync('runLimited:limit', () => run(NODE, [sb('mock', 'big.js')]));
await addAsync('runLimited:timeout', () => run(NODE, [sb('mock', 'hang.js')], { timeoutMs: 300 }));
await addAsync('runLimited:missing', () => run(sb('mock', 'nope-bin'), []));
await addAsync('runLimited:badcwd', () => run(NODE, ['-v'], { cwd: sb('nope') }));
if (isWin) {
  await addAsync('runLimited:win:cmdshim', () => run(sb('mock', 'shim.cmd'), ['x y', '']));
  await addAsync('runLimited:win:quoteReject', () => run(sb('mock', 'shim.cmd'), ['a%b']));
  await addAsync('runLimited:win:unwrap', () => run(sb('npm', 'claude.cmd'), ['q'], { env: { ...env, PATH: path.dirname(NODE) + ';' + (env.PATH ?? env.Path ?? '') } }));
}
const grokBin = isWin ? sb('mock', 'grok.cmd') : sb('mock', 'grok');
await addAsync('readGrokAuthStatus:ok', () => grok.readGrokAuthStatus({ resolveBin: async () => grokBin, env: () => ({ ...env, PATH: path.dirname(NODE) + path.delimiter + (env.PATH ?? env.Path ?? '') }), tmpRoot: sb() }));
await addAsync('readGrokAuthStatus:nobin', () => grok.readGrokAuthStatus({ resolveBin: async () => null }));
await addAsync('readGrokAuthStatus:throwbin', () => grok.readGrokAuthStatus({ resolveBin: async () => { throw new Error('x'); } }));
await addAsync('readGrokAuthStatus:timeout', () => grok.readGrokAuthStatus({ resolveBin: async () => NODE, env: () => env, tmpRoot: sb(), timeoutMs: 400 }));
add('readGrokAuthStatus:tmpClean', () => fs.readdirSync(SB).filter((n) => n.startsWith('nomi-grok-auth-')).map((n) => n.replace(/^(nomi-grok-auth-)[A-Za-z0-9]{6}$/, '$1<R>')));

// —— sqliteRead ——
let sqliteOk = false;
try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(sb('oc.db'));
  db.exec(`CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, created_at TEXT);`);
  const ins = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  ins.run('m1', 's1', 100, 200, JSON.stringify({ role: 'assistant', modelID: 'gpt', providerID: 'oa', time: { created: 150 }, tokens: { input: 1, output: 2, reasoning: 0.5, cache: { read: 3, write: 4 } }, path: { cwd: '/w' } }));
  ins.run('m2', 's1', 101, 300, JSON.stringify({ role: 'assistant' }));
  ins.run('m3', 's1', 102, 250, JSON.stringify({ role: 'user' }));
  ins.run('m4', 's2', 103, 199, JSON.stringify({ role: 'assistant' }));
  ins.run('m5', 's2', 104, 400, 'not json');
  const ui = db.prepare('INSERT INTO assistant_usage_events VALUES (?,?,?,?,?,?,?,?)');
  ui.run(1, 's', 'm', 1, 2, 3, 4, '2025-01-01');
  ui.run(2, 's', null, 10, 20, null, null, null);
  ui.run(5, 't', 'm2', 0, 0, 0, 0, 'x');
  db.close();
  sqliteOk = true;
} catch {
  /* node:sqlite 不可用：Go 侧只比对 dbSignature 形状 */
}
add('sqlite:available', () => sqliteOk);
if (sqliteOk) {
  add('readOpencodeRows:200', () => sqlite.readOpencodeRows(sb('oc.db'), 200));
  add('readOpencodeRows:0', () => sqlite.readOpencodeRows(sb('oc.db'), 0));
  add('readCopilotRows:1', () => sqlite.readCopilotRows(sb('oc.db'), 1));
  add('readCopilotRows:0.5', () => sqlite.readCopilotRows(sb('oc.db'), 0.5));
}
add('readOpencodeRows:missing', () => sqlite.readOpencodeRows(sb('none.db'), 0));
add('readCopilotRows:wrongSchema', () => sqlite.readCopilotRows(sb('mock', 'echo.js'), 0));
add('dbSignature:missing', () => sqlite.dbSignature(sb('none.db')));
add('DB_BATCH', () => sqlite.DB_BATCH);

// —— 输出（沙箱 / node 路径替换）——
const unsub = (v) => {
  if (typeof v === 'string') return v.split(SB).join('<SB>').split(NODE).join('<NODE>');
  if (Array.isArray(v)) return v.map(unsub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unsub(x)]));
  return v;
};
const out = { platform: process.platform, delimiter: path.delimiter, sep: path.sep, fixtures, cases: unsub(cases) };
fs.rmSync(SB, { recursive: true, force: true });
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'cli.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${cases.length} cli cases (${process.platform})`);
process.exit(0);
