#!/usr/bin/env node
/**
 * 批次 7s2：delegate（core.ts / worktree.ts / DelegateService.ts）golden。
 * - fns：纯函数语料 + Number#toString(36)
 * - worktree：沙箱 git 仓库里 prepareIsolation → 改文件 → applyWorktreeToMain → releaseIsolation
 * - service：注入假 harness / desktop / events，按步骤驱动三个工具与设置 / 钉住；时钟与随机数固定
 * - tools：工具名、描述与 asSchema(zod).jsonSchema
 * 沙箱路径写成 @@SB@@。输出 apps/desktop-go/internal/core/cli/delegate/testdata/b7s2-delegate.json
 * （NOMI_GOLDEN_DIR 优先）。CI 由 record-b7-drivers.mjs 链式录制。
 * Usage: node --import tsx scripts/parity/record-b7s2-delegate.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const src = (p) => path.join(root, 'packages/core/src', p);
// TS 源码打包装载（不依赖 @nomi-ai/* 的 dist；四个模块共享同一份实例）
const { C, W, S, H } = await importSources(root, {
  C: src('cli/delegate/core.ts'), W: src('cli/delegate/worktree.ts'),
  S: src('cli/delegate/DelegateService.ts'), H: src('cli/CliHarnessService.ts'),
});
const { HarnessStoppedError } = H;
const req = createRequire(path.join(root, 'packages/core/package.json'));
const { asSchema } = await import(pathToFileURL(req.resolve('ai')).href);

const T = '@@SB@@';
const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'b7s2-del-')));
// 依次替换：JSON 串里再嵌 JSON（4 重转义）、2 重转义、原样、正斜杠（git 输出）形式
const tokWith = (s, b) => [b.replaceAll('\\', '\\\\\\\\'), b.replaceAll('\\', '\\\\'), b, b.replaceAll('\\', '/')].reduce((a, f) => a.split(f).join(T), s);
// 再按沙箱末两级目录归一任何别名（Windows 8.3 短名 RUNNER~1 vs git 输出的长名、盘符大小写）
const tokAliasFor = (b) => {
  const [x, y] = b.split(/[\\/]/).slice(-2).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?:[A-Za-z]:|/)[^"\\s:]*?${x}(?:[\\\\/])+${y}`, 'g');
  return (s) => (path.sep === '\\' ? s.replace(re, T) : s);
};
const tokAlias = tokAliasFor(SB);
const tok = (v) => JSON.parse(tokAlias(tokWith(JSON.stringify(v ?? null), SB)));
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
const mkrepo = (dir, files = { 'a.txt': 'a\n', 'src/b.txt': 'b\n' }) => {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  for (const [k, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true });
    fs.writeFileSync(path.join(dir, k), v);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fns ----------
const fns = [];
const F = (fn, args, out) => fns.push({ fn, args, out: out === undefined ? '@@undef@@' : out });
const settingsIn = [
  null, 42, 'x', [], {}, { enabled: false }, { enabled: 'yes', defaults: { coding: 'codex', prd: 'nope', review: 'claude', x: 'grok' } },
  { defaults: [], profiles: 'bad', defaultProfileId: 'cheap', cheapModel: '  gpt-mini  ' },
  { profiles: [{ id: 'a', label: 'A' }, { id: '', label: 'x' }, { id: 'default', label: 'Mine', model: ' m ', reasoningEffort: null }, { id: 'b'.repeat(70), label: 'L'.repeat(90), model: 'm'.repeat(140), reasoningEffort: 'e'.repeat(40), preferLocal: true }, 7, null] },
  { defaultProfileId: 5, cheapModel: 9, profiles: [{ id: 'local', label: '本地', preferLocal: 'x' }] },
  { enabled: true, defaults: { coding: 'dsh', research: 'gemini' }, defaultProfileId: 'zz', cheapModel: '' },
];
for (const s of settingsIn) F('sanitize', [s], C.sanitizeDelegateSettings(s));
for (const p of [undefined, [], [{ id: 'cheap', label: 'C2', model: 'x' }], [{ id: 'n', label: 'N' }, { id: 'n', label: 'N2' }], 'bad'])
  F('merge', [p ?? '@@undef@@'], C.mergeAgentProfiles(p));
const st = (o) => C.sanitizeDelegateSettings(o);
const ovIn = [
  [{}, {}], [{ profile: 'cheap' }, { cheapModel: 'mini' }], [{ profile: 'cheap' }, {}], [{ profile: ' nope ' }, {}],
  [{ model: '  claude-x  ' }, {}], [{ model: 'm'.repeat(200) }, {}], [{ model: '   ' }, { defaultProfileId: 'cheap', cheapModel: 'c' }],
  [{ reasoningEffort: ' high ' }, {}], [{ reasoningEffort: '   ' }, {}], [{ reasoningEffort: 'x'.repeat(50) }, {}],
  [{ profile: 'mine' }, { profiles: [{ id: 'mine', label: 'M', model: 'p/m', reasoningEffort: 'low', preferLocal: true }] }],
  [{ profile: 'mine', reasoningEffort: null }, { profiles: [{ id: 'mine', label: 'M', reasoningEffort: null }] }],
  [{ profile: 'local' }, {}], [{ profile: 42 }, { defaultProfileId: 'local' }],
];
for (const [i, s] of ovIn) F('overrides', [i, s], C.resolveDelegateOverrides({ ...i, settings: st(s) }));
for (const n of ['claude', ' Claude Code ', 'CC', 'claude  code', 'codex', 'GROK', 'gemini', 'dsh', 'x', '', 5, null, 'claudecode'])
  F('resolveCli', [n], C.resolveDelegateCli(n));
const pickIn = [
  { pinned: 'codex', kind: 'coding', defaults: {}, installed: ['codex'] },
  { pinned: 'codex', kind: 'coding', defaults: {}, installed: ['claude'] },
  { requested: 'grok', kind: 'prd', defaults: { prd: 'claude' }, installed: ['grok', 'claude'] },
  { requested: 'grok', kind: 'prd', defaults: { prd: 'claude' }, installed: ['claude'] },
  { kind: 'review', defaults: { review: 'gemini', coding: 'codex' }, installed: ['codex'] },
  { kind: 'review', defaults: {}, installed: ['dsh', 'gemini'] },
  { kind: 'coding', defaults: {}, installed: [] },
];
for (const p of pickIn) F('pick', [p], C.pickDelegateCli(p));
const modes = ['plan', 'manual', 'acceptEdits', 'auto', 'bypass', 'weird'];
for (const a of modes) for (const b of modes) F('childMode', [a, b], C.childPermissionMode(a, b));
for (const b of [{ goal: 'G', doneWhen: 'D' }, { goal: ' 修 bug ', doneWhen: 'npm test', context: 'ctx\nline', outOfScope: 'docs/' }, { goal: 'g', doneWhen: 'd', context: '', outOfScope: '' }])
  F('prompt', [b], C.buildDelegatePrompt(b));
const reports = [
  '', 'no report here', 'DONE: fixed it\nCHANGED:\n- a.txt\n- src/b.txt\nUNFINISHED: none\nNEEDS_USER: none',
];
const rp = C.buildDelegatePrompt({ goal: 'g', doneWhen: 'd' });
F('promptText', [], rp);
const extra = [
  '## 汇报\n完成：改好了\n改动文件：\n- a.txt\n未完成：无\n需要用户：无',
  'blah\n\n完成：x\n改动文件：无\n未完成：还有 y\n需要用户：确认 z',
  '完成： 前面\r\n改动文件：\r\n  * one.ts\r\n  • two.ts\r\n未完成：\r\n需要用户：',
  '完成：a\n完成：b\n改动文件：\n- c',
  '[nomi-report]\n做了什么：修好了\n改动的文件：\n- a.txt\n* src/b.txt\n  c.ts  \n没做完的：无\n需要用户决定的：确认 API\n[/nomi-report]',
  'x\r\n[nomi-report]\r\n做了什么：多行\r\n第二行\r\n改动的文件：无\r\n没做完的：还剩测试\r\n需要用户决定的：无\r\n[/nomi-report]\r\n尾巴',
  '[nomi-report]\n做了什么：旧\n[/nomi-report]\n[nomi-report]\n做了什么：新\n改动的文件：\n• d.md\n[/nomi-report]',
  '[nomi-report]\n改动的文件：\n- only.txt\n',
  '[nomi-report]\n做了什么：\n没做完的：（没有）\n需要用户决定的：-\n[/nomi-report]',
  '[NOMI-REPORT]\n做了什么：大写\n[/NOMI-REPORT]',
];
for (const r of [...reports, ...extra]) F('report', [r], C.parseDelegateReport(r));
for (const p of ['', ' M a.txt\0?? new dir/f.txt\0R  new.txt\0old.txt\0', 'A  x\0D  y\0', '?? 中文.txt\0 M "q".txt\0', 'MM z\0C  c2\0c1\0'])
  F('porcelain', [p], C.parsePorcelain(p));
for (const [t, m] of [['short', 10], ['x'.repeat(50), 10], ['\n\n  abc  \n', 100], ['😀'.repeat(10), 5], ['a\nb\nc\nd', 3]])
  F('tail', [t, m], C.tailText(t, m));
for (const x of [0.5, 0.123456789, 0.9999999999, 1e-7, 0.1, 0.30000000000000004, Math.PI - 3, 0.000123, 0.987654321012, 0.42])
  F('radix36', [x], x.toString(36));
for (const n of [0, 1, 1767000000000, 1767000123456]) F('radix36', [n], n.toString(36));

// ---------- worktree ----------
const worktree = [];
{
  const repo = path.join(SB, 'wt/repo');
  mkrepo(repo);
  const plain = path.join(SB, 'wt/plain');
  fs.mkdirSync(plain, { recursive: true });
  const empty = path.join(SB, 'wt/empty');
  fs.mkdirSync(empty, { recursive: true });
  sh(empty, 'init', '-q');
  worktree.push({ op: 'gitRoot', cwd: tok(repo), out: tok(await W.resolveGitRoot(path.join(repo, 'src'))) });
  worktree.push({ op: 'gitRoot', cwd: tok(plain), out: tok(await W.resolveGitRoot(plain)) });
  worktree.push({ op: 'prepare', cwd: tok(plain), out: tok(await W.prepareIsolation(plain, 'k1')) });
  worktree.push({ op: 'prepare', cwd: tok(empty), out: tok(await W.prepareIsolation(empty, 'k/2 x')) });
  const h = await W.prepareIsolation(repo, 'del-abc-xyz');
  worktree.push({ op: 'prepare', cwd: tok(repo), out: tok(h) });
  worktree.push({ op: 'exclude', out: fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8') });
  worktree.push({ op: 'changedWt', out: tok(await S.gitChanged(h.cwd)) });
  fs.writeFileSync(path.join(h.cwd, 'a.txt'), 'A2\n');
  fs.writeFileSync(path.join(h.cwd, 'new.txt'), 'N\n');
  fs.mkdirSync(path.join(h.cwd, 'deny'), { recursive: true });
  fs.writeFileSync(path.join(h.cwd, 'deny/x.txt'), 'D\n');
  fs.writeFileSync(path.join(h.cwd, 'src/b.txt'), 'B2\n');
  fs.writeFileSync(path.join(repo, 'src/b.txt'), 'user edit\n');
  const ch = await S.gitChanged(h.cwd);
  worktree.push({ op: 'changedWt', out: tok(ch) });
  worktree.push({ op: 'changedMain', out: tok(await S.gitChanged(path.join(repo, 'src'))) });
  worktree.push({ op: 'changedPlain', out: tok(await S.gitChanged(plain)) });
  const ar = await W.applyWorktreeToMain(h, [...ch, '../evil', '', 'gone.txt'], (d) => !d.includes(`${path.sep}deny${path.sep}`));
  worktree.push({ op: 'apply', out: tok(ar), main: { a: fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), b: fs.readFileSync(path.join(repo, 'src/b.txt'), 'utf8'), n: fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), deny: fs.existsSync(path.join(repo, 'deny/x.txt')) } });
  await W.releaseIsolation(h);
  worktree.push({ op: 'release', exists: fs.existsSync(h.cwd), list: String(sh(repo, 'worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree ')).length });
  const h2 = await W.prepareIsolation(repo, 'del-abc-xyz');
  fs.rmSync(h2.cwd, { recursive: true, force: true });
  const logs = [];
  await W.releaseIsolation(h2, (m) => logs.push(m.replace(/:.*$/s, '')));
  worktree.push({ op: 'releaseMissing', logs });
}

// ---------- service ----------
let NOW = 1767000000000;
let RND = [0.5];
let ri = 0;
Date.now = () => NOW;
Math.random = () => RND[ri++ % RND.length];

function makeEnv(sc, base) {
  const log = { harness: [], sent: [], desktop: [], audit: [], events: [] };
  let tabN = 0;
  const tabs = (sc.tabs ?? []).map((t) => ({ ...t }));
  const sends = [...(sc.sends ?? [])];
  const pending = [];
  const sub = (s) => (typeof s === 'string' ? s.split(T).join(base) : s);
  const granted = (sc.granted ?? []).map((g) => path.resolve(sub(g)));
  const harness = {
    state: () => ({ bins: Object.fromEntries((sc.installed ?? []).map((c) => [c, `/bin/${c}`])) }),
    listTabs: () => ({ tabs, defaultPermissionMode: sc.tabDefault ?? 'acceptEdits' }),
    recentCwds: () => (sc.recent ?? []).map(sub),
    autoApproveEnabled: () => !!sc.autoApprove,
    createTab: (o) => {
      log.harness.push(['createTab', o]);
      if (sc.createFail) throw new Error('create failed');
      const id = `tab-${++tabN}`;
      tabs.push({ id, delegation: { by: 'nomi', goal: o.delegation.goal, ...(sc.tabApprovals ? { approvals: sc.tabApprovals } : {}) } });
      return { id };
    },
    sendTab: (id, prompt) => {
      log.sent.push([id, prompt]);
      const s = sends.shift() ?? { text: '' };
      return new Promise((resolve, reject) => {
        const go = () => {
          if (s.abort) { s.abort.ctl.abort(); }
          if (s.stop !== undefined) reject(new HarnessStoppedError('stopped', s.stop));
          else if (s.error) reject(new Error(s.error));
          else {
            if (s.write) for (const [f, v] of Object.entries(s.write)) { const p = path.join(sub(s.dir ?? T), f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); }
            resolve({ text: s.text, ...(s.usage ? { usage: s.usage } : {}) });
          }
        };
        if (s.hold) pending.push(go); else go();
      });
    },
    cancelTab: (id) => log.harness.push(['cancelTab', id]),
    closeTab: (id) => { log.harness.push(['closeTab', id]); if (sc.closeFail) throw new Error('x'); },
  };
  const inGrant = (p) => granted.some((g) => p === g || p.startsWith(g + path.sep));
  const guardR = (p) => {
    const r = path.resolve(String(p));
    return inGrant(r) ? { ok: true, real: r } : { ok: false, code: 'not_granted', message: `未授权：${r}` };
  };
  const decisions = [...(sc.decisions ?? [])];
  const broker = {
    workspaceOf: async (cwd) => { log.desktop.push(['workspaceOf', cwd ?? null]); return sc.ws ? sub(sc.ws) : null; },
    guard: async (p, need, allowMissing) => { const r = guardR(p); log.desktop.push(['guard', p, need, !!allowMissing, r.ok]); return r; },
    guardIn: async (ws, p, need) => {
      const r = path.resolve(ws, String(p));
      const ok = r === ws || r.startsWith(ws + path.sep);
      log.desktop.push(['guardIn', ws, p, need, ok]);
      return ok ? { ok: true, real: r } : { ok: false, code: 'outside', message: `不在工作区：${r}` };
    },
    authorize: async (i) => { log.desktop.push(['authorize', { ...i, signal: !!i.signal }]); return decisions.shift() ?? 'allowed'; },
    authorizeIn: async (i) => { log.desktop.push(['authorizeIn', { ...i, signal: !!i.signal }]); return decisions.shift() ?? 'allowed'; },
    permissionMode: () => sc.mode ?? 'acceptEdits',
    markRead: (sig) => log.desktop.push(['markRead', !!sig]),
    checkSend: async (t, sig, what) => { log.desktop.push(['checkSend', t.id, what]); return sc.blockSend ? 'local_only' : null; },
  };
  const desktop = {
    broker,
    audit: { append: (e) => log.audit.push(e) },
    receiversFor: (p, roles) => { log.desktop.push(['receiversFor', p?.id ?? null, roles]); return (sc.receivers ?? []).map((id) => ({ id, name: id, local: false })); },
  };
  const gateway = sc.gateway ? { defaults: (cli) => ({ source: sc.gateway.source, model: sc.gateway.model }), models: () => sc.gateway.models.map((ref) => ({ ref })) } : undefined;
  const events = { publish: (e, p) => log.events.push([e, p]) };
  return { log, harness, desktop, gateway, events, pending, tabs };
}

const scenarios = [];
const G = path.join(SB, 'svc');
const scen = (name, sc) => scenarios.push({ name, ...sc });
const exec = (tool, raw, ctx = {}) => ({ op: 'tool', tool, raw, ctx });
const base = { goal: '修复登录 bug', done_when: 'npm test 通过' };
const REP = '前言\n[nomi-report]\n做了什么：改好了\n改动的文件：\n- new.txt\n没做完的：无\n需要用户决定的：无\n[/nomi-report]';

scen('disabled', { installed: ['claude'], settingsFile: { enabled: false }, steps: [exec('delegate_to_cli', base), { op: 'settings' }] });
scen('parse-errors', { installed: ['claude'], steps: [exec('delegate_to_cli', {}), exec('delegate_to_cli', { goal: '', done_when: 'x' }), exec('delegate_to_cli', { ...base, kind: 'bad' }), exec('delegate_to_cli', { ...base, background: 'no' }), exec('delegate_followup', { taskId: 'x' }), exec('delegate_status', { taskId: 'nope' }), exec('delegate_to_cli', null), exec('delegate_to_cli', [1]), exec('delegate_to_cli', 'str'), exec('delegate_to_cli', { goal: 5, done_when: null, kind: 3, cli: true, context: 'c'.repeat(8001), background: null, extra: 1 }), exec('delegate_to_cli', { goal: '😀'.repeat(2001), done_when: '', out_of_scope: 'o'.repeat(2001), profile: [], model: {} }), exec('delegate_to_cli', { goal: 'g', done_when: 'd', kind: 'x', reasoning_effort: 1 }), exec('delegate_status', {}), exec('delegate_status', { taskId: '' }), exec('delegate_status', null), exec('delegate_status', { taskId: 7 }), exec('delegate_followup', { taskId: '', message: 'm'.repeat(8001) }), exec('delegate_followup', 5)] });
scen('no-cli', { installed: [], steps: [exec('delegate_to_cli', base)] });
scen('depth', { installed: ['claude'], tabs: [{ id: 'caller', delegation: { by: 'nomi' } }], steps: [exec('delegate_to_cli', base, { callerTabId: 'caller' }), exec('delegate_to_cli', base, { callerTabId: 'other' })] });
scen('cwd-required', { installed: ['claude'], steps: [exec('delegate_to_cli', base)] });
scen('cwd-not-granted', { installed: ['claude'], recent: [`${T}/plain`], steps: [exec('delegate_to_cli', base), exec('delegate_to_cli', { ...base, cwd: `  ${T}/other ` })] });
scen('ws-outside', { installed: ['codex'], ws: `${T}/plain`, steps: [exec('delegate_to_cli', { ...base, cwd: '../x' }, { cwd: `${T}/plain` })] });
scen('pin-missing', { installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`], steps: [{ op: 'pin', name: 'claude', turn: 't1' }, { op: 'pin', name: 'codex', turn: 't1' }, { op: 'pin', name: 'zz', turn: 't1' }, { op: 'pin', name: 'claude', turn: ' ' }, { op: 'peek', turn: 't1' }, { op: 'now', v: 1767000000000 + 600001 }, { op: 'peek', turn: 't1' }, { op: 'pin', name: 'cc', turn: 't2' }, { op: 'pin', name: 'off', turn: 't2' }, { op: 'peek', turn: 't2' }] });
for (const d of ['blocked', 'denied', 'timeout'])
  scen(`auth-${d}`, { installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`], decisions: [d], steps: [{ op: 'pin', name: 'claude', turn: 'r1' }, exec('delegate_to_cli', base, { reqId: ' r1 ' }), { op: 'peek', turn: 'r1' }] });
scen('overrides-errors', { installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`], gateway: { source: 'thirdParty', models: ['p/ok'] }, steps: [exec('delegate_to_cli', { ...base, profile: 'zz' }), exec('delegate_to_cli', { ...base, model: 'bad model!' }), exec('delegate_to_cli', { ...base, model: 'p/missing' })] });
scen('sync-plain', {
  installed: ['claude', 'codex'], recent: [`${T}/plain`], granted: [`${T}/plain`], mode: 'manual', tabApprovals: { asked: 2, denied: 1, timedOut: 0 },
  gateway: { source: 'thirdParty', models: ['p/ok'] },
  sends: [{ text: '一些输出\n' + 'x'.repeat(10), usage: { inputTokens: 3, outputTokens: 4 } }, { text: REP }, { error: 'boom' }],
  steps: [
    exec('delegate_to_cli', { ...base, cli: 'Codex', kind: 'review', background: false, context: '背景', out_of_scope: 'docs', model: 'p/ok', reasoning_effort: ' high ' }, { toolCallId: 'call-1', conversationId: 'conv-1', reqId: 'r', provider: { id: 'openai', baseURL: 'x' } }),
    { op: 'now', v: 1767000005000 },
    exec('delegate_followup', { taskId: 'tab-1', message: '再看看' }),
    exec('delegate_followup', { taskId: 'tab-1', message: '再看看 2' }),
    exec('delegate_status', { taskId: 'tab-1' }),
    { op: 'statusOf', id: 'tab-1' },
    { op: 'tasks' },
  ],
});
scen('bg-git', {
  installed: ['gemini'], recent: [`${T}/repo`], granted: [`${T}/repo`], autoApprove: true, mode: 'auto', repo: 'repo', receivers: ['cloud'],
  rnd: [0.123456789, 0.987654321012],
  sends: [{ hold: true, text: REP, dir: `${T}/repo/.nomi-delegate/del-mjqy6dxc-4fzzzx`, write: { 'new.txt': 'N\n' } }],
  steps: [
    exec('delegate_to_cli', { ...base, kind: 'research' }, { conversationId: 'c9' }),
    { op: 'statusOf', id: 'tab-1' },
    exec('delegate_followup', { taskId: 'tab-1', message: 'm' }),
    { op: 'now', v: 1767000009000 },
    { op: 'release' },
    { op: 'wait' },
    exec('delegate_status', { taskId: 'tab-1' }),
    { op: 'file', p: 'repo/new.txt' },
    { op: 'tasks' },
  ],
});
scen('bg-blocked-send', {
  installed: ['claude'], ws: `${T}/plain`, receivers: ['a', 'b'], blockSend: true,
  sends: [{ hold: true, text: REP }],
  steps: [exec('delegate_to_cli', { ...base, cwd: 'sub/..' }, { cwd: `${T}/plain` }), { op: 'release' }, { op: 'wait' }, exec('delegate_status', { taskId: 'tab-1' })],
});
scen('concurrency', {
  installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`],
  sends: [{ hold: true, text: 'a' }, { hold: true, text: 'b' }, { hold: true, text: 'c' }],
  steps: [exec('delegate_to_cli', base), exec('delegate_to_cli', base), exec('delegate_to_cli', base), exec('delegate_to_cli', base), exec('delegate_followup', { taskId: 'tab-1', message: 'x' }), { op: 'release' }, { op: 'wait' }, { op: 'tasks' }],
});
scen('cancel-sync', {
  installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`],
  sends: [{ abort: true, stop: '部分输出' }, { stop: '' }],
  steps: [exec('delegate_to_cli', { ...base, background: false }, { signal: 'abortable' }), exec('delegate_followup', { taskId: 'tab-1', message: 'go' }), { op: 'takeOver', id: 'tab-1' }, exec('delegate_followup', { taskId: 'tab-1', message: 'go' }), { op: 'closeTabs' }, exec('delegate_followup', { taskId: 'tab-1', message: 'go' })],
});
scen('long-goal', { installed: ['grok'], recent: [`${T}/plain`], granted: [`${T}/plain`], sends: [{ text: '' }], steps: [exec('delegate_to_cli', { goal: '长'.repeat(30) + '😀'.repeat(30) + 'g'.repeat(60), done_when: 'x' }), { op: 'wait' }] });
scen('pre-aborted', { installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`], steps: [exec('delegate_to_cli', base, { signal: 'aborted' })] });
scen('create-fail', { installed: ['claude'], recent: [`${T}/plain`], granted: [`${T}/plain`], createFail: true, steps: [exec('delegate_to_cli', base)] });
scen('restart', {
  installed: ['claude'], closeFail: true,
  tasksFile: [
    { taskId: 'old-run', cli: 'claude', goal: 'g', cwd: `${T}/plain`, sourceCwd: `${T}/plain`, isolation: { kind: 'shared-cwd', cwd: `${T}/plain`, sourceCwd: `${T}/plain`, note: 'n' }, startedAt: 1767000000000 - 5000, before: null, status: 'running', conversationId: 'cc' },
    { taskId: 'old-run2', cli: 'codex', goal: 'g', cwd: 'c', sourceCwd: 'c', isolation: { kind: 'shared-cwd' }, startedAt: 1767000000000 + 5000, before: [], status: 'running' },
    { taskId: 'old-done', cli: 'codex', goal: 'g2', cwd: 'c', sourceCwd: 'c', isolation: {}, startedAt: 1, before: ['x'], status: 'done', result: { taskId: 'old-done', status: 'done', summary: 's' } },
    { taskId: 'bad', cli: 'nope', goal: 'g', cwd: 'c', sourceCwd: 'c', isolation: {}, startedAt: 1, before: null, status: 'done' },
    { taskId: 'bad2', cli: 'claude', goal: 'g', cwd: 'c', sourceCwd: 'c', isolation: null, startedAt: 1, before: null, status: 'done' },
    'junk',
  ],
  steps: [{ op: 'tasks' }, exec('delegate_status', { taskId: 'old-run' }), exec('delegate_status', { taskId: 'old-done' }), exec('delegate_followup', { taskId: 'old-done', message: 'x' })],
});
scen('settings', {
  installed: ['claude', 'dsh'], settingsFile: 'not json',
  steps: [{ op: 'settings' }, { op: 'setSettings', raw: { defaults: { coding: 'dsh' }, profiles: [{ id: 'p1', label: 'P' }] } }, { op: 'setSettings', raw: { enabled: false } }, { op: 'settings' }, { op: 'setSettings', raw: null }, { op: 'settingsFileOut' }],
});

async function runScenario(sc) {
  const dir = fs.mkdtempSync(path.join(SB, 'svc-'));
  const B = fs.realpathSync.native(dir);
  fs.mkdirSync(path.join(B, 'plain/sub'), { recursive: true });
  fs.mkdirSync(path.join(B, 'state'), { recursive: true });
  if (sc.repo) mkrepo(path.join(B, sc.repo));
  const sub = (s) => (typeof s === 'string' ? s.split(T).join(B) : s);
  const subDeep = (v) => JSON.parse(JSON.stringify(v).split(T).join(B.replaceAll('\\', '\\\\')));
  if (sc.settingsFile !== undefined) fs.writeFileSync(path.join(B, 'state/settings.json'), typeof sc.settingsFile === 'string' ? sc.settingsFile : JSON.stringify(sc.settingsFile));
  if (sc.tasksFile) fs.writeFileSync(path.join(B, 'state/tasks.json'), JSON.stringify(subDeep(sc.tasksFile)));
  NOW = 1767000000000; RND = sc.rnd ?? [0.5]; ri = 0;
  const env = makeEnv(sc, B);
  const svc = new S.DelegateService({ root: path.join(B, 'state'), harness: env.harness, desktop: env.desktop, gateway: env.gateway, events: env.events });
  const out = [];
  const untok = (v) => JSON.parse(tokAliasFor(B)(tokWith(JSON.stringify(v ?? null) ?? 'null', B)));
  const tools = Object.fromEntries(svc.tools().map((t) => [t.name, t]));
  const settle = async () => { for (let i = 0; i < 200 && [...svc['tasks'].values()].some((t) => t.status === 'running'); i++) await sleep(10); await sleep(50); };
  for (const st of sc.steps) {
    let r;
    try {
      switch (st.op) {
        case 'tool': {
          const ctx = { ...st.ctx };
          if (ctx.cwd) ctx.cwd = sub(ctx.cwd);
          if (st.ctx.signal) {
            const ctl = new AbortController();
            if (st.ctx.signal === 'aborted') ctl.abort();
            ctx.signal = ctl.signal;
            for (const s of sc.sends ?? []) if (s.abort === true) s.abort = { ctl };
          }
          const raw = JSON.parse(JSON.stringify(st.raw).split(T).join(B.replaceAll('\\', '\\\\')));
          r = await tools[st.tool].execute(raw, ctx);
          break;
        }
        case 'pin': r = svc.pin(st.name, st.turn); break;
        case 'peek': r = svc.peekPin(st.turn); break;
        case 'now': NOW = st.v; r = null; break;
        case 'statusOf': r = svc.statusOf(st.id); break;
        case 'settings': r = svc.settings(); break;
        case 'setSettings': r = await svc.setSettings(st.raw); break;
        case 'settingsFileOut': r = fs.readFileSync(path.join(B, 'state/settings.json'), 'utf8'); break;
        case 'release': while (env.pending.length) env.pending.shift()(); r = null; break;
        case 'wait': await settle(); r = null; break;
        case 'tasks': await sleep(80); r = fs.existsSync(path.join(B, 'state/tasks.json')) ? fs.readFileSync(path.join(B, 'state/tasks.json'), 'utf8') : null; break;
        case 'file': r = fs.readFileSync(path.join(B, st.p), 'utf8'); break;
        case 'takeOver': { const tb = env.tabs.find((t) => t.id === st.id); if (tb?.delegation) tb.delegation.takenOver = true; r = null; break; }
        case 'closeTabs': env.tabs.length = 0; r = null; break;
      }
      out.push({ ok: untok(r === undefined ? null : r) });
    } catch (e) {
      out.push({ err: untok(e.message) });
    }
  }
  await settle();
  for (const s of sc.sends ?? []) if (s.abort) s.abort = true;
  return { name: sc.name, sc: { ...sc }, out, log: untok(env.log) };
}

const svcOut = [];
for (const sc of scenarios) svcOut.push(await runScenario(sc));

// ---------- tools ----------
const svc0 = new S.DelegateService({ root: path.join(SB, 'none'), harness: { state: () => ({ bins: {} }) }, desktop: {}, events: {} });
const toolsOut = [];
for (const t of svc0.tools()) toolsOut.push({ name: t.name, description: t.description, schema: await asSchema(t.input).jsonSchema });

const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/delegate/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'b7s2-delegate.json'), `${JSON.stringify({ fns, worktree, service: svcOut, tools: toolsOut }, null, 1)}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`b7s2-delegate: ${fns.length} fns, ${worktree.length} worktree, ${svcOut.length} service scenarios, ${toolsOut.length} tools`);
