#!/usr/bin/env node
/**
 * Batch 5 batcher parity recorder: drives the real AiContractRouter.ts batchTextChunks with
 * node:test mock timers (setTimeout + Date mocked; microtasks drained via real setImmediate between
 * 1 ms ticks). The fake source sleeps on the same mocked clock and yields scripted chunks at given
 * virtual times, or finishes / throws. Records each output chunk with its virtual emit time and the
 * terminal outcome. Go replay (fake clock): internal/ai/runtime/airouter/batch_parity_test.go.
 *
 * Usage: node --import tsx scripts/parity/record-b5-batch.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock } from 'node:test';
import { setImmediate as realImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { register } from 'tsx/esm/api';

register();
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 从源码逐字截取 mergeableText / FLUSH / batchTextChunks，用 esbuild 去类型后加载：
// 不 import AiContractRouter.ts（它依赖需先构建的 @nomi-ai/contract dist）
const { transformSync } = await import('esbuild');
const routerSrc = readFileSync(
  join(root, 'apps/desktop-electron/internal/ai-runtime/src/AiContractRouter.ts'),
  'utf8',
);
const startIdx = routerSrc.indexOf('function mergeableText(');
const fnIdx = routerSrc.indexOf('export async function* batchTextChunks<');
const endIdx = routerSrc.indexOf('\n}\n', fnIdx) + 3;
if (startIdx < 0 || fnIdx < 0 || endIdx < 3) throw new Error('batchTextChunks source not found');
const { code: batchJs } = transformSync(routerSrc.slice(startIdx, endIdx), {
  loader: 'ts',
  format: 'esm',
});
const { batchTextChunks } = await import(
  'data:text/javascript;base64,' + Buffer.from(batchJs).toString('base64')
);
const spec = JSON.parse(readFileSync(join(root, 'scripts/parity/b5-batch-scenarios.json'), 'utf8'));

const drain = async () => {
  for (let i = 0; i < 20; i++) await realImmediate();
};

const out = [];
for (const sc of spec.scenarios) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const emitted = [];
  let outcome = null;
  async function* source() {
    for (const [at, ev] of sc.events) {
      const wait = at - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (ev === 'done') return;
      if (ev === 'error') throw new Error('boom');
      yield ev;
    }
  }
  const run = (async () => {
    try {
      for await (const c of batchTextChunks(source(), spec.ms))
        emitted.push({ at: Date.now(), chunk: JSON.parse(JSON.stringify(c)) });
      outcome = { at: Date.now(), end: 'done' };
    } catch (e) {
      outcome = { at: Date.now(), end: 'error', message: e.message };
    }
  })();
  const last = Math.max(...sc.events.map((e) => e[0])) + spec.ms * 4;
  await drain();
  for (let t = 0; t < last && !outcome; t++) {
    mock.timers.tick(1);
    await drain();
  }
  await run;
  mock.timers.reset();
  out.push({ name: sc.name, emitted, outcome });
}

const outDir =
  process.env.NOMI_GOLDEN_DIR ||
  join(root, 'apps/desktop-go/internal/ai/runtime/airouter/testdata');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'b5_batch.json');
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${file} (${out.length} scenarios)`);
