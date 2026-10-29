#!/usr/bin/env node
// 账号 golden 的假 CLI（kind 由录制 / 回放替换 @@KIND@@）；行为见同目录 <kind>.mode.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIND = '@@KIND@@';
const dir = path.dirname(fileURLToPath(import.meta.url));
const HOME_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', grok: 'GROK_HOME', gemini: 'GEMINI_CLI_HOME' }[KIND];
let mode = {};
try { mode = JSON.parse(fs.readFileSync(path.join(dir, `${KIND}.mode.json`), 'utf8')); } catch {}
const argv = process.argv.slice(2);
const home = process.env[HOME_VAR] ?? null;
fs.appendFileSync(path.join(dir, `${KIND}.log`), JSON.stringify({ argv, home, cwd: path.basename(process.cwd()), node: process.env.ELECTRON_RUN_AS_NODE ?? null, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? null }) + '\n');
const has = (...w) => w.every((x) => argv.includes(x));
const out = (s) => process.stdout.write(s);
const hang = () => setInterval(() => {}, 1000);

function lines(on) {
  let b = '';
  process.stdin.on('data', (d) => {
    b += d;
    let i;
    while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (l.trim()) on(l); }
  });
}

function doLogin() {
  const m = mode.login ?? 'ok';
  if (m === 'ok') process.exit(0);
  if (m === 'fail') { process.stderr.write('\x1b[31merror: one\x1b[0m\ntwo\nthree\nfour\n'); setTimeout(() => process.exit(3), 20); return; }
  if (m === 'quiet') process.exit(2);
  if (m === 'hang') { out(mode.text ?? 'Visit https://claude.ai/oauth/authorize?x=1\n'); hang(); return; }
  if (m === 'paste') {
    out('Opening \x1b]8;;https://claude.ai/oauth/authorize?code=true&state=s\x07link\x1b]8;;\x07\n\x1b[1mPaste code here if prompted >\x1b[0m ');
    lines((l) => { fs.writeFileSync(path.join(dir, `${KIND}.input`), JSON.stringify(l)); setTimeout(() => { out('Login successful.\n'); setTimeout(() => process.exit(mode.exit ?? 0), 20); }, 30); });
    return;
  }
  if (m === 'device') { out(mode.text); setTimeout(() => process.exit(mode.exit ?? 0), 50); return; }
}

if (KIND === 'gemini') {
  lines((l) => {
    const r = JSON.parse(l);
    if (r.id === undefined) return;
    const reply = (x) => out(JSON.stringify({ jsonrpc: '2.0', id: r.id, ...x }) + '\n');
    if (r.method === 'initialize') return reply({ result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] } });
    if (r.method === 'authenticate') {
      const m = mode.login ?? 'ok';
      if (m === 'crash') { process.stderr.write('gemini crashed\nbadly\n'); process.exit(4); }
      if (m === 'err') return reply({ error: { code: -32000, message: 'auth failed' } });
      if (m === 'hang') return;
      fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
      fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{}');
      fs.writeFileSync(path.join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: mode.email ?? 'G@x.io' }));
      return setTimeout(() => reply({ result: {} }), 20);
    }
    reply({ error: { code: -32601, message: 'nope' } });
  });
} else if (KIND === 'codex' && argv.includes('app-server')) {
  lines((l) => {
    const r = JSON.parse(l);
    if (r.id === undefined) return;
    const reply = (x) => out(JSON.stringify({ id: r.id, ...x }) + '\n');
    if (r.method === 'initialize') return reply({ result: {} });
    if (r.method === 'account/read') return reply(mode.account === undefined ? { error: { code: 1, message: 'x' } } : { result: { account: mode.account, requiresOpenaiAuth: true } });
    if (r.method === 'account/rateLimits/read') return reply(mode.limits ? { result: mode.limits } : { error: { code: 1, message: 'no limits' } });
    reply({ error: { code: -32601, message: 'nope' } });
  });
} else if (has('status')) {
  out(mode.status ?? '');
  process.exit(mode.statusCode ?? 0);
} else if (has('logout')) {
  process.exit(mode.logoutCode ?? 0);
} else if (has('login')) {
  doLogin();
} else {
  process.exit(9);
}
