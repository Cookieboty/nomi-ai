#!/usr/bin/env node
/**
 * 批次 7s：modelDiscovery（mock CLI 往返）与 gemini/{acp,trust,trustedFolders} 的 golden。
 * CI 各平台由 record-b7-drivers.mjs 链式调用现场录制（NOMI_GOLDEN_DIR）。
 * Usage: node --import tsx scripts/parity/record-b7s.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const core = (p) => import(pathToFileURL(path.join(root, 'packages/core/src', p)).href);
const md = await core('cli/modelDiscovery.ts');
const acp = await core('cli/gemini/acp.ts');
const trust = await core('cli/gemini/trust.ts');
const tf = await core('cli/gemini/trustedFolders.ts');

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7s-')));
const cases = [];
const norm = (v) => (v === undefined ? { undef: true } : { v });
const add = async (name, fn) => {
  let out;
  try {
    out = norm(await fn());
  } catch (e) {
    out = { err: String(e?.message ?? e), ...(e?.name && e.name !== 'Error' ? { name: e.name } : {}) };
  }
  cases.push({ name, out });
};
const mock = (bin) => path.join(root, 'packages/core/scripts/mock-cli', bin);
const w = (rel, s) => {
  const p = path.join(SB, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
  return p;
};

/* ---------------- modelDiscovery ---------------- */
const spawner = (env = {}, script = null) => (backend, args) => {
  if (script === 'none') return null;
  const file = script ?? mock(`mock-${backend}.mjs`);
  return spawn(process.execPath, [file, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};
const settings = w('claude/settings.json', JSON.stringify({ effortLevel: 'medium' }));
const badSettings = w('claude/bad.json', '{');
const codexCfg = w('codex/config.toml', 'model = "gpt-mock-mini"\nmodel_reasoning_effort = \'low\'\n[x]\nmodel="no"\n');
const grokCache = w('grok/models_cache.json', JSON.stringify({ models: { availableModels: [
  { modelId: 'grok-mock-old', name: 'Old' }, { modelId: 'grok-cache-only', name: 'Cache Only' } ] } }));
const grokSettings = w('grok/settings_cache.json', JSON.stringify({ payload: JSON.stringify({ settings: { default_model: 'grok-cache-only' } }) }));
const grokSettings2 = w('grok/settings2.json', JSON.stringify({ payload: { default_model: 'nope' } }));
const silent = w('silent.mjs', 'process.stdin.resume(); setInterval(() => {}, 1000);\n');
const dies = w('dies.mjs', 'process.stderr.write("line1\\nline2\\nline3\\nboom: policy locked\\n"); process.exit(3);\n');
const garbage = w('garbage.mjs', 'process.stdout.write("not json\\n"); process.exit(0);\n');

const D = (o) => ({ codexConfigPath: path.join(SB, 'missing.toml'), ...o });
const disc = (name, backend, deps) => add(`md:${name}`, () => md.discoverModels(backend, D(deps)));
await disc('claude', 'claude', { spawn: spawner() });
await disc('claude:env', 'claude', { spawn: spawner(), claudeDefaults: { effortEnv: ' high ', settingsPath: settings } });
await disc('claude:envAuto', 'claude', { spawn: spawner(), claudeDefaults: { effortEnv: 'auto', settingsPath: settings } });
await disc('claude:badSettings', 'claude', { spawn: spawner(), claudeDefaults: { settingsPath: badSettings } });
await disc('claude:none', 'claude', { spawn: spawner({}, 'none') });
await disc('claude:dies', 'claude', { spawn: spawner({}, dies) });
await disc('claude:timeout', 'claude', { spawn: spawner({}, silent), timeoutMs: 400 });
await disc('codex', 'codex', { spawn: spawner(), codexConfigPath: codexCfg });
await disc('codex:noCfg', 'codex', { spawn: spawner() });
await disc('codex:fail', 'codex', { spawn: spawner({ NOMI_MOCK_MODELS_FAIL: '1' }) });
await disc('codex:garbage', 'codex', { spawn: spawner({}, garbage) });
await disc('codex:dies', 'codex', { spawn: spawner({}, dies) });
await disc('grok', 'grok', { spawn: spawner() });
await disc('grok:cache', 'grok', { spawn: spawner(), grokModelsCachePath: grokCache });
await disc('grok:noAcp', 'grok', { spawn: spawner({ NOMI_MOCK_GROK_NO_ACP: '1' }) });
await disc('grok:noAcp:cache', 'grok', { spawn: spawner({ NOMI_MOCK_GROK_NO_ACP: '1' }), grokModelsCachePath: grokCache, grokSettingsCachePath: grokSettings });
await disc('grok:noAcp:cache2', 'grok', { spawn: spawner({ NOMI_MOCK_GROK_NO_ACP: '1' }), grokModelsCachePath: grokCache, grokSettingsCachePath: grokSettings2 });
await disc('grok:none:cache', 'grok', { spawn: spawner({}, 'none'), grokModelsCachePath: grokCache });
await disc('grok:timeout', 'grok', { spawn: spawner({}, silent), timeoutMs: 400 });
await disc('gemini', 'gemini', { spawn: spawner() });
for (const [n, cd] of [['none', undefined], ['env', { effortEnv: 'max' }], ['blank', { effortEnv: '  ' }], ['file', { settingsPath: settings }],
  ['missing', { settingsPath: path.join(SB, 'nope.json') }], ['bad', { settingsPath: badSettings }]])
  await add(`md:effort:${n}`, () => md.claudeConfiguredEffort({ claudeDefaults: cd }));

/* ---------------- gemini ---------------- */
for (const ms of [0, 499, 500, 1500, 2500, 60000, 90_499]) await add(`acp:msg:${ms}`, () => acp.acpTimeoutMessage('x', ms));
for (const [code, err] of [[55, ''], [1, 'Gemini CLI is not running in a trusted directory'], [1, 'x'], [null, 'not running in a trusted directory'], [0, '']])
  await add(`trust:exit:${code}:${err}`, () => trust.isGeminiUntrustedExit(code, err));
await add('trust:msg', () => trust.geminiUntrustedMessage('/a/b'));
await add('trust:err', () => { const e = new trust.GeminiUntrustedError('/a', new Error('c')); return { name: e.name, message: e.message, folder: e.folder }; });
await add('trust:loginEnv', () => trust.geminiLoginEnv('/stage'));

for (const e of [{}, { GEMINI_CLI_TRUST_WORKSPACE: 'false' }, { GEMINI_RESTRICTED_MODE: 'true' }, { GEMINI_CLI_TRUST_WORKSPACE: 'true' }])
  await add(`tf:blocked:${JSON.stringify(e)}`, () => tf.geminiTrustBlockedByEnv(e));
await add('tf:path:default', () => tf.geminiTrustedFoldersPath('/home/u', {}));
await add('tf:path:explicit', () => tf.geminiTrustedFoldersPath('/home/u', { GEMINI_CLI_TRUSTED_FOLDERS_PATH: '  /x/y.json ' }));
await add('tf:path:cliHome', () => tf.geminiTrustedFoldersPath('/home/u', { GEMINI_CLI_HOME: '/gh' }));
process.chdir(SB); // 相对路径按 SB 解析（Go 测试同样 chdir）
const PATHS = ['/a/B', '/a/b/', '/a/./b/../c', 'rel/x', 'C:\\Users\\Me', 'c:/users/me/', '\\\\srv\\share\\x', '/'];
for (const pl of ['linux', 'darwin', 'win32']) for (const p of PATHS) await add(`tf:key:${pl}:${p}`, () => tf.geminiPathKey(p, pl));
for (const s of ['{"a":1}', '// c\n{"a":"//x"} /* y */', '{"a":"\\"/*"}', '/* open', '"unterminated \\', '{"k": "v"} // tail'])
  await add(`tf:strip:${JSON.stringify(s)}`, () => tf.stripJsonComments(s));
const BROAD = [
  ['linux', '/', '/home/u'], ['linux', '/home/u', '/home/u'], ['linux', '/home/u/Documents', '/home/u'], ['linux', '/home/u/p/x', '/home/u'],
  ['linux', '/home', '/home/u'], ['linux', '/srv/conv', '/home/u', ['/srv/conv', '']], ['darwin', '/Users/U/Desktop', '/users/u'],
  ['win32', 'C:\\', 'C:\\Users\\me'], ['win32', 'c:\\users\\ME', 'C:\\Users\\me'], ['win32', 'D:\\proj\\a', 'C:\\Users\\me'], ['win32', 'C:\\Users\\me\\Downloads', 'C:\\Users\\me'],
];
for (const [pl, f, h, extra] of BROAD) await add(`tf:broad:${pl}:${f}`, () => tf.isBroadGeminiFolder(f, h, extra ?? [], pl));

// trustGeminiFolder：真实文件系统
const proj = path.join(SB, 'proj', 'Repo');
fs.mkdirSync(proj, { recursive: true });
const tfFile = path.join(SB, 'gh', '.gemini', 'trustedFolders.json');
const envT = { GEMINI_CLI_HOME: path.join(SB, 'gh') };
const read = () => (fs.existsSync(tfFile) ? fs.readFileSync(tfFile, 'utf8') : null);
const tr = (name, folder, env = envT) => add(`tf:trust:${name}`, async () => ({ r: await tf.trustGeminiFolder(folder, { home: SB, env }), file: read() }));
await tr('blocked', proj, { ...envT, GEMINI_RESTRICTED_MODE: 'true' });
await tr('relative', 'proj');
await tr('missing', path.join(SB, 'nope'));
await tr('notDir', settings);
await tr('fresh', proj);
await tr('again', proj);
fs.writeFileSync(tfFile, `// keep\n{ "${proj.replace(/\\/g, '\\\\')}": "DO_NOT_TRUST", "/other": "TRUST_PARENT" }\n`);
await tr('flip', proj);
fs.writeFileSync(tfFile, '[1]');
await tr('malformed', proj);
fs.writeFileSync(tfFile, '   ');
await tr('blank', proj);
fs.rmSync(tfFile);
fs.mkdirSync(`${tfFile}.lock`, { recursive: true });
fs.utimesSync(`${tfFile}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
await tr('staleLock', proj);
await add('tf:trust:lockGone', () => fs.existsSync(`${tfFile}.lock`));
await tr('explicitPath', proj, { GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(SB, 'deep', 'dir', 't.json') });
await add('tf:trust:explicitFile', () => fs.readFileSync(path.join(SB, 'deep', 'dir', 't.json'), 'utf8'));

// 与 Go 测试相同的替换：SB 的转义形式、正斜杠形式、正斜杠小写形式（geminiPathKey）
const scrub = (txt) => {
  const esc = (x) => JSON.stringify(x).slice(1, -1);
  const fwd = SB.replace(/\\/g, '/');
  for (const f of [esc(fwd.toLowerCase()), esc(fwd), esc(SB)]) txt = txt.replaceAll(f, '<SB>');
  return txt;
};
const out = {
  platform: process.platform,
  cases: JSON.parse(scrub(JSON.stringify(cases))),
};
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'b7s.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${cases.length} b7s cases`);
process.exit(0);
