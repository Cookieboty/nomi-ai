#!/usr/bin/env node
/**
 * 批次 7s：ig 工具注册表 golden（Go 回放：internal/ai/runtime/igtools/parity_test.go）。
 * 生产装配顺序（defaultIgPlugins + AIRuntimeBoot after）：ToolsBuiltinPlugin(time_now/random/echo) →
 * UserPreferenceMemoryPlugin(exposeAsTools) → AvatarSeamPlugin + CompanionToolsPlugin(autoConfirm) →
 * DesktopToolsPlugin(kb / mem / delegate / ext)。真实 createIgPluginHost + AIClient：
 * - list：client.tools.list()（契约 ToolSpec）+ asSchema(input).jsonSchema
 * - exec：registry.get(name).execute(input, ctx) 的返回 / 抛错 message + 副作用（画像、avatar cue、宿主调用）
 * kb / mem / ext 的 this 为假宿主（Go 侧用同形假宿主回放）；Date.now / Math.random 固定。
 * Usage: node scripts/parity/record-b7s-igtools.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { importSources } from './src-bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const TD = path.join(root, 'apps/desktop-go/internal/ai/runtime/igtools/testdata');
const P = (p) => path.join(root, 'packages', p);
const m = await importSources(root, {
  base: P('bundle-ig-base/src/index.ts'),
  caps: P('bundle-ig-electron-caps/src/plugins/FileSessionStorePlugin.ts'),
  mascot: P('bundle-ig-mascot/src/plugins/AvatarSeamPlugin.ts'),
  companion: P('bundle-ig-mascot/src/plugins/CompanionToolsPlugin.ts'),
  seams: P('bundle-ig-mascot/src/seams/avatar.ts'),
  sdk: P('ai-sdk/src/index.ts'),
  bridge: P('core/src/ai/mascotBridge.ts'),
  desk: P('core/src/desktop/plugin.ts'),
  kb: P('core/src/knowledge/KnowledgeService.ts'),
  mem: P('core/src/memory/MemoryService.ts'),
  ext: P('core/src/extensions/ExtensionsService.ts'),
  dlg: P('core/src/cli/delegate/DelegateService.ts'),
  ighost: P('ai-runtime/src/IgPluginHost.ts'),
  dsvc: P('core/src/desktop/DesktopService.ts'),
});
const req = createRequire(path.join(root, 'packages/core/package.json'));
const { asSchema } = await import(pathToFileURL(req.resolve('ai')).href);
const { createIgPluginHost } = m.ighost;
const { UserPreferenceMemoryPlugin, UserProfileKey, ToolsBuiltinPlugin, ToolRegistryKey, definePlugin } = m.base;
const { AIClient, toSdkContext } = m.sdk;

const NOW = 1_700_000_000_000;
let clock = NOW;
Date.now = () => clock;
const RealDate = Date;
let rnd = [];
Math.random = () => (rnd.length ? rnd.shift() : 0.5);
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet; } };
const J = (v) => (v === undefined ? '@@undef@@' : JSON.parse(JSON.stringify(v)));

// ---- 假宿主（kb / mem / ext 的 this）----
let calls = [];
const st = { send: 'ok', hits: [], mode: 'bm25', memEnabled: true, memText: '', facts: [] };
const kbThis = {
  d: {
    desktop: {
      receiversFor: (p, roles) => (calls.push(['receiversFor', p ?? null, roles]), [{ id: 'r' }]),
      checkSendAll: async () => st.send,
      broker: { markRead: () => calls.push(['markRead']) },
      audit: { append: (e) => calls.push(['audit', e]) },
    },
  },
  search: async (q, l) => (calls.push(['search', q, l]), { hits: st.hits, mode: st.mode }),
};
const memThis = {
  get settings() { return { enabled: st.memEnabled }; },
  context: async (q) => (calls.push(['context', q]), { text: st.memText }),
  audit: (tool, args, result) => calls.push(['audit', tool, args, result ?? 'ok']),
  get data() { return { facts: st.facts.map((text) => ({ text })) }; },
  upsertFact: async (i) => (calls.push(['upsert', i]), { id: 'fact_1' }),
  d: { events: { publish: (ch, p) => calls.push(['publish', ch, p]) } },
};
const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'b7s-igt-')));
const skills = [
  { name: 'alpha', enabled: true, body: '# Alpha\nDo things.', files: ['ref.md', 'bin.dat'] },
  { name: 'off', enabled: false, body: 'x', files: [] },
  { name: 'broken', enabled: true, error: 'bad frontmatter', body: '', files: [] },
];
fs.mkdirSync(path.join(SB, 'alpha', 'sub'), { recursive: true });
fs.writeFileSync(path.join(SB, 'alpha', 'ref.md'), 'reference text ✓');
fs.writeFileSync(path.join(SB, 'alpha', 'bin.dat'), Buffer.from([1, 0, 2]));
const extThis = {
  listSkills: () => skills.map(({ name, enabled, error }) => ({ name, enabled, ...(error ? { error } : {}) })),
  getSkill: (n) => skills.find((s) => s.name === n),
  skillDir: (n) => path.join(SB, n),
  audit: (tool, args, decision, result, source) => calls.push(['audit', tool, args, decision, result, source]),
  d: { events: { publish: (ch, p) => calls.push(['publish', ch, p]) } },
};
const dlgThis = {};
// 生产同形的 DesktopService（临时 userData，假端口）：desktop.tools() 的 23 个 fs_* / desktop_* 工具进注册表
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'b7s-igt-ud-'));
const deskSvc = m.dsvc.createDesktopService(quiet, {
  ports: {
    paths: { home: () => UD, userData: () => UD },
    dialogs: { pickDirectory: async () => null },
    clipboard: { readText: () => '', writeText: () => {} },
    notifications: { isSupported: () => false, show: () => {} },
    processes: { available: () => false },
  },
  events: { publish: () => {}, broadcast: () => {} },
});

async function boot(withHost = true) {
  const SBP = fs.mkdtempSync(path.join(os.tmpdir(), 'b7s-igt-p-'));
  const cues = [];
  const avatarHost = definePlugin({
    name: 'MascotIpcHostPlugin',
    apply(ctx) {
      ctx.inject(m.seams.AvatarKey).attachHost(m.bridge.createIpcMascotHost((cue) => cues.push(cue)));
    },
  });
  const plugins = [
    { plugin: m.caps.FileSessionStorePlugin, config: { rootDir: SBP } },
    { plugin: ToolsBuiltinPlugin, config: { enable: ['time_now', 'random', 'echo'] } },
    { plugin: UserPreferenceMemoryPlugin, config: { exposeAsTools: true } },
    { plugin: m.mascot.AvatarSeamPlugin, config: {} },
    { plugin: m.companion.CompanionToolsPlugin, config: { autoConfirm: true } },
    ...(withHost ? [{ plugin: avatarHost, config: {} }] : []),
    ...m.desk.createDesktopIgPlugins({
      desktop: () => deskSvc,
      kb: () => ({ tools: () => m.kb.KnowledgeService.prototype.tools.call(kbThis) }),
      mem: () => ({ tools: () => m.mem.MemoryService.prototype.tools.call(memThis) }),
      delegate: () => ({ tools: () => m.dlg.DelegateService.prototype.tools.call(dlgThis) }),
      ext: () => ({ tools: () => m.ext.ExtensionsService.prototype.tools.call(extThis), attach: () => {} }),
    }),
  ];
  const host = createIgPluginHost({ logger: quiet });
  await host.apply(plugins);
  await host.ctx.inject(UserProfileKey)?.export();
  const client = new AIClient(toSdkContext(host.ctx), {});
  return { host, client, cues, SBP, reg: host.ctx.inject(ToolRegistryKey), profile: host.ctx.inject(UserProfileKey) };
}

const b = await boot();
const list = J(await b.client.tools.list());
const schemas = {};
for (const t of b.reg.list()) schemas[t.name] = J(await asSchema(t.input).jsonSchema);
const meta = b.reg.list().map((t) => ({ name: t.name, ...(t.readOnly !== undefined ? { readOnly: t.readOnly } : {}), ...(t.requiresWorkspace !== undefined ? { requiresWorkspace: t.requiresWorkspace } : {}) }));

const cases = JSON.parse(fs.readFileSync(path.join(TD, 'b7s-igtools-cases.json'), 'utf8'));
const exec = [];
for (const c of cases) {
  clock = NOW + (c.tick ?? 0);
  rnd = [...(c.rnd ?? [])];
  Object.assign(st, { send: 'ok', hits: [], mode: 'bm25', memEnabled: true, memText: '', facts: [] }, c.st ?? {});
  calls = [];
  b.cues.length = 0;
  if (c.reset) await b.profile.reset();
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [clock]));
    }
    static now() {
      return clock;
    }
  };
  const t = b.reg.get(c.tool);
  const rec = { tool: c.tool };
  try {
    rec.out = J(await t.execute(c.in, { toolCallId: 'tc1', ...(c.provider ? { provider: c.provider } : {}) }));
  } catch (e) {
    rec.err = String(e?.message ?? e);
  }
  globalThis.Date = RealDate;
  Date.now = () => clock;
  await new Promise((r) => setTimeout(r, 0));
  if (calls.length) rec.calls = J(calls);
  if (b.cues.length) rec.cues = J(b.cues);
  if (c.profile) rec.profile = J(b.profile.get());
  exec.push(rec);
}
await b.host.dispose();
fs.rmSync(b.SBP, { recursive: true, force: true });

const out = { list, schemas, meta, exec };
fs.writeFileSync(path.join(TD, 'b7s-igtools.json'), JSON.stringify(out, null, 1).split(JSON.stringify(SB).slice(1, -1)).join('@@SB@@').split(SB).join('@@SB@@') + '\n'); // Windows：JSON 文本里路径反斜杠被转义
fs.rmSync(SB, { recursive: true, force: true });
fs.rmSync(UD, { recursive: true, force: true });
console.log(`b7s-igtools: ${list.length} tools, ${exec.length} exec cases`);
