#!/usr/bin/env node
/**
 * shell.ts（packages/contract/src/app/shell.ts）中 Go 版移植的服务：确定性行为（入参、返回形状、错误、落盘配置）golden。
 * 场景随 golden 写出，Go 端（internal/core/shellhandlers/shell_parity_test.go）逐步回放、全等比对。
 * CI 各平台由 record-b7-drivers.mjs 的 NOMI_GOLDEN_DIR 段链式调用现场录制。
 * Usage: node --import tsx scripts/parity/record-shell.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-shell-')));
const core = (p) => import(pathToFileURL(path.join(root, 'packages/core/src', p)).href);
const NOW = Date.UTC(2026, 9, 29, 10, 0, 0, 123);
const H = 3600_000;

/** 诊断：dev/env/legacy/初始文件 × 步骤 */
export const DIAG = [
  { name: 'packagedDefault', dev: false, steps: [['view'], ['file']] },
  { name: 'devForced', dev: true, steps: [['view'], ['set', false], ['set', true], ['view'], ['file'], ['changes']] },
  { name: 'toggle', dev: false, steps: [['set', true], ['file'], ['set', true], ['set', false], ['file'], ['changes']] },
  { name: 'bodyOff', dev: false, env: { NOMI_DIAG_BODY: '0' }, steps: [['set', true], ['view']] },
  { name: 'bodyOne', dev: false, env: { NOMI_DIAG_BODY: '1' }, steps: [['set', true], ['view']] },
  { name: 'legacyOn', dev: false, observe: '{"trace":true}', steps: [['view'], ['file']] },
  { name: 'legacyTruthy', dev: false, observe: '{"trace":1}', steps: [['view'], ['file']] },
  { name: 'legacyBad', dev: false, observe: 'nope', steps: [['view'], ['file']] },
  { name: 'fileTrue', dev: false, file: '{"version":1,"saveLogs":true}', observe: '{"trace":false}', steps: [['view']] },
  { name: 'fileString', dev: false, file: '{"saveLogs":"true"}', steps: [['view']] },
  { name: 'fileNull', dev: false, file: 'null', steps: [['view']] },
  { name: 'fileBad', dev: false, file: '{', steps: [['view'], ['set', false], ['file']] },
  { name: 'openOk', dev: false, steps: [['open', ''], ['logDirExists']] },
  { name: 'openErr', dev: false, steps: [['open', 'Failed to open path']] },
  { name: 'exportCancel', dev: false, steps: [['export', null], ['saveCalls']] },
  {
    name: 'exportFiles', dev: false,
    files: [
      ['logs', 'app.log', 'hello Bearer abcdefghijklmnop sk-abcdefghijklmnop\n', 1],
      ['logs', 'app.1.log', 'old\n', 30],
      ['logs', 'app.2.log', 'recent key=AIzaSyA0123456789012345678901\n', 2],
      ['logs', 'cli-2026-10-29.jsonl', '{"a":"nomi-gw-abcdefgh"}\n', 0.5],
      ['logs', 'cli-2026-10-29.txt', 'ignored\n', 0.5],
      ['logs', 'other.log', 'ignored\n', 0.5],
      ['trace', 'b.json', '{"x":"https://h/?api_key=zzz&q=1"}', 3],
      ['trace', 'a.json', '{}', 23.9],
      ['trace', 'c.json', '{}', 24.1],
      ['trace', 'd.txt', 'x', 1],
    ],
    steps: [['export', 'out.zip'], ['saveCalls'], ['zip', 'out.zip']],
  },
  { name: 'exportEmpty', dev: false, steps: [['export', 'empty.zip'], ['zip', 'empty.zip']] },
  { name: 'exportNoDir', dev: false, steps: [['export', 'nodir/x.zip']] },
];

const norm = (v) =>
  JSON.parse(
    JSON.stringify(v === undefined ? null : v)
      .split(JSON.stringify(SB).slice(1, -1))
      .join('<SB>'),
  );

async function recordDiag() {
  const { DiagnosticsService } = await core('diagnostics/DiagnosticsService.ts');
  const { readLegacyGatewayTrace } = await core('usage/GatewayRequestLog.ts');
  const { unzipSync, strFromU8 } = await import('fflate');
  const out = [];
  for (const sc of DIAG) {
    const ud = path.join(SB, 'diag', sc.name);
    fs.mkdirSync(path.join(ud, 'gateway'), { recursive: true });
    if (sc.observe !== undefined) fs.writeFileSync(path.join(ud, 'gateway', 'observe.json'), sc.observe);
    if (sc.file !== undefined) fs.writeFileSync(path.join(ud, 'diagnostics.json'), sc.file);
    for (const [d, n, body, ageH] of sc.files ?? []) {
      const dir = d === 'logs' ? path.join(ud, 'logs') : path.join(ud, 'gateway', 'trace');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, n), body);
      const t = new Date(NOW - ageH * H);
      fs.utimesSync(path.join(dir, n), t, t);
    }
    const changes = [];
    const saveCalls = [];
    let saveRet = null;
    let openRet = '';
    const logger = { info() {}, warn() {}, setLevel() {} };
    const svc = new DiagnosticsService({
      userData: ud,
      logger,
      dev: sc.dev,
      env: sc.env ?? {},
      now: () => NOW,
      legacyEnabled: () => readLegacyGatewayTrace(path.join(ud, 'gateway')),
      onChange: (on) => changes.push(on),
      ports: {
        app: { isPackaged: () => !sc.dev, version: () => '2.0.5-test' },
        dialogs: {
          saveFile: async (o) => {
            saveCalls.push({ defaultPath: o.defaultPath, filters: o.filters, parent: o.parent });
            return saveRet;
          },
        },
        shell: { openPath: async () => openRet },
      },
    });
    svc.cliTrace.dispose?.();
    const log = [];
    for (const st of sc.steps) {
      const [op, a] = st;
      let r;
      try {
        if (op === 'view') r = svc.view();
        else if (op === 'set') r = svc.set(a);
        else if (op === 'file') {
          const f = path.join(ud, 'diagnostics.json');
          r = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
        } else if (op === 'changes') r = changes;
        else if (op === 'open') {
          openRet = a;
          r = await svc.openLogFolder();
        } else if (op === 'logDirExists') r = fs.existsSync(path.join(ud, 'logs'));
        else if (op === 'export') {
          saveRet = a === null ? null : path.join(ud, a);
          r = await svc.exportBundle();
        } else if (op === 'saveCalls') r = saveCalls;
        else if (op === 'zip') {
          const z = unzipSync(fs.readFileSync(path.join(ud, a)));
          r = Object.entries(z).map(([k, v]) => [k, strFromU8(v)]);
        }
        log.push({ op, ok: norm(r) });
      } catch (e) {
        log.push({ op, err: norm(String(e?.message ?? e)) });
      }
    }
    out.push({ ...sc, log });
  }
  return { now: NOW, version: '2.0.5-test', platform: process.platform, scenarios: out };
}

