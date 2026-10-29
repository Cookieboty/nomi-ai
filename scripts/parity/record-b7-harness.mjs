#!/usr/bin/env node
/**
 * 批次 7：harness 辅助（permissionQueue / generatedImages / spawn 纯函数）+ promptImages + transcriptContext 的 golden。
 * CI 各平台由 record-b7-drivers.mjs 链式调用现场录制。
 * Usage: node --import tsx scripts/parity/record-b7-harness.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const core = (p) => import(pathToFileURL(path.join(root, 'packages/core/src', p)).href);
const pq = await core('cli/harness/permissionQueue.ts');
const gi = await core('cli/harness/generatedImages.ts');
const sp = await core('cli/harness/spawn.ts');
const pi = await core('cli/promptImages.ts');
const tc = await core('cli/transcriptContext.ts');

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7h-')));
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
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const unuuid = (v) => JSON.parse(JSON.stringify(v).replace(UUID, '<U>'));
Date.now = () => 1000;

// permissionQueue
for (const s of [undefined, '', 'ExitPlanMode', 'exit_plan_mode', 'exit-plan-mode', 'exitPlanMode', 'ExitPlanMode: do it', 'exit plan', 'EXIT_PLAN_MODE', 'Bash', 'exitplanmode x'])
  add(`isExit:${JSON.stringify(s)}`, () => pq.isExitPlanTool(s));
for (const c of ['acceptEdits', 'manual', 'deny', 'x']) add(`approve:${c}`, () => pq.approvePlanMode(c));
const evs = {
  text: { type: 'text', text: 'x' },
  perm: { type: 'permission', id: 'p', summary: 'Bash: ls' },
  permExp: { type: 'permission', id: 'p', summary: 's', expiresAt: 5 },
  exitSum: { type: 'permission', id: 'p', summary: 'ExitPlanMode: plan here' },
  exitSumSp: { type: 'permission', id: 'p', summary: 'exit_plan_mode\tplan' },
  exitTool: { type: 'permission', id: 'p', summary: 'plan', toolName: 'ExitPlanMode' },
  kindTool: { type: 'permission', id: 'p', summary: 'ExitPlanMode', kind: 'tool' },
  kindPlan: { type: 'permission', id: 'p', summary: 'x', kind: 'approve-plan' },
  toolBash: { type: 'permission', id: 'p', summary: 'ExitPlanMode', toolName: 'Bash' },
};
for (const [k, ev] of Object.entries(evs)) {
  add(`expiry:${k}`, () => pq.withPermissionExpiry(ev, 120000));
  add(`mark:${k}`, () => pq.markApprovePlanIfExit(ev));
}
add('execEv', () => pq.executePlanEvent('t1', 'sum', 600000));
add('isExecId', () => [pq.isExecutePlanId('execute-plan:x'), pq.isExecutePlanId('x')]);
add('consts', () => [pq.EXECUTE_PLAN_ID_PREFIX, pq.EXECUTE_PLAN_FOLLOW_UP]);
for (const b of ['a.js', 'a.mjs', 'a.cjs', 'a.JS', 'claude', 'a.cmd', 'x.mjs.exe']) add(`isScript:${b}`, () => sp.isScript(b));

// generatedImages
const aliasMap = (m) => Object.fromEntries(m);
const rw = new Map([['/a/b.png', 'chat-asset://images/x.png'], ['images/1.png', 'chat-asset://images/y.png'], ['/中 文.png', 'chat-asset://images/z.png']]);
for (const [i, t] of [
  'no image here', '![a](/a/b.png)', '![a]( /a/b.png )', '![](images/1.png) and ![b](other.png)', '![c](/%E4%B8%AD%20%E6%96%87.png)', '![d](%E0%A4%A)', '![](/a/b.png)![](images/1.png)', '[x](/a/b.png)',
].entries()) add(`rewrite:${i}`, () => gi.rewriteGeneratedImageLinks(t, rw));
add('rewrite:empty', () => gi.rewriteGeneratedImageLinks('![a](/a/b.png)', new Map()));
const CR = path.join(SB, 'chat');
add('loadAliases:missing', () => aliasMap(gi.loadImageAliases(CR)));
fs.mkdirSync(CR, { recursive: true });
for (const [n, s] of [['bad', '{'], ['arr', '[1]'], ['null', 'null'], ['mixed', JSON.stringify({ a: 'chat-asset://images/ok.png', b: 'chat-asset://images/bad/x.png', c: 5, d: 'http://x', e: 'chat-asset://images/a b' })]]) {
  fs.writeFileSync(path.join(CR, 'image-aliases.json'), s);
  add(`loadAliases:${n}`, () => aliasMap(gi.loadImageAliases(CR)));
}
fs.rmSync(path.join(CR, 'image-aliases.json'));
delete process.env.GROK_HOME;
const HOME = path.join(SB, 'home');
const sess = path.join(HOME, '.grok', 'sessions', 's1', 'images');
fs.mkdirSync(sess, { recursive: true });
fs.writeFileSync(path.join(sess, '1.png'), 'PNG1');
fs.writeFileSync(path.join(sess, '2.JPG'), 'JPG2');
fs.writeFileSync(path.join(sess, 'n.txt'), 'x');
fs.mkdirSync(path.join(sess, 'd.png'));
fs.writeFileSync(path.join(SB, 'out.png'), 'OUT');
const listImgs = () => { try { return fs.readdirSync(path.join(CR, 'images')).map((f) => f.replace(UUID, '<U>')).sort(); } catch { return null; } };
const mat = (name, raw, aliases) => {
  add(`mat:${name}`, () => { gi.materializeGeneratedImages(raw, HOME, CR, aliases); return unuuid({ aliases: aliasMap(aliases), imgs: listImgs() }); });
};
const al = new Map();
mat('badjson', '{', al);
mat('nopaths', JSON.stringify({ a: 1 }), al);
mat('outside', JSON.stringify({ path: path.join(SB, 'out.png') }), al);
mat('nonimg', JSON.stringify([{ path: path.join(sess, 'n.txt') }, { path: path.join(sess, 'd.png') }, { path: path.join(sess, 'missing.png') }]), al);
mat('abs', JSON.stringify({ content: [{ path: path.join(sess, '1.png') }] }), al);
mat('reuse', JSON.stringify({ output: { path: path.join(sess, '1.png') } }), al);
mat('rel', JSON.stringify({ result: { data: { path: 's1/images/2.JPG' } } }), al);
mat('dotrel', JSON.stringify({ rawOutput: { path: './s1/images/1.png' } }), al);
mat('deep', JSON.stringify({ content: { content: { content: { content: { content: { content: { content: { path: path.join(sess, '2.JPG') } } } } } } } }), new Map());
add('mat:persisted', () => unuuid(JSON.parse(fs.readFileSync(path.join(CR, 'image-aliases.json'), 'utf8'))));
add('mat:reload', () => unuuid(aliasMap(gi.loadImageAliases(CR))));

// promptImages
const B64 = Buffer.from('hello image').toString('base64');
for (const b of ['claude', 'codex', 'dsh', 'grok', 'gemini', 'external', 'nomi']) {
  add(`support:${b}`, () => pi.imageSupportFor(b));
  add(`unsupported:${b}`, () => pi.unsupportedImageMessage(b));
}
add('noVision', () => pi.modelNoVisionMessage('gpt-x'));
const raws = [
  { mime: 'image/PNG ', data: ` ${B64}\n`, width: 10, height: '20', source: 'clip' },
  { mime: 'image/jpg', data: B64, width: -3, height: 'x', thumb: 'data:image/jpeg;base64,T' },
  { mime: 'image/bmp', data: B64 },
  { mime: 'image/gif', data: '  ' },
  { mime: 'image/webp', data: 'A'.repeat(600_001) },
  { mime: 'image/webp', data: 'A'.repeat(600_000), thumb: 'nodata', source: '' },
  { mime: 'image/webp', data: 'A'.repeat(12_000_001), thumb: 'data:x' },
  { data: B64 },
  { mime: 'image/png', data: B64, width: true, height: null, source: 7 },
];
const short = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 200 ? `${x.slice(0, 20)}…${x.length}` : x)));
add('inspect:all', () => short(pi.inspectImages(raws)));
add('inspect:max2', () => short(pi.inspectImages(raws, 2)));
add('inspect:null', () => pi.inspectImages(null));
add('inspect:empty', () => pi.inspectImages([]));
add('normalize', () => short(pi.normalizeImages(raws.slice(0, 2), 1)));
const rej = pi.inspectImages(raws, 2).rejected;
add('rejMsg', () => pi.rejectedImagesMessage(rej));
add('rejMsg:3', () => pi.rejectedImagesMessage(rej, 3));
add('rejMsg:one', () => pi.rejectedImagesMessage([{ index: 0, reason: 'empty' }]));
const imgs = pi.normalizeImages(raws);
const stDir = path.join(SB, 'stage');
const staged = pi.stageImages(stDir, imgs);
add('stage', () => unuuid(staged.map((s) => ({ ...short(s), file: path.relative(SB, s.absPath), bytes: fs.readFileSync(s.absPath).toString('base64') }))));
add('thumbs', () => short(pi.imageThumbsForMessage(imgs)));
for (const t of ['hi', '  ', '']) {
  add(`claudeBlocks:${JSON.stringify(t)}`, () => short(pi.claudeContentBlocks(t, imgs)));
  add(`claudeBlocks0:${JSON.stringify(t)}`, () => pi.claudeContentBlocks(t, []));
  add(`acp:${JSON.stringify(t)}`, () => short(pi.acpPromptParts(t, imgs)));
  add(`acp0:${JSON.stringify(t)}`, () => pi.acpPromptParts(t, []));
}
add('codexInput', () => unuuid(JSON.parse(JSON.stringify(pi.codexTurnInput('go', staged)).replaceAll(JSON.stringify(SB).slice(1, -1), '<SB>'))));
add('codexArgs', () => unuuid(pi.codexImageArgs(staged).map((a) => a.replace(SB, '<SB>'))));
add('grokArgv', () => {
  const a = pi.grokPromptFileArgv(path.join(SB, 'gp'), 'hi', imgs.slice(0, 1));
  return unuuid([a[0], a[1].replace(SB, '<SB>'), fs.readFileSync(a[1], 'utf8')]);
});
add('cleanup', () => { pi.cleanupStagedDir(stDir); pi.cleanupStagedDir(path.join(SB, 'nope')); return fs.existsSync(stDir); });
add('consts:img', () => [pi.IMAGE_DATA_MAX, pi.THUMB_FALLBACK_MAX]);

// transcriptContext
for (const c of ['/Users/a/my proj', 'C:\\x\\y', '/中文/😀', 'abc']) add(`projDir:${c}`, () => tc.claudeProjectDirName(c));
const L = (o) => JSON.stringify(o);
const asst = (usage, model, content = [], extra = {}) => L({ type: 'assistant', message: { usage, model, content }, ...extra });
const T = {
  empty: '',
  garbage: 'x\n{bad\n[1]\n',
  basic: [
    L({ type: 'user', message: { content: 'hello world 你好' } }),
    asst({ input_tokens: 1000, output_tokens: 50 }, 'claude-x', [{ type: 'text', text: 'answer text here' }, { type: 'thinking', thinking: 'hmm 想' }, { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }]),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'out' }, { x: 1 }] }, { type: 'text', text: 7 }] } }),
    asst({ input_tokens: 1500, cache_read_input_tokens: 200, cache_creation_input_tokens: 10, output_tokens: 80 }, '<synthetic>', [{ type: 'tool_use', name: 'Read' }]),
    '  ' + asst({ input_tokens: 'x' }, 'm2') + '  ',
  ].join('\n'),
  sidechain: [asst({ input_tokens: 99 }, 'side', [], { isSidechain: true }), asst({ input_tokens: 10 }, undefined, [], { isApiErrorMessage: true })].join('\n'),
  compacted: [asst({ input_tokens: 5000 }, 'old'), L({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: 1234 } }), L({ type: 'user', message: { content: 'after' } })].join('\n'),
  compacted2: [L({ type: 'system', subtype: 'compact_boundary', compact_metadata: { post_tokens: 77 } }), asst({ input_tokens: 300, output_tokens: 3 }, 'new')].join('\n'),
  boundaryBad: [L({ type: 'system', subtype: 'compact_boundary', compactMetadata: { postTokens: -1 } }), 'x'].join('\n'),
  zero: asst({ input_tokens: 0 }, 'z'),
  modelKeep: [asst({ input_tokens: 10 }, 'keep'), asst({ input_tokens: 20 }, 5)].join('\n'),
  bigSys: [L({ type: 'user', message: { content: 'x'.repeat(4000) } }), asst({ input_tokens: 100, output_tokens: 1 }, 'm')].join('\n'),
};
for (const [k, t] of Object.entries(T)) add(`last:${k}`, () => tc.lastTranscriptContext(t));
const CFG = path.join(SB, 'claude');
const CWD = path.join(SB, 'my proj');
const sid = 'abcdef12-3456';
fs.mkdirSync(path.join(CFG, 'projects', tc.claudeProjectDirName(CWD)), { recursive: true });
fs.writeFileSync(path.join(CFG, 'projects', tc.claudeProjectDirName(CWD), `${sid}.jsonl`), T.basic);
fs.mkdirSync(path.join(CFG, 'projects', 'other'), { recursive: true });
const rew = [
  L({ type: 'user', uuid: 'u1', parentUuid: null }),
  L({ type: 'assistant', uuid: 'a1', parentUuid: 'u1' }),
  L({ type: 'user', uuid: 'u2', parentUuid: 'a1', isSidechain: true }),
  'not json "uuid"',
  L({ type: 'user', uuid: 'u2', parentUuid: 'a1' }),
  L({ type: 'user', uuid: 'u3', parentUuid: 5 }),
].join('\n');
fs.writeFileSync(path.join(CFG, 'projects', 'other', 'abcdef12-9999.jsonl'), rew);
const results = [];
for (const [n, args] of [['direct', [CFG, CWD, sid]], ['scan', [CFG, '/elsewhere', sid]], ['bad', [CFG, CWD, '../x']], ['missing', [CFG, CWD, 'abcdef12-0000']], ['nocfg', [path.join(SB, 'none'), CWD, sid]]])
  results.push([`ctx:${n}`, await tc.claudeTranscriptContext(...args)]);
results.push(['ctx:cached', await tc.claudeTranscriptContext(CFG, CWD, sid)]);
for (const [n, u] of [['u1', 'u1'], ['u2', 'u2'], ['u3', 'u3'], ['none', 'zz']]) results.push([`rewind:${n}`, await tc.claudeRewindPoint(CFG, CWD, 'abcdef12-9999', u)]);
results.push(['rewind:bad', await tc.claudeRewindPoint(CFG, CWD, 'XYZ', 'u1')]);
for (const [n, v] of results) add(n, () => v);

const out = { platform: process.platform, fixtures: { T, rew }, cases: JSON.parse(JSON.stringify(cases).replaceAll(JSON.stringify(SB).slice(1, -1), '<SB>')) };
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/harness/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'harness.json'), `${JSON.stringify(out, null, 1)}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`recorded ${cases.length} harness cases (${process.platform})`);
