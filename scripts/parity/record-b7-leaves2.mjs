#!/usr/bin/env node
/**
 * 批次 7 item 3b：permissionMode / modelCatalog / externalPlugins 的 golden。
 * CI 各平台由 record-b7-drivers.mjs 链式调用现场录制。
 * Usage: node --import tsx scripts/parity/record-b7-leaves2.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const core = (p) =>
  import(pathToFileURL(path.join(root, 'apps/desktop-electron/internal/core/src', p)).href);
const pm = await core('cli/permissionMode.ts');
const mc = await core('cli/modelCatalog.ts');
const ep = await core('cli/externalPlugins.ts');

const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7lv2-')));
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

const CLI = ['claude', 'codex', 'dsh', 'grok', 'gemini', 'external'];
const ALL = [...CLI, 'nomi'];
const MODES = [...pm.PERMISSION_MODES];
add('modes', () => MODES);
add('default', () => pm.DEFAULT_PERMISSION_MODE);
for (const v of [...MODES, 'x', '', 5, null])
  add(`isMode:${JSON.stringify(v)}`, () => pm.isPermissionMode(v));
for (const b of ALL) {
  add(`supported:${b}`, () => pm.supportedModes(b));
  for (const m of MODES) add(`effective:${b}:${m}`, () => pm.effectiveMode(b, m));
}
for (const b of CLI) {
  for (const m of MODES)
    for (const n of [undefined, true, false])
      add(`launch:${b}:${m}:${n}`, () =>
        pm.permissionLaunch(b, m, n === undefined ? {} : { codexNetwork: n }),
      );
  add(`planPrefix:${b}`, () => pm.planPromptPrefix(b));
  for (const raw of [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions',
    'auto',
    'auto_edit',
    'yolo',
    'read-only',
    'workspace-write',
    'danger-full-access',
    'full-auto',
    'manual',
    'ask',
    'agent',
    '',
    'x',
    5,
    null,
  ])
    add(`fromCli:${b}:${JSON.stringify(raw)}`, () => pm.fromCliPermissionMode(b, raw));
}
for (const m of MODES) {
  add(`claudeName:${m}`, () => pm.claudeModeName(m));
  add(`geminiId:${m}`, () => pm.geminiModeId(m));
  add(`grokId:${m}`, () => pm.grokModeId(m));
  add(`acpId:external:${m}`, () => pm.acpModeId('external', m));
}

const MODELS = [
  'gpt-5',
  'opus',
  'claude-sonnet-4-5[1m]',
  '',
  ' x',
  'a b',
  '-rf',
  'a/b:c.d_e',
  'x'.repeat(200),
];
for (const b of [...CLI, 'nomi', 'zzz']) {
  add(`supportsModel:${b}`, () => mc.supportsModelOverride(b));
  for (const m of MODELS) add(`allowed:${b}:${m}`, () => mc.isAllowedModelId(b, m));
}
for (const b of CLI)
  for (const model of [undefined, null, '', 'gpt-5', 'opus'])
    for (const effort of [
      undefined,
      null,
      'low',
      'medium',
      'high',
      'xhigh',
      'minimal',
      'max',
      'bogus',
    ])
      add(`override:${b}:${model}:${effort}`, () => mc.overrideArgs(b, { model, effort }));

// externalPlugins
const dir = path.join(SB, 'ext');
const base = {
  version: 1,
  id: 'my-agent',
  displayName: 'My Agent',
  command: '/usr/local/bin/my-agent',
  args: ['acp', '--cwd', '{cwd}'],
  env: ['MY_AGENT_HOME'],
};
const store = new ep.ExternalPluginStore(dir, ['claude', 'codex']);
add('ext:load:missing', () => store.load());
fs.mkdirSync(dir, { recursive: true });
const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
w('my-agent.json', JSON.stringify(base));
w('bad.json', '{"id": ');
w('bom.json', `\uFEFF${JSON.stringify({ ...base, id: 'bom' })}`);
w('mismatch.json', JSON.stringify({ ...base, id: 'other' }));
w('claude.json', JSON.stringify({ ...base, id: 'claude' }));
w('invalid.json', JSON.stringify({ id: 'invalid' }));
w('arr.json', '[1,2]');
w('Zed.json', JSON.stringify({ ...base, id: 'Zed' }));
w('notes.txt', 'x');
fs.mkdirSync(path.join(dir, 'dir.json'));
add('ext:load', () => store.load());
const save = (raw) => {
  const r = store.save(raw);
  return r;
};
add('ext:save:extra', () => save({ ...base, id: 'saved', extra: 1 }));
add('ext:save:ok', () => save({ ...base, id: 'saved', env: undefined }));
add('ext:save:file', () => fs.readFileSync(path.join(dir, 'saved.json'), 'utf8'));
add('ext:save:reserved', () => save({ ...base, id: 'codex' }));
add('ext:save:bad', () => save('nope'));
add('ext:save:null', () => save(null));
for (const [i, id] of ['saved', 'saved', 'dir', '../x', 'Bad', 'a'.repeat(41), 'bad'].entries())
  add(`ext:remove:${i}:${id}`, () => store.remove(id));
add('ext:load:after', () => store.load());

const out = {
  platform: process.platform,
  cases: JSON.parse(JSON.stringify(cases).replaceAll(JSON.stringify(SB).slice(1, -1), '<SB>')),
};
const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'leaves2.json'), `${JSON.stringify(out, null, 1)}\n`);
fs.rmSync(SB, { recursive: true, force: true });
console.log(`recorded ${cases.length} leaf2 cases (${process.platform})`);