/** appIcon：stub electron（nativeImage / BrowserWindow / app），按平台 × 初始配置 × 步骤录制落盘与 apply 调用 */
export const ICON = [
  { name: 'missing', steps: [['get'], ['set', 'cream'], ['file'], ['get'], ['set', 'nope'], ['file'], ['set', ''], ['set', 'ink']] },
  { name: 'ink', file: '{"variant":"ink"}', steps: [['get']] },
  { name: 'bogus', file: '{"variant":"bogus"}', steps: [['get']] },
  { name: 'badJson', file: '{', steps: [['get'], ['set', 'sunset'], ['file']] },
  { name: 'nullJson', file: 'null', steps: [['get']] },
  { name: 'upper', file: '{"variant":"INK"}', steps: [['get'], ['set', 'Cream']] },
  { name: 'unwritable', file: 'dir', steps: [['set', 'ink'], ['get']] },
];

async function recordIcon() {
  const assets = path.join(root, 'packages/host-electron/assets');
  const rel = (p) => path.relative(assets, p).split(path.sep).join('/');
  let applies = [];
  const wins = [
    { isDestroyed: () => false, setIcon: (img) => applies.push(['win0.setIcon', rel(img.p)]), setAppDetails: (o) => applies.push(['win0.setAppDetails', { ...o, appIconPath: rel(o.appIconPath) }]) },
    { isDestroyed: () => true, setIcon: () => applies.push(['win1.setIcon']) },
  ];
  const img = (p) => ({ p, resize: (o) => ({ toDataURL: () => `preview:${rel(p)}:${JSON.stringify(o)}` }) });
  const electron = {
    app: { isPackaged: false, dock: { setIcon: (i) => applies.push(['dock.setIcon', rel(i.p)]) }, on: () => {} },
    BrowserWindow: { getAllWindows: () => wins },
    nativeImage: { createFromPath: img },
  };
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'electron' ? electron : orig.call(this, req, ...rest);
  };
  const mod = createRequire(import.meta.url)(path.join(root, 'packages/host-electron/src/core/appIcon.ts'));
  mod.onTrayIcon((i) => applies.push(['tray', rel(i.p)]));
  const plat = Object.getOwnPropertyDescriptor(process, 'platform');
  const out = [];
  for (const platform of ['darwin', 'win32', 'linux']) {
    Object.defineProperty(process, 'platform', { value: platform });
    for (const sc of ICON) {
      const ud = path.join(SB, 'icon', platform, sc.name);
      fs.mkdirSync(ud, { recursive: true });
      const f = path.join(ud, 'app-icon.json');
      if (sc.file === 'dir') fs.mkdirSync(f);
      else if (sc.file !== undefined) fs.writeFileSync(f, sc.file);
      applies = [];
      mod.initAppIcon(f);
      const log = [{ op: 'init', applies }];
      for (const [op, a] of sc.steps) {
        applies = [];
        let r;
        if (op === 'get') r = mod.appIconState();
        else if (op === 'set') r = mod.setIconVariant(a);
        else if (op === 'file') r = fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null;
        log.push({ op, arg: a, ok: norm(r), applies });
      }
      out.push({ platform, name: sc.name, file: sc.file, log });
    }
  }
  Object.defineProperty(process, 'platform', plat);
  Module._load = orig;
  return { scenarios: out };
}

const dir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/shellhandlers/testdata');
fs.mkdirSync(dir, { recursive: true });
const diag = await recordDiag();
fs.writeFileSync(path.join(dir, 'shell_diagnostics.json'), JSON.stringify(diag, null, 1) + '\n');
console.log(`record-shell: diagnostics ${diag.scenarios.length} scenarios, ${diag.scenarios.reduce((a, s) => a + s.log.length, 0)} steps`);
const icon = await recordIcon();
fs.writeFileSync(path.join(dir, 'shell_appicon.json'), JSON.stringify(icon, null, 1) + '\n');
console.log(`record-shell: appIcon ${icon.scenarios.length} scenarios`);
fs.rmSync(SB, { recursive: true, force: true });
