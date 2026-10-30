#!/usr/bin/env node
/**
 * 批次 10 golden parity：Node 的 mascotSize / sanitizeIsland / CharacterPackService.getActive
 * 在固定输入上的输出，写到 apps/desktop-go/internal/core/mascothandlers/testdata/parity.json。
 * Go 侧（mascothandlers/parity_test.go）回放同样的输入并比对（JSON 规范化后逐字段相同）。
 *
 * 用法：pnpm exec tsx scripts/parity/record-mascot.mjs
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'apps/desktop-go/internal/core/mascothandlers/testdata/parity.json');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const size = await imp('packages/core/src/mascot/mascotSize.ts');
const { sanitizeIsland } = await imp('apps/desktop-electron/src/island/IslandService.ts').catch(
  async () => ({ sanitizeIsland: null }),
);
const { CharacterPackService } = await imp('packages/core/src/character/CharacterPackService.ts');

const area = (x, y, w, h, sf) => ({
  x,
  y,
  width: w,
  height: h,
  ...(sf ? { scaleFactor: sf } : {}),
});
const scales = [null, 'x', -1, 0, 0.3, 0.42, 0.5, 0.55, 1, 1.49, 1.5, 2, 99];
const caps = [0.3, 0.8, 1.5, 3];
const fixture = {
  clamp: scales.map((v) => ({ in: v, out: size.clampMascotScale(v) })),
  windowSize: scales
    .filter((v) => typeof v === 'number')
    .map((v) => ({ in: v, out: size.mascotWindowSize(v) })),
  maxScale: [
    null,
    area(0, 0, 1920, 1040),
    area(0, 0, 1366, 728),
    area(0, 0, 800, 400),
    area(0, 0, 0, 0),
  ].map((a) => ({ in: a, out: size.maxScaleForArea(a) })),
  fit: scales.flatMap((v) => caps.map((c) => ({ in: [v, c], out: size.fitMascotScale(v, c) }))),
  step: [0.3, 0.35, 0.5, 0.9, 1.5].flatMap((v) =>
    [1, -1].flatMap((d) =>
      caps.map((c) => ({ in: [v, d, c], out: size.stepMascotScale(v, d, c) })),
    ),
  ),
  wheel: [0.5, 1].flatMap((v) =>
    [
      [0, 0],
      [-120, 0],
      [120, 0],
      [-3, 1],
      [2, 2],
      [-1000, 0],
    ].map(([dy, dm]) => ({
      in: [v, dy, dm, 1.5],
      out: size.wheelMascotScale(v, dy, dm, 1.5),
    })),
  ),
  maxTop: [
    area(0, 0, 1920, 1040),
    area(0, 0, 1920, 1040, 1.25),
    area(0, 25, 1366, 743, 1.5),
  ].flatMap((a) => [355, 357, 401].map((h) => ({ in: [a, h], out: size.maxTopInArea(a, h) }))),
  resize: [
    { bounds: { x: 100, y: 600, width: 330, height: 355 }, fromScale: 0.5, toScale: 1 },
    {
      bounds: { x: 100, y: 600, width: 330, height: 355 },
      fromScale: 0.5,
      toScale: 0.3,
      box: { left: 70, right: 260, top: 140, bottom: 350 },
    },
    {
      bounds: { x: 1700, y: 700, width: 330, height: 355 },
      fromScale: 0.5,
      toScale: 1.5,
      workAreas: [area(0, 0, 1920, 1040)],
    },
    {
      bounds: { x: -50, y: 0, width: 330, height: 355 },
      fromScale: 0.5,
      toScale: 1,
      workAreas: [area(0, 0, 1920, 1040), area(1920, 0, 1280, 1000, 1.25)],
    },
    {
      bounds: { x: 2500, y: 900, width: 540, height: 580 },
      fromScale: 1,
      toScale: 0.5,
      box: { left: 60, right: 480, top: 130, bottom: 580 },
      workAreas: [area(0, 0, 1920, 1040), area(1920, 0, 1280, 1000, 1.25)],
    },
  ].map((i) => ({ in: i, out: size.resizeMascotBounds(i) })),
};

if (sanitizeIsland) {
  const raws = [
    undefined,
    {},
    { enabled: true },
    { enabled: 'yes', style: 'pill', kinds: { message: false } },
    { style: 'notch', kinds: { agent: 0, reminder: false } },
  ];
  fixture.island = raws.flatMap((r) =>
    ['darwin', 'linux', 'win32'].map((p) => ({ in: [r ?? null, p], out: sanitizeIsland(r, p) })),
  );
}

// 角色包：内置 nomi；以及以 nomi 为底、改了 manifest 的 userData 覆盖包
const nomi = join(root, 'characters/nomi');
const baseManifest = JSON.parse(readFileSync(join(nomi, 'manifest.json'), 'utf8'));
const overlays = {
  none: null,
  overlay: {
    ...baseManifest,
    id: 'fixture-pack',
    displayName: { zh: '测试', en: 'Fixture' },
    assets: { ...baseManifest.assets, voice: 'voice' },
    rive: undefined,
    layout: {
      window: { width: 420, height: 450 },
      hitboxes: { head: { top: 0, bottom: 0.3, left: 0.2, right: 0.8 } },
      bubbleAnchor: { x: 0.5, y: 0.1 },
    },
  },
};
fixture.character = {};
for (const [name, manifest] of Object.entries(overlays)) {
  const ud = mkdtempSync(join(tmpdir(), 'b10-ud-'));
  if (manifest) {
    const p = join(ud, 'character-pack');
    cpSync(nomi, p, { recursive: true });
    writeFileSync(join(p, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const svc = new CharacterPackService({
    ports: {
      paths: { userData: () => ud, resources: () => '', appPath: () => root },
      app: { isPackaged: () => false },
    },
    builtinPackDir: nomi,
  });
  svc.reload();
  fixture.character[name] = { manifest, out: JSON.parse(JSON.stringify(svc.getActive())) };
  rmSync(ud, { recursive: true, force: true });
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('wrote', out);
