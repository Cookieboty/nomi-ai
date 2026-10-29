#!/usr/bin/env node
/**
 * CliPluginHost golden（Go 回放：internal/core/cli/cli_plugin_host_parity_test.go）。
 * 场景 = {name, deps, plugins, files, steps}；插件清单直接写进 golden（内置插件清单 JSON 克隆），
 * main = 'none' | 'ok' | 'throw:<msg>'；外部 CLI 用 node 跑 golden 里的脚本。
 *
 * Usage: node --import tsx scripts/parity/record-b7s-host.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { CliPluginHost, inRange } = await import(pathToFileURL(path.join(root, 'packages/core/src/cli/CliPluginHost.ts')).href);
const { BUILTIN_PLUGINS } = await import(pathToFileURL(path.join(root, 'packages/cli-plugins/src/main.ts')).href);

const T = '@@SB@@';
const clone = (x) => JSON.parse(JSON.stringify(x));
const M = Object.fromEntries(Object.entries(BUILTIN_PLUGINS).map(([k, p]) => [k, clone(p.manifest)]));

const ACP_OK = `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentInfo:{name:' Mock Agent ',version:'1.2.3',title:''},agentCapabilities:{loadSession:true,promptCapabilities:{image:false,audio:true}},authMethods:[{id:'key'}],argv:process.argv.slice(2)}})+'\\n');}});`;
const ACP_ERR = `let b='';process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i);b=b.slice(i+1);if(!l.trim())continue;const m=JSON.parse(l);
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'auth required'}})+'\\n');}});`;

const ext = (o = {}) => ({ version: 1, id: 'my-agent', displayName: 'My Agent', command: 'my-agent', args: ['--acp', '{cwd}', '{home}/x'], env: ['MY_KEY', 'OTHER_KEY'], ...o });
const D0 = { home: `${T}/home`, env: { MY_KEY: 'k', OTHER_KEY: '' }, platform: 'linux', version: { grok: '1.0.60', claude: null, codex: 'throw' } };
const badManifest = { ...M.grok, id: 'Bad Id' };

const scenarios = [
  { name: 'pure', steps: [
    ...[['1.2.3', '>=1.0.0'], ['1.2.3', '>=1.0.0 <1.2.3'], ['1.2.3', ' >1.2.2   <=1.2.3 '], ['v1.2.3', '=1.2.3'], ['1.2.3', '1.2.3'], ['1.2.3', 'v1.2.3'],
      ['1.2.3', ''], ['1.2.3', '>= 1.2.3'], ['1.2.3', '~1.2.3'], ['1.2', '>=1.0.0'], ['grok 2.0.1 (abc)', '<3.0.0'], ['1.2.3-beta', '<1.2.3'],
      ['10.0.0', '>9.99.99'], ['1.2.3', '>=1.2.3'], ['1.2.3', '<=1.2.3'], ['1.2.3', '=1.2.3'], ['1.2.3', '>1.2.3'], ['1.2.3', '>=1.2'], ['1.2.3', '\u00a0>=1.0.0\u3000<2.0.0']].map(([v, r]) => ['inRange', v, r]),
  ] },
  { name: 'injected', deps: { ...D0, extend: true }, plugins: [
    { key: 'grok', manifest: M.grok, main: 'ok' }, { key: 'claude', manifest: M.claude, main: 'none' },
    { key: 'codex', manifest: M.codex, main: 'throw:factory exploded' }, { key: 'broken', manifest: badManifest, main: 'ok' },
    { key: 'dup', manifest: M.grok, main: 'ok' }, { key: 'nomani', manifest: null, main: 'ok' },
  ], steps: [
    ['start'], ['tick'], ['calls'], ['snapshot'], ['start'], ['calls'],
    ...['grok', 'claude', 'codex', 'Bad Id', 'grok#dup', 'nomani', 'missing'].flatMap((id) => [['impl', id], ['manifest', id], ['caps', id]]),
    ['handshake', 'grok', { images: false, resume: false, bogus: false, fork: 'no' }], ['caps', 'grok'], ['handshake', 'missing', { images: false }],
    ['handshake', 'grok', { resume: true }], ['caps', 'grok'], ['calls'],
    ['setVersion', 'grok', '1.0.61'], ['setVersion', 'claude', '2.0.0'], ['setVersion', 'codex', '0.5.0'], ['refresh'], ['calls'],
    ['refresh'], ['calls'], ['setVersion', 'grok', null], ['refresh'], ['setVersion', 'grok', '1.0.62'], ['refresh'], ['calls'],
    ['remove', 'grok'], ['remove', 'Bad Id'], ['remove', 'missing'], ['stop'], ['snapshot'], ['impl', 'grok'], ['start'], ['tick'], ['snapshot'], ['calls'],
  ] },
  { name: 'versionHookThrows', deps: { ...D0, versionHook: 'throw' }, plugins: [{ key: 'grok', manifest: M.grok, main: 'ok' }], steps: [
    ['start'], ['tick'], ['setVersion', 'grok', '1.0.70'], ['refresh'], ['calls'], ['caps', 'grok'],
  ] },
  { name: 'noVersion', deps: { home: `${T}/home`, env: {}, platform: 'darwin' }, plugins: [{ key: 'grok', manifest: M.grok, main: 'ok' }], steps: [
    ['start'], ['tick'], ['refresh'], ['calls'], ['caps', 'grok'],
  ] },
  { name: 'externals', deps: { ...D0, removedHook: true }, plugins: [{ key: 'grok', manifest: M.grok, main: 'none' }],
    files: [
      { p: 'root/external/a-good.json', text: JSON.stringify(ext({ id: 'a-good', displayName: 'A Good' })) },
      { p: 'root/external/b-bad.json', text: '{nope' },
      { p: 'root/external/c-mismatch.json', text: JSON.stringify(ext({ id: 'other' })) },
      { p: 'root/external/grok.json', text: JSON.stringify(ext({ id: 'grok' })) },
      { p: 'root/external/d-invalid.json', text: JSON.stringify({ id: 'd-invalid', command: '' }) },
      { p: 'root/external/readme.txt', text: 'ignored' },
    ], steps: [
      ['start'], ['tick'], ['calls'], ['snapshot'], ['extSpec', 'a-good'], ['extSpec', 'b-bad'], ['extSpec', 'grok'], ['caps', 'a-good'], ['impl', 'a-good'],
      ['add', ext()], ['calls'], ['ls', 'root/external'], ['add', ext({ displayName: 'Renamed', env: [] })], ['snapshot'],
      ['add', ext({ id: 'claude' })], ['add', ext({ id: 'nomi' })], ['add', 'str'], ['add', ext({ args: ['{other}'] })], ['add', { id: 'x' }],
      ['remove', 'b-bad'], ['remove', 'my-agent'], ['remove', 'my-agent'], ['remove', 'grok'], ['calls'], ['ls', 'root/external'],
      ['handshake', 'a-good', { images: false }], ['caps', 'a-good'], ['setVersion', 'a-good', '9.9.9'], ['refresh'], ['calls'],
    ] },
  { name: 'removeHookThrows', deps: { ...D0, removedHook: 'throw', externalDir: `${T}/ext2` }, plugins: [],
    files: [{ p: 'ext2/z.json', text: JSON.stringify(ext({ id: 'z' })) }], steps: [['start'], ['tick'], ['remove', 'z'], ['calls'], ['ls', 'ext2']] },
  { name: 'testExternal', deps: { ...D0, spawn: 'node' }, plugins: [],
    files: [{ p: 'acp-ok.js', text: ACP_OK }, { p: 'acp-err.js', text: ACP_ERR }], steps: [
      ['test', ext({ command: `${T}/acp-ok.js` }), `${T}/work`], ['calls'],
      ['test', ext({ command: `${T}/acp-err.js` }), `${T}/work`], ['calls'],
      ['test', ext({ command: 'claude', id: 'claude' }), `${T}/work`], ['test', { id: 'x' }, `${T}/work`], ['calls'],
      ['testTemp', ext({ command: `${T}/acp-ok.js`, args: [] })], ['calls'],
    ] },
  { name: 'testSpawnThrows', deps: { ...D0, spawn: 'throw' }, plugins: [], steps: [['test', ext(), `${T}/work`], ['calls']] },
  { name: 'testNoSpawn', deps: D0, plugins: [], steps: [['test', ext(), `${T}/work`], ['calls']] },
  { name: 'builtin', deps: { home: `${T}/home`, env: {}, platform: 'linux', builtin: true }, steps: [
    ['start'], ['tick'], ['snapshot'], ['impl', 'claude'], ['impl', 'grok'], ['add', ext({ id: 'dsh' })], ['add', ext({ id: 'nomi' })], ['calls'],
  ] },
];

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sortKeys(v[k])]));
  return v;
}

async function run(sc) {
  const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7shost-')));
  const sub = (x) => (typeof x === 'string' ? x.replaceAll(T, SB) : Array.isArray(x) ? x.map(sub) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)])) : x);
  fs.mkdirSync(path.join(SB, 'work'), { recursive: true });
  fs.mkdirSync(path.join(SB, 'home'), { recursive: true });
  for (const f of sc.files ?? []) {
    const p = path.join(SB, ...f.p.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text);
  }
  const out = [];
  let host = null;
  let calls = [];
  const d = sc.deps;
  const versions = { ...(d?.version ?? {}) };
  if (d) {
    const plugins = d.builtin ? undefined : Object.fromEntries(sc.plugins.map((p) => [p.key, {
      manifest: clone(p.manifest),
      ...(p.main === 'none' ? {} : {
        main: async (ctx) => {
          calls.push(['main', p.key, { dataDir: ctx.dataDir, home: ctx.home, platform: ctx.platform, env: ctx.env }]);
          if (p.main.startsWith('throw:')) throw new Error(p.main.slice(6));
          return {};
        },
      }),
    }]));
    host = new CliPluginHost({
      logger: { info: (m, x) => calls.push(['info', m, x]), warn: (m, x) => calls.push(['warn', m, x]) },
      root: path.join(SB, 'root'),
      ...(plugins ? { plugins } : {}),
      home: sub(d.home),
      env: d.env,
      platform: d.platform,
      ...(d.version ? { version: async (id) => { calls.push(['version', id]); const v = versions[id]; if (v === 'throw') throw new Error('no cli'); return v ?? null; } } : {}),
      ...(d.extend ? { extend: (id, impl) => { calls.push(['extend', id]); return impl; } } : {}),
      events: { publish: (ev, p) => calls.push(['publish', ev, p.plugins.map((x) => `${x.id}:${x.status}:${x.version}`)]) },
      ...(d.versionHook ? { onVersionChange: (id, a, b) => { calls.push(['versionChange', id, a, b]); if (d.versionHook === 'throw') throw new Error('hook boom'); } } : {}),
      ...(d.externalDir ? { externalDir: sub(d.externalDir) } : {}),
      ...(d.removedHook ? { onExternalRemoved: (id) => { calls.push(['removed', id]); if (d.removedHook === 'throw') throw new Error('rm boom'); } } : {}),
      ...(d.spawn ? { spawnExternal: (cmd, args, cwd) => {
        calls.push(['spawn', cmd, args, /[\\/]nomi-cli-test-[^\\/]+$/.test(cwd) ? `<TMP>:${fs.existsSync(cwd)}` : cwd]);
        if (d.spawn === 'throw') throw new Error('spawn blew up');
        return spawn(process.execPath, [cmd, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      } } : {}),
    });
  }
  for (const st of sc.steps) {
    const [op, ...a] = sub(st);
    let r;
    try {
      switch (op) {
        case 'inRange': r = inRange(a[0], a[1]); break;
        case 'start': r = await host.start(); break;
        case 'tick': await new Promise((res) => setTimeout(res, 20)); break;
        case 'calls': r = calls; calls = []; break;
        case 'snapshot': r = host.snapshot(); break;
        case 'impl': r = host.impl(a[0]) !== undefined; break;
        case 'manifest': r = host.manifest(a[0]); break;
        case 'caps': r = host.capabilities(a[0]); break;
        case 'extSpec': r = host.externalSpec(a[0]); break;
        case 'handshake': r = host.setHandshake(a[0], a[1]); break;
        case 'setVersion': versions[a[0]] = a[1]; break;
        case 'refresh': r = await host.refreshVersions(); break;
        case 'remove': r = host.removeExternal(a[0]); break;
        case 'stop': r = host.stop(); break;
        case 'add': r = host.addExternal(a[0]); break;
        case 'test': r = await host.testExternal(a[0], a[1]); break;
        case 'testTemp': r = await host.testExternalInTemp(a[0]); break;
        case 'ls': r = fs.readdirSync(path.join(SB, ...a[0].split('/'))).sort(); break;
        default: throw new Error(`bad op ${op}`);
      }
      out.push(r === undefined ? { undef: true } : { v: r });
    } catch (e) {
      out.push({ err: e instanceof Error ? e.message : String(e) });
    }
  }
  const js = JSON.stringify(SB).slice(1, -1);
  const txt = JSON.stringify(sortKeys(out)).replaceAll(js, '<SB>');
  fs.rmSync(SB, { recursive: true, force: true });
  return { name: sc.name, deps: sc.deps ?? null, plugins: sc.plugins ?? null, files: sc.files ?? [], steps: sc.steps, out: JSON.parse(txt) };
}

const result = [];
for (const sc of scenarios) result.push(await run(sc));
const dir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'b7s-host.json');
fs.writeFileSync(file, JSON.stringify({ platform: process.platform, scenarios: result }, null, 1) + '\n');
console.log(`b7s-host: ${result.length} scenarios, ${result.reduce((n, s) => n + s.steps.length, 0)} steps → ${file}`);
process.exit(0);
