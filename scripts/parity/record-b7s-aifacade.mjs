#!/usr/bin/env node
/**
 * AI 门面 golden（Go 回放：internal/ai/runtime/aifacade/aifacade_parity_test.go）。
 * 真实 createAiRouter（契约 implement：入参 / 出参 / 事件校验）+ new AIClient(ctx) + 主进程同款插件：
 * FileSessionStorePlugin(rootDir=沙箱) → UserPreferenceMemoryPlugin → AvatarSeamPlugin + MascotIpcHost（avatar.event 记录）。
 * 引导期同 createAiSdkBooter：apply 后 UserProfileKey.export()。Date.now 固定；会话 id 由 Go 侧按出现序替换。
 * 每步记录：输出 / 错误（code + message）、期间的契约事件、可选的画像文件内容。
 *
 * Usage: node scripts/parity/record-b7s-aifacade.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importSources } from './src-bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const TD = path.join(root, 'apps/desktop-go/internal/ai/runtime/aifacade/testdata');
const P = (p) => path.join(root, 'packages', p);
const m = await importSources(root, {
  base: P('bundle-ig-base/src/index.ts'),
  caps: P('bundle-ig-electron-caps/src/plugins/FileSessionStorePlugin.ts'),
  mascot: P('bundle-ig-mascot/src/plugins/AvatarSeamPlugin.ts'),
  seams: P('bundle-ig-mascot/src/seams/avatar.ts'),
  sdk: P('ai-sdk/src/index.ts'),
  router: P('ai-runtime/src/AiContractRouter.ts'),
  wire: P('contract/src/wire.ts'),
  bridge: P('core/src/ai/mascotBridge.ts'),
  ighost: P('ai-runtime/src/IgPluginHost.ts'),
});
const { createIgPluginHost } = m.ighost;
const { UserPreferenceMemoryPlugin, UserProfileKey, ToolsBuiltinPlugin, ToolRegistryKey, definePlugin } = m.base;
const { AIClient, toSdkContext } = m.sdk;

const NOW = 1_700_000_000_000;
let clock = NOW;
Date.now = () => clock;
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet; } };

const scenarios = JSON.parse(fs.readFileSync(path.join(TD, 'b7s-aifacade-scenarios.json'), 'utf8'));
const PROFILE = ['ai-chat', 'memory', 'user_profile.json'];

async function run(sc) {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7s-aif-'));
  const pf = path.join(SB, ...PROFILE);
  if (sc.file !== undefined) {
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.writeFileSync(pf, sc.file);
  }
  clock = NOW;
  const events = [];
  const avatarHost = definePlugin({
    name: 'MascotIpcHostPlugin',
    apply(ctx) {
      const svc = ctx.inject(m.seams.AvatarKey);
      svc.attachHost(m.bridge.createIpcMascotHost((cue) => events.push({ event: 'avatar.event', data: cue })));
    },
  });
  const plugins = [{ plugin: m.caps.FileSessionStorePlugin, config: { rootDir: SB } }];
  if (sc.registry !== false) plugins.push({ plugin: ToolsBuiltinPlugin, config: { enable: [] } });
  if (sc.profile !== false) plugins.push({ plugin: UserPreferenceMemoryPlugin, config: { exposeAsTools: false } });
  if (sc.avatar !== false) {
    plugins.push({ plugin: m.mascot.AvatarSeamPlugin, config: {} });
    if (sc.host !== false) plugins.push({ plugin: avatarHost, config: {} });
  }
  const host = createIgPluginHost({ logger: quiet });
  await host.apply(plugins);
  await host.ctx.inject(UserProfileKey)?.export();
  for (const t of sc.tools ?? []) host.ctx.inject(ToolRegistryKey).register({ ...t, input: undefined, execute: async () => null });
  const client = new AIClient(toSdkContext(host.ctx), {});
  const { router, dispose } = m.router.createAiRouter({ client, logger: { warn() {}, info() {}, error() {}, debug() {} } });
  for (const e of Object.keys(router.contract.events ?? {})) {
    if (!e.startsWith('ai.')) continue;
    router.events.subscribe(e, (data) => events.push({ event: e, data }));
  }
  const steps = [];
  const ids = [];
  for (const st of sc.steps) {
    if (st.tick) clock += st.tick;
    const rec = { p: st.p ?? null };
    if (st.p) {
      const input = 'in' in st ? m.wire.decodeWireFrame(JSON.stringify(st.in).replace(/"\$s(\d+)"/g, (_, n) => JSON.stringify(ids[n - 1]))) : undefined;
      try {
        const out = await router.call(st.p, input, { caller: { trusted: st.untrusted !== true, surface: 'chat' } });
        rec.out = out === undefined ? null : JSON.parse(m.wire.encodeWireFrame(out));
        if (out === undefined) rec.undef = true;
        for (const id of JSON.stringify(out ?? null).match(/sess_[0-9a-z]+_[0-9a-z]+/g) ?? []) if (!ids.includes(id)) ids.push(id);
      } catch (err) {
        rec.err = { code: err.code ?? 'INTERNAL', message: err.message };
      }
    }
    await new Promise((r) => setTimeout(r, 0));
    if (events.length) rec.events = JSON.parse(m.wire.encodeWireFrame(events.splice(0)));
    if (st.dump) rec.file = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : null;
    steps.push(rec);
  }
  dispose();
  await host.dispose();
  fs.rmSync(SB, { recursive: true, force: true });
  return { name: sc.name, steps };
}

const out = [];
for (const sc of scenarios) out.push(await run(sc));
fs.writeFileSync(path.join(TD, 'b7s-aifacade.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`b7s-aifacade: ${out.length} scenarios, ${out.reduce((n, s) => n + s.steps.length, 0)} steps`);
