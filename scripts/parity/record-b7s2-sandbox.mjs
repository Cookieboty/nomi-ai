#!/usr/bin/env node
/**
 * 批次 7s2：core/sandbox（platformSandbox / agentBrowserGuard / CodeSandbox）。
 * Go 侧 internal/core/sandbox/sandbox_parity_test.go 比对。宿主相关项（which / python / bwrap）现场录制。
 * Usage: node --import tsx scripts/parity/record-b7s2-sandbox.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { P, G, C, N } = await importSources(root, {
  P: path.join(root, 'apps/desktop-electron/internal/core/src/sandbox/platformSandbox.ts'),
  G: path.join(root, 'apps/desktop-electron/internal/core/src/sandbox/agentBrowserGuard.ts'),
  C: path.join(root, 'apps/desktop-electron/internal/core/src/sandbox/CodeSandbox.ts'),
  N: path.join(root, 'apps/desktop-electron/internal/core/src/security/netGuard.ts'),
});
const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/sandbox/testdata');
const err = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    return { err: String(e?.message ?? e) };
  }
};

// ── platformSandbox ──
const has = (set) => (p) => set.includes(p);
const allDirs = ['/usr', '/lib', '/lib64', '/lib32', '/bin', '/sbin', '/etc', '/proc', '/dev'];
const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-rec-')));
const realPyDir = path.join(fakeRoot, 'pybin');
fs.mkdirSync(realPyDir);
fs.writeFileSync(path.join(realPyDir, 'python3'), '');
const tok = (v) =>
  JSON.parse(JSON.stringify(v).split(JSON.stringify(fakeRoot).slice(1, -1)).join('@@ROOT@@'));
const bwrapCases = [
  { python: '/fake/py', scriptPath: '/t/main.py', tmpDir: '/t', ex: allDirs },
  {
    python: '/fake/py',
    scriptPath: '/t/main.py',
    tmpDir: '/t',
    allowNetwork: true,
    ex: ['/usr', '/proc'],
  },
  {
    python: '/fake/py',
    scriptPath: '/t/m.py',
    tmpDir: '/t',
    pythonArgs: ['-u'],
    ex: ['/dev', '/etc', '/lib64'],
  },
  { python: '/fake/py', scriptPath: '/t/m.py', tmpDir: '/t', pythonArgs: [], ex: [] },
  {
    python: path.join(realPyDir, 'python3'),
    scriptPath: '/t/m.py',
    tmpDir: '/sandbox-t',
    ex: ['/usr'],
  },
  { python: '/etc/passwd', scriptPath: '/t/m.py', tmpDir: '/sandbox-t', ex: ['/usr', '/etc'] },
  { python: path.join(realPyDir, 'nope'), scriptPath: '/t/m.py', tmpDir: '/sandbox-t', ex: [] },
  {
    python: path.join(realPyDir, 'python3'),
    scriptPath: '/t/m.py',
    tmpDir: fakeRoot,
    ex: ['/usr'],
  },
  { python: '/usr/bin/python3', scriptPath: '/t/m.py', tmpDir: '/t', ex: ['/usr'] },
  { python: '/bin/sh', scriptPath: '/t/m.py', tmpDir: '/t', ex: ['/bin'] },
].map((c) => ({ in: c, out: P.buildBwrapArgs({ ...c, existsSync: has(c.ex) }) }));
const seatbelt = [
  { tmpDir: '/t', python: '/usr/bin/python3' },
  { tmpDir: '/t"x\\y', python: '/p"q\\r', allowNetwork: true },
  { tmpDir: '/private/var/folders/a b', python: 'python3', allowNetwork: false },
].map((c) => ({ in: c, out: P.buildSeatbeltProfile(c) }));
const plans = [
  { platform: 'darwin', sandboxExecPath: null },
  { platform: 'darwin', sandboxExecPath: null, ex: ['/usr/bin/sandbox-exec'] },
  { platform: 'darwin', sandboxExecPath: '/opt/sbx' },
  { platform: 'darwin', ex: ['/usr/bin/sandbox-exec'] },
  { platform: 'darwin', sandboxExecPath: '', ex: ['/usr/bin/sandbox-exec'], allowNetwork: true },
  { platform: 'linux', bwrapPath: null },
  { platform: 'linux', bwrapPath: '/usr/bin/bwrap', ex: ['/usr', '/proc'] },
  { platform: 'linux', bwrapPath: '', ex: [] },
  { platform: 'linux', bwrapPath: '/b', allowNetwork: true, ex: allDirs },
  { platform: 'win32' },
  { platform: 'freebsd', bwrapPath: '/b' },
].map((c) => {
  const o = {
    python: '/fake/py',
    scriptPath: '/t/main.py',
    tmpDir: '/t',
    ...c,
    existsSync: has(c.ex ?? []),
  };
  delete o.ex;
  return { in: c, out: P.planPythonSandbox(o) };
});
// 宿主相关
const host = {
  findMissing: P.findOnPath('definitely-missing-nomi-xyz'),
  findBwrap: P.findOnPath('bwrap'),
  findSandboxExec: P.findOnPath('sandbox-exec'),
  available: P.pythonPlatformSandboxAvailable(),
  availableWin: P.pythonPlatformSandboxAvailable('win32'),
  availableAix: P.pythonPlatformSandboxAvailable('aix'),
  planHost: P.planPythonSandbox({
    python: '/fake/py',
    scriptPath: '/t/main.py',
    tmpDir: '/t',
    existsSync: () => false,
  }),
};

// ── agentBrowserGuard ──
const urls = [
  'https://example.com/a?b#c',
  'http://example.com',
  'HTTPS://Example.COM:443/x',
  'ws://example.com/s',
  'WSS://example.com:8443/s',
  'about:blank',
  'data:text/html,hi',
  'blob:https://example.com/uuid',
  'chrome-error://chromewebdata/',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'ftp://example.com/',
  'chrome://settings',
  'mailto:a@b.c',
  'view-source:https://a.com',
  'not a url',
  '',
  '   ',
  '//example.com',
  '1http://x',
  'http://',
  'http://[::1',
  'https://exa mple.com',
  'http://localhost:3000',
  'http://127.0.0.1',
  'http://127.1',
  'http://2130706433/',
  'http://0x7f.1/',
  'http://0177.0.0.1/',
  'http://10.0.0.1',
  'http://192.168.1.1',
  'http://172.16.0.1',
  'http://172.32.0.1',
  'http://169.254.169.254/latest',
  'http://100.64.0.1',
  'http://8.8.8.8',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[fe80::1]/',
  'http://[2001:db8::1]/',
  'http://[64:ff9b::a00:1]/',
  'ws://localhost/x',
  'wss://10.1.2.3/',
  'http://user:pw@example.com',
  'http://user@example.com',
  'http://:pw@example.com',
  'http://@example.com',
  'https://foo.local/',
  'https://a.localhost/',
  'http://example.com./',
  ' https://example.com ',
  '\thttps://example.com/\n',
  'https://例子.测试/',
  'https://xn--fsqu00a.xn--0zwm56d/',
  'http://0.0.0.0',
  'http://224.0.0.1',
  'http://255.255.255.255',
  'http://example.com:99999',
  'http://example.com:80/',
  'https:example.com',
  'http:\\\\example.com\\a',
  'ws://[::1]:9/',
  'file://[bad/x',
  'file://exa mple/x',
  'file://host/x',
  'file://u@h/x',
  'file://host/a@b:c',
  'file://h?q@x:1',
  'file://h:8/x',
  'file://[::1]/x',
  'file://localhost/x',
  'file:\\\\[bad\\x',
  'file:/x',
  'file:x',
  'ws://[bad/',
  'ftp://[bad/',
  'ftp://10.0.0.1/',
  'a+b://x',
  'a-b.c://x',
  '\x01https://example.com\x02',
  'ht\ttp://10.0.0.1',
  'h\nttps://exa\rmple.com/',
  'ws://u:p@example.com/',
];
const sync = urls.map((u) => ({ in: u, out: G.checkRequestUrlSync(u) }));
const assertCases = urls.map((u) => ({ in: u, out: err(() => N.assertPublicHttpUrl(u).hostname) }));
const dnsTable = {
  'example.com': [{ address: '93.184.216.34', family: 4 }],
  'rebind.test': [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.5', family: 4 },
  ],
  'v6.test': [{ address: '::1', family: 6 }],
  'empty.test': [],
  'pub6.test': [{ address: '2606:2800:220:1::', family: 6 }],
  'mapped.test': [{ address: '::ffff:192.168.0.1', family: 6 }],
};
const lookups = [];
const lookupAll = async (h) => {
  lookups.push(h);
  if (h === 'boom.test') throw new Error('getaddrinfo ENOTFOUND boom.test');
  if (h === 'odd.test') throw 'plain string';
  return dnsTable[h] ?? [{ address: '1.1.1.1', family: 4 }];
};
const guard = G.createRequestGuard({ lookupAll });
const steps = [];
const dec = async (u) =>
  steps.push({
    op: 'decide',
    in: u,
    out: await guard.decideRequest(u),
    lookups: lookups.splice(0),
  });
const con = (u, ip) =>
  steps.push({
    op: 'connected',
    in: u,
    ip: ip ?? null,
    out: guard.onConnected(u, ip),
    blocked: [...guard.blockedHosts],
  });
for (const u of [
  'https://example.com/',
  'wss://Example.com/s',
  'https://rebind.test/',
  'https://v6.test',
  'https://empty.test',
  'https://pub6.test',
  'https://mapped.test',
  'https://boom.test',
  'https://odd.test',
  'http://8.8.8.8/',
  'http://[2606:4700::1]/',
  'about:blank',
  'file:///x',
  'http://10.0.0.1/',
  'https://other.test/x',
])
  await dec(u);
con('https://other.test/x', '93.1.1.1');
con('https://other.test/x', undefined);
con('https://other.test/x', '');
con('https://Other.Test/y', '10.0.0.9');
await dec('https://other.test/z');
await dec('wss://OTHER.test/z');
con('not a url', '127.0.0.1');
con('http://[2606:4700::1]/', '::1');
await dec('http://[2606:4700::1]/q');
con('about:blank', '192.168.0.1');
con('chrome-error://ChromeWebData:9/x', '10.0.0.1');
con('mailto:a@b.c', '10.0.0.1');
con('ws://sock.test/', 'fe80::1');
con('foo://u:p@Opaque.Test:8/x', '10.0.0.2');
con('bar://user@op2.test/', '10.0.0.3');
await dec('https://sock.test/');
await dec('https://fresh.test/');
const g2 = G.createRequestGuard({ lookupAll });
steps.push({
  op: 'fresh',
  out: await g2.decideRequest('https://other.test/z'),
  lookups: lookups.splice(0),
});

// ── CodeSandbox ──
const sbx = new C.CodeSandbox({ nodeBin: process.execPath, runAsNode: false });
const strip = (r) => {
  const { ms, ...rest } = r;
  return { ...rest, msOk: typeof ms === 'number' && ms >= 0 };
};
const tmpTok = (s) => s.replace(/[^\s'"`]*cd-sbx-[A-Za-z0-9]+/g, '@@TMP@@');
const jsCases = [
  { name: 'hello', code: 'console.log("hi"); console.error("err")', timeoutMs: 10000 },
  { name: 'exit3', code: 'process.exit(3)', timeoutMs: 10000 },
  {
    name: 'stdin',
    code: 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(d.toUpperCase()))',
    timeoutMs: 10000,
    stdin: 'abc\nxyz',
  },
  { name: 'stdin-ignored', code: 'console.log(1)', timeoutMs: 10000, stdin: 'x'.repeat(200000) },
  {
    name: 'env',
    code: 'const e=process.env;console.log(JSON.stringify(Object.keys(e).filter(k=>!/^(PATH|SYSTEMROOT|WINDIR|LANG|TZ|Path)$/i.test(k)).sort()));console.log(e.HOME===process.cwd(), e.TMP===e.TEMP, e.TMPDIR===e.HOME, "ELECTRON_RUN_AS_NODE" in e)',
    timeoutMs: 10000,
  },
  {
    name: 'cwd',
    code: 'const fs=require("fs");fs.writeFileSync("o.txt","w");console.log(fs.readdirSync(".").sort().join(","))',
    timeoutMs: 10000,
  },
  {
    name: 'fs-denied',
    code: 'try{require("fs").readdirSync(require("os").homedir()+"/..");console.log("READ")}catch(e){console.log(e.code)}',
    timeoutMs: 10000,
  },
  {
    name: 'child-denied',
    code: 'try{require("child_process").execSync("echo hi");console.log("RAN")}catch(e){console.log(e.code)}',
    timeoutMs: 10000,
  },
  {
    name: 'eval-denied',
    code: 'try{eval("1+1");console.log("EVAL")}catch(e){console.log(e.name)}',
    timeoutMs: 10000,
  },
  { name: 'timeout', code: 'setInterval(()=>{},1000)', timeoutMs: 400 },
  { name: 'trunc', code: 'process.stdout.write("x".repeat(30000))', timeoutMs: 10000 },
  { name: 'trunc-exact', code: 'process.stdout.write("y".repeat(20000))', timeoutMs: 10000 },
  { name: 'trunc-plus1', code: 'process.stdout.write("z".repeat(20001))', timeoutMs: 10000 },
  {
    name: 'trunc-later',
    code: 'process.stdout.write("a".repeat(20000));setTimeout(()=>process.stdout.write("b"),200)',
    timeoutMs: 10000,
  },
  { name: 'unicode', code: 'console.log("é中😀".repeat(3))', timeoutMs: 10000 },
  { name: 'throw', code: 'throw new Error("boom-x")', timeoutMs: 10000 },
];
const js = [];
for (const c of jsCases) {
  const r = strip(await sbx.run('javascript', c.code, { timeoutMs: c.timeoutMs, stdin: c.stdin }));
  if (c.name === 'throw') r.stderr = r.stderr.includes('boom-x') ? 'HAS boom-x' : r.stderr;
  r.stdout = tmpTok(r.stdout);
  r.stderr = tmpTok(r.stderr);
  js.push({ ...c, out: r });
}
const ac = new AbortController();
const pAbort = sbx.run('javascript', 'setInterval(()=>{},1000)', { timeoutMs: 20000 }, ac.signal);
setTimeout(() => ac.abort(), 300);
js.push({
  name: 'abort',
  code: 'setInterval(()=>{},1000)',
  timeoutMs: 20000,
  abortMs: 300,
  out: strip(await pAbort),
});
const sbxE = new C.CodeSandbox({ nodeBin: process.execPath });
const envCode = 'console.log(process.env.ELECTRON_RUN_AS_NODE ?? "unset")';
const envRes = strip(await sbxE.run('javascript', envCode, { timeoutMs: 10000 }));
js.push({ name: 'run-as-node', code: envCode, timeoutMs: 10000, runAsNode: true, out: envRes });
const missing = new C.CodeSandbox({ nodeBin: path.join(fakeRoot, 'no-node'), runAsNode: false });
const mres = strip(await missing.run('javascript', '1', { timeoutMs: 2000 }));
js.push({
  name: 'missing-bin',
  code: '1',
  timeoutMs: 2000,
  out: { ...mres, stderr: tok(mres.stderr) },
});
const avail = await sbx.available();
const py = [];
if (avail.includes('python')) {
  for (const c of [
    { name: 'py-hello', code: 'import sys\nprint("hi")\nprint("e", file=sys.stderr)' },
    { name: 'py-exit', code: 'raise SystemExit(4)' },
    { name: 'py-stdin', code: 'import sys\nprint(sys.stdin.read()[::-1])', stdin: 'abc' },
    { name: 'py-utf8', code: 'print("中文")' },
    { name: 'py-env', code: 'import os\nprint(os.environ.get("PYTHONIOENCODING"))' },
  ]) {
    const r = strip(await sbx.run('python', c.code, { timeoutMs: 15000, stdin: c.stdin }));
    py.push({ ...c, out: { ...r, stdout: tmpTok(r.stdout), stderr: tmpTok(r.stderr) } });
  }
}
const env = C.minimalEnv('/T', { X: '1', HOME: '/override' });
const keep = ['PATH', 'SYSTEMROOT', 'WINDIR', 'LANG', 'TZ'].filter((k) => process.env[k]);
const minimal = {
  keys: Object.keys(env),
  home: env.HOME,
  x: env.X,
  tmp: env.TMP,
  keptMatch: keep.every((k) => env[k] === process.env[k]),
};
const minimal2 = Object.keys(C.minimalEnv('/T'));

fs.rmSync(fakeRoot, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const golden = tok({
  bwrapCases,
  seatbelt,
  plans,
  host,
  sync,
  assertCases,
  steps,
  js,
  avail,
  py,
  minimal,
  minimal2,
  platform: process.platform,
});
fs.writeFileSync(path.join(outDir, 'b7s2-sandbox.json'), JSON.stringify(golden, null, 2) + '\n');
console.log(
  `b7s2-sandbox: ${bwrapCases.length} bwrap, ${seatbelt.length} seatbelt, ${plans.length} plans, ${sync.length} urls, ${steps.length} guard steps, ${js.length} js, ${py.length} py`,
);
