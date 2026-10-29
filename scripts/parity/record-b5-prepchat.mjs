#!/usr/bin/env node
/**
 * Batch 5 prepareChat parity recorder (D-B5-10): drives the real applyConversationWorkspace
 * (workspaceTools.ts), guardOutboundMessages (outboundGuard.ts) and DesktopService.receiversFor /
 * checkSendAll (prototype methods on a fake `this`), composed exactly like createCore.ts
 * prepareChat. Fake broker: workspaceOf / autoApprove / checkSend per scenario.
 * Records final options, error message, workspaceOf and checkSend calls.
 * Go replay: internal/core/desktop/chat_prep_parity_test.go.
 * CI records per platform (NOMI_GOLDEN_DIR, chained from record-b7-drivers.mjs).
 *
 * Usage: node --import tsx scripts/parity/record-b5-prepchat.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (p) => import(pathToFileURL(join(root, 'packages/core/src', p)).href);
const { applyConversationWorkspace } = await core('desktop/workspaceTools.ts');
const { guardOutboundMessages } = await core('desktop/outboundGuard.ts');
// DesktopService.ts 依赖 @nomi-ai/gateway 构建产物（CI 录制步骤不构建）：从源码原样截取 receiversFor / checkSendAll 两个方法，
// 用 esbuild 去类型后挂到最小类上（方法体不改一字）
const { transformSync } = await import('esbuild');
const dsSrc = readFileSync(join(root, 'packages/core/src/desktop/DesktopService.ts'), 'utf8');
const method = (head) => {
  const i = dsSrc.indexOf(head);
  if (i < 0) throw new Error(`DesktopService.${head} not found`);
  let depth = 0;
  for (let j = dsSrc.indexOf('{', dsSrc.indexOf(')', i)); j < dsSrc.length; j++) {
    if (dsSrc[j] === '{') depth++;
    else if (dsSrc[j] === '}' && --depth === 0) return dsSrc.slice(i, j + 1);
  }
  throw new Error('unbalanced');
};
const cls = `class DS {\n${method('  receiversFor(')}\n${method('  async checkSendAll(')}\n}\nexport default DS;`;
const js = transformSync(cls, { loader: 'ts', format: 'esm' }).code;
const DesktopService = (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).default;
const spec = JSON.parse(readFileSync(join(root, 'scripts/parity/b5-prepchat-scenarios.json'), 'utf8'));

const out = [];
for (const sc of spec.scenarios) {
  const calls = [];
  const broker = {
    workspaceOf: async (cwd) => {
      calls.push({ op: 'workspaceOf', cwd: cwd ?? null });
      return (typeof cwd === 'string' && sc.workspaces?.[cwd]) || null;
    },
    autoApprove: () => !!sc.autoApprove,
    checkSend: async (p, _signal, what) => {
      calls.push({ op: 'checkSend', id: p.id, what });
      if (p.local) return null;
      return sc.verdicts?.[p.id] ?? null;
    },
  };
  const desktop = {
    broker,
    providerFor: (r) => sc.providers?.[r] ?? null,
    receiversFor: DesktopService.prototype.receiversFor,
    checkSendAll: DesktopService.prototype.checkSendAll,
  };
  const services = { desktop };
  // === createCore.ts prepareChat（逐字） ===
  const prepareChat = async (options, method, signal) => {
    if (services.desktop) await applyConversationWorkspace(options, services.desktop.broker);
    return guardOutboundMessages(options.messages, (what) => {
      const desktop = services.desktop;
      const fallback = method.startsWith('agent') ? 'agent-tools' : 'chat';
      const role =
        options.role === 'chat' || options.role === 'agent-tools' || options.role === 'summary' ? options.role : fallback;
      return desktop.checkSendAll(desktop.receiversFor(undefined, [role]), signal, what);
    });
  };
  const options = JSON.parse(JSON.stringify(sc.options));
  let error = null;
  try {
    await prepareChat(options, sc.method, undefined);
  } catch (e) {
    error = e.message;
  }
  out.push({ name: sc.name, options, error, calls });
}

const outDir = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/desktop/testdata');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'b5_prepchat.json');
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${file} (${out.length} scenarios)`);
