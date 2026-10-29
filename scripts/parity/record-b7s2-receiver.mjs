#!/usr/bin/env node
/**
 * 批次 7s2：DesktopService.receiverOf（委派 / 工具结果接收者；delegate 的 desktop.receiversFor 走它）。
 * Go 侧 internal/core/desktop/receiver_of_parity_test.go 比对。
 * 输出：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/desktop/testdata。
 * Usage: node --import tsx scripts/parity/record-b7s2-receiver.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { D } = await importSources(root, { D: path.join(root, 'packages/core/src/desktop/DesktopService.ts') });
const receiverOf = D.DesktopService.prototype.receiverOf;

const registry = {
  cloud: { name: 'Cloud AI', baseURL: 'https://api.example.com/v1' },
  ollama: { name: 'Ollama', baseURL: 'http://127.0.0.1:11434' },
  lan: { name: 'LAN box', baseURL: 'http://gpu.local:8000' },
  nourl: { name: 'No URL' },
};
const providers = [
  { id: 'cloud' }, { id: 'ollama' }, { id: 'lan' }, { id: 'nourl' }, { id: 'ghost' },
  { id: 'cloud', baseURL: 'http://localhost:1234' }, { id: 'ollama', baseURL: 'https://x.com' },
  { id: 'ghost', baseURL: 'http://[::1]:9/' }, { id: 'ghost', baseURL: 'http://0.0.0.0' }, { id: 'ghost', baseURL: 'not a url' },
];
const cases = [];
for (const withRuntime of [true, false]) {
  const self = withRuntime ? { runtime: { lookupProvider: (id) => registry[id] } } : {};
  for (const p of providers) cases.push({ withRuntime, provider: p, out: receiverOf.call(self, p) });
}
const dir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/desktop/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'b7s2-receiver.json'), JSON.stringify({ registry, cases }, null, 1) + '\n');
console.log(`b7s2-receiver: ${cases.length} cases`);
