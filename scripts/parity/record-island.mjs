#!/usr/bin/env node
/** island golden parity（Node 录制）→ apps/desktop-go/internal/core/island/testdata/island.json
 *  - sanitizeIsland：IslandService.ts 依赖 electron，无法直接 import；这里从源码切出 defaultIslandSettings + sanitizeIsland
 *    两个纯函数（逐字），用 esbuild 去类型后执行，保证与 Node 源码 1:1。
 *  - hasNotch / islandGeometry(...).mode：geometry.ts 是纯模块，直接 import（D-B10-1 刘海检测）。
 *  用法：pnpm exec tsx scripts/parity/record-island.mjs */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'packages/host-electron/src/island/IslandService.ts'), 'utf8');
const a = src.indexOf('export const defaultIslandSettings'), b = src.indexOf('\ntype Deps');
if (a < 0 || b < a) throw new Error('sanitizeIsland 源码定位失败');
const { code } = await transform(src.slice(a, b), { loader: 'ts', format: 'esm' });
const { sanitizeIsland } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const geo = await import(pathToFileURL(join(root, 'packages/host-electron/src/island/geometry.ts')).href);

const vals = [undefined, null, true, false, 0, 1, 'yes', 'true', [], {}];
const styles = [undefined, 'pill', 'auto', 'notch', 'PILL', 1, null];
const kindsV = [undefined, null, 'x', [], {}, { message: false }, { agent: 0, reminder: false }, { message: true, agent: false, reminder: 'no' }];
const sanitize = [];
for (const plat of ['darwin', 'linux', 'win32'])
  for (const enabled of vals) for (const style of styles) for (const kinds of kindsV) {
    const input = JSON.stringify({ enabled, style, kinds });
    sanitize.push({ plat, input, out: sanitizeIsland(JSON.parse(input), plat) });
  }
for (const plat of ['darwin', 'linux']) for (const raw of ['null', '[]', '1', '"s"', 'true', '[{"enabled":true}]'])
  sanitize.push({ plat, input: raw, out: sanitizeIsland(JSON.parse(raw), plat) });

const notch = [];
for (const plat of ['darwin', 'linux', 'win32'])
  for (const menuBar of [0, 24, 25, 29, 29.5, 30, 37, 38, 60]) for (const by of [0, -900, 1080])
    for (const internal of [undefined, true, false]) for (const style of ['auto', 'pill']) {
      const d = { bounds: { x: 0, y: by, width: 1512, height: 982 }, workArea: { x: 0, y: by + menuBar, width: 1512, height: 982 - menuBar }, internal };
      notch.push({ plat, display: d, style, hasNotch: geo.hasNotch(plat, d), mode: geo.islandGeometry(plat, d, style).mode });
    }
const outFile = join(root, 'apps/desktop-go/internal/core/island/testdata/island.json');
writeFileSync(outFile, JSON.stringify({ sanitize, notch }).replace(/},{"plat/g, '},\n{"plat') + '\n');
console.log('island: sanitize', sanitize.length, 'notch', notch.length);
