#!/usr/bin/env node
/**
 * 批次 7 服务 b7s2（6）：@nomi-ai/cli-plugins 的 manifest / renderer / gateway / gatewaySpec / exec / text
 * 直接从 TS 源录制 golden（NOMI_GOLDEN_DIR 优先）。CI 由 record-b7-drivers.mjs 链式录制。
 * Usage: node --import tsx scripts/parity/record-b7s2-plugins.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const src = (p) => pathToFileURL(path.join(root, 'packages/cli-plugins/src', p)).href;
const I = await import(src('index.ts'));
const G = await import(src('gateways.ts'));
const GS = await import(src('shared/gatewaySpec.ts'));
const R = await import(src('shared/renderer.ts'));
const E = await import(src('shared/exec.ts'));
const T = await import(src('shared/text.ts'));
const CLIS = ['claude', 'codex', 'dsh', 'gemini', 'grok'];
const per = {};
for (const id of CLIS) {
  const m = await import(src(`${id}/manifest.ts`));
  const r = await import(src(`${id}/renderer.ts`));
  const g = await import(src(`${id}/gateway.ts`));
  per[id] = {
    manifest: m.manifest, renderer: r.renderer, gateway: g.gateway,
    // 引用关系（同一对象）
    sameManifest: I.BUILTIN_MANIFESTS[id] === m.manifest,
    sameRenderer: I.BUILTIN_RENDERER[id] === r.renderer,
    capsShared: r.renderer.capabilities === m.manifest.capabilities,
    sessionKeyShared: g.gateway.clientSpec.sessionKey === GS.DEFAULT_SESSION_KEY,
    gatewayIndex: G.BUILTIN_GATEWAY_ENTRIES.indexOf(g.gateway),
  };
}
const synth = [
  { id: 'x', displayName: 'X', icon: 'i', capabilities: {}, modelSwitch: 'restart', extra: 1 },
  { id: 'y', displayName: 'Y', icon: 'j', capabilities: { permissionModes: [{ mode: 'plan', args: ['a'] }, { mode: 'bypass' }], images: 'none' } },
  { id: 'z', capabilities: { permissionModes: [] } },
];
const fns = [];
for (const m of synth) fns.push({ fn: 'rendererInfo', args: [m], out: R.rendererInfo(m) });
const evs = [{ type: 'done', usage: { a: 1 } }, { type: 'done' }, { type: 'done', usage: null }, { type: 'done', usage: 0 }, { type: 'done', usage: '' }, { type: 'done', usage: 'x' }, { type: 'done', usage: [] }, { type: 'text', usage: {} }, {}];
for (const ev of evs) fns.push({ fn: 'usageDone', args: [ev], out: E.USAGE_DONE.completes(ev) });
const titles = [['hello world'], [undefined], [''], ['  a  \n b '], ['x'.repeat(100)], ['x'.repeat(80)], ['x'.repeat(81)], ['abcdef', 3], ['😀'.repeat(50), 10],
  ['<command-name>/review</command-name><command-args>pr 3</command-args>'], ['<system-reminder>x</system-reminder>'], ['<environment_context>x'], ['  # agents.md hi'], ['<INSTRUCTIONS>'], ['   '], ['a\u00a0\u2028b']];
for (const a of titles) { const out = T.cleanTitle(...a); fns.push({ fn: 'cleanTitle', args: a, out: out === undefined ? '<undefined>' : out }); }
const data = {
  ids: I.BUILTIN_CLI_IDS, manifests: I.BUILTIN_MANIFESTS, renderers: I.BUILTIN_RENDERER, gatewayEntries: G.BUILTIN_GATEWAY_ENTRIES,
  defaultSessionKey: GS.DEFAULT_SESSION_KEY, per, fns,
  isBuiltin: ['claude', 'grok', 'x', '', null, 1].map((v) => I.isBuiltinCliId(v)),
};
const outDir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/cliplugins/builtin/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'b7s2-plugins.json'), `${JSON.stringify(data, null, 1)}\n`);
console.log(`b7s2-plugins: ${CLIS.length} plugins, ${G.BUILTIN_GATEWAY_ENTRIES.length} gateway entries, ${fns.length} fns`);
