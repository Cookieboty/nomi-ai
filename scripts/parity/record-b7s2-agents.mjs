#!/usr/bin/env node
/**
 * 批次 7s2：agents（AgentProgressService + processes 纯函数）。
 * Go 侧 internal/core/agents/service_parity_test.go 比对。
 * 输出：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/agents/testdata。
 * Usage: node --import tsx scripts/parity/record-b7s2-agents.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { A, P } = await importSources(root, {
  A: path.join(root, 'packages/core/src/agents/AgentProgressService.ts'),
  P: path.join(root, 'packages/core/src/agents/processes.ts'),
});

// ── 纯函数 ──
const raws = [
  { pid: 1, name: 'claude', cmd: 'claude --resume' },
  { pid: 2, name: 'node', cmd: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' },
  { pid: 3, name: 'codex', cmd: 'codex exec' },
  { pid: 4, name: 'grep', cmd: 'grep claude' },
  { pid: 5, name: 'node', cmd: 'node /x/@google/gemini-cli/dist/index.js' },
  { pid: 6, name: 'dsh', cmd: 'dsh run' },
  { pid: 7, name: 'grok.exe', cmd: 'C:\\bin\\grok.exe chat' },
  { pid: 8, name: 'node', cmd: 'node /x/@xai-official/grok/bin.js' },
  { pid: 9, name: 'vim', cmd: 'vim claude.md' },
  { pid: 10, name: 'Codex', cmd: '/Applications/Codex.app/Contents/MacOS/Codex' },
  { pid: 11, name: 'rg.EXE', cmd: 'rg codex' },
  { pid: 12, name: 'gemini', cmd: 'gemini' },
  { pid: 13, name: 'node', cmd: 'node /x/@anthropic-ai/claude-code/cli.js /x/@google/gemini-cli/a.js codex' },
  { pid: 99, name: 'claude', cmd: 'claude' },
];
const classify = { in: raws, self: 99, out: P.classify(raws, 99) };
const psIn = [
  '  PID COMM ARGS',
  '  101 /usr/local/bin/claude claude --print hi',
  '102 codex',
  '  103   /opt/x/node   node /x/@google/gemini-cli/a.js  ',
  'abc def',
  '104\tdsh\tdsh  -v',
  '',
].join('\n');
const winIns = [
  '[{"ProcessId":5,"Name":"claude.exe","CommandLine":"claude.exe -p"},{"ProcessId":"6","Name":"x"},null,{"ProcessId":7,"Name":"Codex.EXE"},{"ProcessId":8}]',
  '{"ProcessId":9,"Name":"grok.exe","CommandLine":null}',
  'not json',
  'null',
  '[]',
  '[5,"s",[1],true,{"ProcessId":7,"Name":"a.exe"}]',
];
const locksIn = [
  '1: FLOCK  ADVISORY  WRITE 103198 00:2f:1680557 0 EOF',
  '2: POSIX  ADVISORY  READ 1 fd:01:42 0 EOF',
  '3: LEASE  ACTIVE  READ 1 fd:01:43 0 EOF',
  '4: OFDLCK ADVISORY WRITE -1 08:0A:99 0 EOF',
  '5: FLOCK ADVISORY WRITE 1 zz:01:5 0 EOF',
].join('\n');
const sanitizeIn = [
  undefined, null, 'x', {}, { enabled: false, stallMs: 1000, cooldownMs: 5, summaryEnabled: 1 },
  { enabled: 'yes', stallMs: 10_000, cooldownMs: 0, summaryEnabled: true, tools: { codex: false, bogus: false, grok: 'no' } },
  { stallMs: 1e12, cooldownMs: -1, tools: null }, { stallMs: 60_000.5, cooldownMs: 600_000, tools: [] },
  { stallMs: 'NaN', tools: { claude: false, dsh: false, gemini: 0 } },
];
const long = '这是一段很长的任务描述。'.repeat(14);
const withCostIn = [
  ['short', null], ['short', '本次花费 ¥0.12'], [long, null], [long, '本次花费 ¥1.50'],
  ['x', 'c'.repeat(140)], ['x', 'c'.repeat(139)], [long + '   ', 'c'.repeat(100)], ['😀'.repeat(80), 'cost'], ['word '.repeat(40), 'c'.repeat(18)], ['ab '.repeat(50), 'c'.repeat(30)],
];
const tabsIn = [
  { id: 't1', backend: 'claude', title: 'Tab', status: 'running', unread: 0, cwd: '/w/app', updatedAt: 5 },
  { id: 't2', backend: 'nomi', title: 'Q', status: 'queued', unread: 3, cwd: '', updatedAt: 6, lastError: 'e' },
  { id: 't3', backend: 'codex', title: 'E', status: 'error', unread: 1, cwd: '/w/svc/', updatedAt: 7, lastError: 'boom' },
  { id: 't4', backend: 'gemini', title: 'D', status: 'idle', unread: 2, updatedAt: 8 },
  { id: 't5', backend: 'grok', title: 'W', status: 'idle', unread: 0, cwd: 'rel/dir', updatedAt: 9 },
];
const pure = {
  classify,
  parsePs: { in: psIn, out: P.parsePs(psIn) },
  parseWinJson: winIns.map((s) => ({ in: s, out: P.parseWinJson(s) })),
  parseProcLocks: { in: locksIn, out: [...P.parseProcLocks(locksIn)] },
  sanitize: sanitizeIn.map((r) => ({ in: r === undefined ? '__undef' : r, out: A.sanitizeAgentWatch(r) })),
  withCost: withCostIn.map(([t, c]) => ({ text: t, cost: c, out: A.withCost(t, c) })),
  tabView: tabsIn.map((t) => ({ in: t, out: A.tabView(t) })),
};

// ── 服务场景 ──
const NOW0 = 1_800_000_000_000;
const iso = (ms) => new Date(ms).toISOString();
const uuid = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const fixture = [
  { rel: '.claude/projects/-w-app/c1.jsonl', age: 10_000, content: [
    { type: 'user', cwd: '/w/app', sessionId: 'c1', timestamp: iso(NOW0 - 60_000), message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'assistant', cwd: '/w/app', sessionId: 'c1', timestamp: iso(NOW0 - 10_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ] },
  { rel: '.claude/projects/-w-app/c1/subagents/agent-1.jsonl', age: 5_000, content: [
    { type: 'user', cwd: '/w/app', sessionId: 'sub1', isSidechain: true, timestamp: iso(NOW0 - 5_000), message: { role: 'user', content: 'sub task' } },
  ] },
  { rel: '.claude/projects/-w-old/old.jsonl', age: 4 * 86_400_000, content: [{ type: 'user', cwd: '/w/old', sessionId: 'old', message: { role: 'user', content: 'old' } }] },
  { rel: '.claude/projects/-w-x/nc.jsonl', age: 15_000, content: [{ type: 'user', sessionId: 'nc', timestamp: iso(NOW0 - 15_000), message: { role: 'user', content: 'no cwd' } }] },
  { rel: `.codex/sessions/2027/01/15/rollout-2027-01-15T00-00-00-${uuid}.jsonl`, age: 20 * 60_000, content: [
    { type: 'session_meta', payload: { id: uuid, cwd: '/w/svc' }, timestamp: iso(NOW0 - 30 * 60_000) },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Add pagination' }, timestamp: iso(NOW0 - 25 * 60_000) },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Added pagination to /users' }, timestamp: iso(NOW0 - 20 * 60_000) },
  ] },
  { rel: '.gemini/tmp/abc/chats/session-2027-01-15.json', age: 2 * 3_600_000, raw: JSON.stringify({ sessionId: 'g1', messages: [{ type: 'user', content: 'Explain repo' }, { type: 'gemini', content: 'It is a monorepo.' }] }) },
  { rel: '.gemini/tmp/abc/notes/session-x.json', age: 1000, raw: '{}' },
  { rel: '.grok/sessions/%2Fw%2Fgrok%20proj/gs1/updates.jsonl', age: 60_000, raw: '{"x":1}\n' },
  { rel: '.dsh/sessions/d1/session.v2.jsonl', age: 30_000, raw: '{"t":1}\n' },
  { rel: '.dsh/sessions/d1/session.lock', age: 35_000, raw: '' },
  { rel: '.dsh/storages/session_projcache/sessions/d1.json', age: 30_000, raw: JSON.stringify({ cwd: '/w/dsh', title: 'dsh task', permissionMode: 'auto' }) },
  { rel: '.dsh/sessions/d2/session.v1.jsonl', age: 40_000, raw: '{"t":1}\n' },
];
const appendClaude = { type: 'assistant', cwd: '/w/app', sessionId: 'c1', timestamp: iso(NOW0 + 600_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixed: the ```js\nx\n``` token check   was wrong.' }] } };

const appendTool = { type: 'assistant', cwd: '/w/app', sessionId: 'c1', timestamp: iso(NOW0 + 900_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'make' } }] } };
const appendDone = { type: 'assistant', cwd: '/w/app', sessionId: 'c1', timestamp: iso(NOW0 + 1_200_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Need your input.' }] } };
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-agents-'));
const H = fs.realpathSync(home);
const write = (f, now) => {
  const p = path.join(H, f.rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, f.raw ?? f.content.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const t = (now - f.age) / 1000;
  fs.utimesSync(p, t, t);
};
for (const f of fixture) write(f, NOW0);
const scrub = (v) => JSON.parse(JSON.stringify(v ?? null).split(JSON.stringify(H).slice(1, -1)).join('<H>').replace(/\\\\/g, '/'));

let now = NOW0;
let procs = [{ pid: 1, kind: 'claude', cwd: '/w/app' }, { pid: 2, kind: 'gemini', cwd: '' }, { pid: 3, kind: 'codex' }, { pid: 4, kind: 'claude', cwd: '/w/old' }];
const lockIno = fs.statSync(path.join(H, '.dsh/sessions/d1/session.lock')).ino;
let locks = new Set([lockIno]);
const log = [];
const events = { publish: (ev, p) => log.push(['event', ev, p ?? null]) };
const sortKeys = (o) => Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, o[k]]));
const desktop = { notify: (n) => log.push(['notice', sortKeys(n)]) };
const logger = { info: (m, d) => log.push(['info', m, d ?? null]), warn: (m, d) => log.push(['warn', m, d ?? null]) };
const svc = new A.AgentProgressService({
  root: path.join(H, 'userData/agents'), logger, events, desktop, home: H, now: () => now, pollMs: 1e9, digestMs: 1e9,
  processes: () => procs, lockedInodes: () => locks, dshHome: path.join(H, '.dsh'), grokHome: path.join(H, '.grok'),
  isQuiet: () => false,
  usageOf: (s, id) => (s === 'claude' && id === 'c1' ? { tokens: 42, cost: 0.5 } : null),
  taskCost: async (q) => (q.source === 'codex' ? null : `cost:${q.source}:${q.session ?? '-'}:${q.since}`),
});
const steps = [];
const snap = (name, extra) => steps.push(scrub({ name, now, ...(extra ?? {}), state: svc.state(), log: log.splice(0) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

snap('initial');
const s1 = svc.setSettings({ tools: { grok: true, bogus: 1 }, stallMs: 120_000, cooldownMs: 30_000, extra: 1 });
await svc.tick(false);
svc.stop();
snap('setSettings', { ret: s1 });
now += 10 * 60_000;
await svc.tick(true);
snap('stalled');
await svc.tick(true);
snap('stalled-again');
{
  const p = path.join(H, fixture[0].rel);
  fs.appendFileSync(p, JSON.stringify(appendClaude) + '\n');
  fs.utimesSync(p, now / 1000, now / 1000);
}
locks = new Set();
procs = [{ pid: 2, kind: 'gemini', cwd: '' }];
now += 5_000;
await svc.tick(true);
snap('done');
const s2 = svc.setSettings({ summaryEnabled: true });
await svc.tick(false);
svc.stop();
snap('summary-on', { ret: s2 });
let tabs = [
  { id: 't1', backend: 'claude', cliSessionId: 'c1', title: 'Tab one', status: 'running', unread: 0, cwd: '/w/app', updatedAt: now - 1000 },
  { id: 't2', backend: 'nomi', title: 'Chat', status: 'queued', unread: 0, cwd: '', updatedAt: now - 2000 },
  { id: 't3', backend: 'codex', cliSessionId: 'cx9', title: 'Svc', status: 'error', lastError: 'boom', unread: 1, cwd: '/w/svc', updatedAt: now - 3000 },
  { id: 't4', backend: 'grok', title: 'Grok', status: 'running', unread: 0, cwd: '/w/g', updatedAt: now - 4000 },
];
const h = {};
svc.attachHarness({
  tabs: () => tabs, onTabs: (fn) => (h.tabs = fn), onFinished: (fn) => (h.fin = fn), onPermission: (fn) => (h.perm = fn),
  progress: (id) => (id === 't1' ? 'running ```npm``` tests now' : undefined),
});
h.tabs();
snap('tabs');
now += 70_000;
svc.digest();
snap('digest-1');
h.fin({ tabId: 't2', title: 'Chat', backend: 'nomi', ok: true, text: 'All ```code``` done   well', background: true });
h.fin({ tabId: 't3', title: 'Svc', backend: 'codex', ok: false, text: '', error: 'crashed hard', background: true });
h.fin({ tabId: 't1', title: 'Tab one', backend: 'claude', ok: true, text: 'fg', background: false });
await sleep(50);
snap('finished');
h.perm({ tabId: 't1', title: 'Tab one', backend: 'claude', summary: '  run   rm -rf build  ', background: false });
h.perm({ tabId: 't1', title: 'Tab one', backend: 'gemini', summary: '', background: true });
snap('permission');
const d1 = svc.digest();
now += 61_000;
const d2 = svc.digest();
snap('digest-2', { d1, d2 });
svc.setSettings({ summaryEnabled: false, tools: { claude: false } });
await svc.tick(false);
svc.stop();
now += 61_000;
const d3 = svc.digest();
h.fin({ tabId: 't1', title: 'Tab one', backend: 'claude', ok: true, text: 'x', background: true });
snap('claude-off', { d3 });
procs = null;
await svc.tick(true);
snap('no-procs');
const app = (line, t) => {
  const p = path.join(H, fixture[0].rel);
  fs.appendFileSync(p, JSON.stringify(line) + '\n');
  fs.utimesSync(p, t / 1000, t / 1000);
};
svc.setSettings({ tools: { claude: true, codex: false } });
await svc.tick(false);
svc.stop();
procs = [{ pid: 1, kind: 'claude', cwd: '/w/app' }];
now = NOW0 + 900_000;
app(appendTool, now);
await svc.tick(true);
snap('c1-running');
now += 200_000;
await svc.tick(true);
snap('c1-stalled');
now = NOW0 + 1_200_000;
app(appendDone, now);
await svc.tick(true);
snap('c1-waiting');
svc.setSettings({ enabled: false, tools: { gemini: false } });
await svc.tick(true);
const d4 = svc.digest();
tabs = [];
snap('disabled', { d4, settingsFile: JSON.parse(fs.readFileSync(path.join(H, 'userData/agents/settings.json'), 'utf8')) });
fs.rmSync(H, { recursive: true, force: true });

const dir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/agents/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'b7s2-agents.json'),
  JSON.stringify({ pure, scenario: { now0: NOW0, fixture, appendClaude, appendTool, appendDone, steps } }, null, 1) + '\n');
console.log(`b7s2-agents: ${Object.values(pure).flat().length} pure, ${steps.length} steps`);
