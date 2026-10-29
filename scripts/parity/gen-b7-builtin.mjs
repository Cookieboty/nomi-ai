#!/usr/bin/env node
/**
 * 批次 7：把 @nomi-ai/cli-plugins 的纯数据（BUILTIN_CLI_IDS / BUILTIN_MANIFESTS / BUILTIN_RENDERER /
 * BUILTIN_GATEWAY_ENTRIES）导出为 Go 嵌入 JSON：
 *   apps/desktop-go/internal/cliplugins/builtin/builtin.json
 * 由 Node 直接生成 → 与 TS 源逐字节同构。改 TS 清单后重跑本脚本（先 build cli-sdk、cli-plugins）。
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const req = createRequire(join(root, 'packages/core/package.json'));
const I = req('@nomi-ai/cli-plugins');
const G = req('@nomi-ai/cli-plugins/gateways');
const data = {
  ids: I.BUILTIN_CLI_IDS,
  manifests: I.BUILTIN_MANIFESTS,
  renderers: I.BUILTIN_RENDERER,
  gatewayEntries: G.BUILTIN_GATEWAY_ENTRIES,
};
const file = join(root, 'apps/desktop-go/internal/cliplugins/builtin/builtin.json');
writeFileSync(file, JSON.stringify(data, null, 1) + '\n');
console.log('wrote', file, Object.keys(data.manifests));
