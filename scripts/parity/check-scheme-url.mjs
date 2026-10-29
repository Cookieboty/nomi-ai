#!/usr/bin/env node
/** 前端 schemeUrl.ts 与 Go assetproto.GatewayURL 共用换址表的一致性检查（pnpm exec tsx 运行；不一致退出码 1） */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { toGatewayUrl } = await import(pathToFileURL(join(root, 'apps/desktop-go/frontend/src/schemeUrl.ts')).href);
const cases = JSON.parse(readFileSync(join(root, 'apps/desktop-go/internal/core/assetproto/testdata/gateway_urls.json'), 'utf8'));
let bad = 0;
for (const [i, want] of cases) { const got = toGatewayUrl(i); if (got !== want) { bad++; console.error('mismatch', JSON.stringify(i), got, want); } }
console.log(`schemeUrl: ${cases.length - bad}/${cases.length} ok`);
process.exit(bad ? 1 : 0);
