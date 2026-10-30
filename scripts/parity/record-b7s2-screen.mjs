#!/usr/bin/env node
/**
 * 批次 7s2：screen/ScreenService.ts + contract/media.ts 的 screen.checkSend。
 * 记录：checkSend 交给 broker 的 (provider, what) 与返回值；缺服务时的错误；旧目录清理。
 * Go 侧 internal/core/screen/screen_parity_test.go 比对。
 * 输出：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/screen/testdata。
 * Usage: node --import tsx scripts/parity/record-b7s2-screen.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const src = (p) => path.join(root, 'apps/desktop-electron/internal/core/src', p);
const { S, M } = await importSources(root, {
  S: src('screen/ScreenService.ts'),
  M: src('contract/media.ts'),
});

const providers = [
  null,
  { id: 'p1', name: 'Cloud', local: false },
  { id: 'l', name: 'Local', local: true },
];
const answers = [null, 'local_only', 'user_denied', 'ok'];
const cases = [];
for (const locale of ['zh-CN', 'en']) {
  process.env.CD_LOCALE = locale; // fallbackLocale 每次调用时读取
  for (const p of providers) {
    for (const a of answers) {
      const calls = [];
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7s2-scr-'));
      const desktop = {
        providerFor: (role) => (calls.push(['providerFor', role]), p),
        broker: {
          checkSend: async (prov, signal, what) => (
            calls.push(['checkSend', prov, signal ?? null, what]),
            a
          ),
        },
      };
      const svc = new S.ScreenService({
        root: path.join(tmp, 'gone'),
        logger: { info() {}, warn() {} },
        desktop,
      });
      await svc.legacyPurged;
      const h = M.createMediaHandlers({ services: { screen: svc } });
      const out = await h['screen.checkSend']();
      cases.push({ locale, provider: p, answer: a, calls, out });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
// 缺服务
let unavailable;
try {
  await M.createMediaHandlers({ services: {} })['screen.checkSend']();
} catch (e) {
  unavailable = { code: e.code, message: e.message };
}
// 旧目录清理：嵌套文件 / 不存在
const purge = [];
for (const kind of ['tree', 'missing', 'file']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7s2-scr-'));
  const r = path.join(tmp, 'screen-memory');
  if (kind === 'tree') {
    fs.mkdirSync(path.join(r, 'thumbs', 'a'), { recursive: true });
    fs.writeFileSync(path.join(r, 'thumbs', 'a', 'x.png'), 'x');
    fs.writeFileSync(path.join(r, 'index.json'), '{}');
  } else if (kind === 'file') fs.writeFileSync(r, 'f');
  const warns = [];
  const svc = new S.ScreenService({
    root: r,
    logger: { info() {}, warn: (m) => warns.push(m) },
    desktop: {},
  });
  await svc.legacyPurged;
  purge.push({ kind, exists: fs.existsSync(r), warns, siblings: fs.readdirSync(tmp) });
  fs.rmSync(tmp, { recursive: true, force: true });
}
const dir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/screen/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'b7s2-screen.json'),
  JSON.stringify({ cases, unavailable, purge }, null, 1) + '\n',
);
console.log(`b7s2-screen: ${cases.length} cases, ${purge.length} purge`);
