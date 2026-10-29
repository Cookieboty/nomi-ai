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

/**
 * 更新：假更新器（脚本化 checkForUpdates / downloadUpdate / quitAndInstall）+ 假时钟（setTimeout / setInterval / Date.now）。
 * check 行为：{emit:[[事件, 参数]], ret:'token'|'null'|'none'} 或 {throw:消息, code?} 或 {throwStr:消息}
 */
const E = (msg, code) => ({ throw: msg, code });
const INFO = { version: '2.0.6', releaseName: 'v2.0.6', releaseNotes: 'notes' };
const MISSING = 'Cannot find latest-mac.yml in the latest release artifacts (https://x/latest-mac.yml): HttpError: 404';
export const UPD = [
  { name: 'unpackaged', packaged: false, steps: [['start'], ['get'], ['check'], ['download'], ['install'], ['setAutoCheck', { on: false }], ['file'], ['advance', 20 * H]] },
  { name: 'launchAndInterval', packaged: true, checks: [{ emit: [['checking-for-update'], ['update-not-available', INFO]], ret: 'null' }, { emit: [['checking-for-update'], ['update-not-available', INFO]], ret: 'none' }],
    steps: [['start'], ['start'], ['advance', 14_999], ['advance', 1], ['advance', 6 * H], ['get']] },
  { name: 'availableDownload', packaged: true, checks: [{ emit: [['checking-for-update'], ['update-available', INFO]], ret: 'token' }],
    steps: [['start'], ['check'], ['emit', 'download-progress', { percent: 12.5, bytesPerSecond: 1000, transferred: 125, total: 1000 }], ['emit', 'update-downloaded', { version: '2.0.6', releaseName: null }], ['install'], ['get']] },
  { name: 'notesNonString', packaged: true, checks: [{ emit: [['update-available', { version: '2.0.7', releaseNotes: [{ note: 'x' }] }]], ret: 'none' }], steps: [['start'], ['check']] },
  { name: 'retryCancels', packaged: true, cancelThrows: true, checks: [{ emit: [['update-available', INFO]], ret: 'token' }, { emit: [['update-available', INFO]], ret: 'token' }], steps: [['start'], ['check'], ['check'], ['check']] },
  { name: 'checkThrows', packaged: true, checks: [E('net::ERR_INTERNET_DISCONNECTED'), { throwStr: 'plain string' }], steps: [['start'], ['check'], ['check'], ['advance', 200_000]] },
  { name: 'missingThrown', packaged: true, checks: [E(MISSING), E('whatever', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'), E('Cannot find latest.yml in the latest release artifacts')], steps: [['start'], ['check'], ['check'], ['check']] },
  { name: 'missingEvent', packaged: true, checks: [{ emit: [['checking-for-update'], ['error', E(MISSING)]], ret: 'null' }], steps: [['start'], ['check'], ['emit', 'error', E(MISSING)]] },
  { name: 'errorEvents', packaged: true, checks: [{ emit: [['update-available', INFO]], ret: 'token' }],
    steps: [['start'], ['check'], ['emit', 'error', E('dl broke')], ['emit', 'update-downloaded', INFO], ['emit', 'error', E('install broke')], ['emit', 'checking-for-update'], ['emit', 'error', { throwStr: 'raw' }]] },
  { name: 'stallCheck', packaged: true, launchDelayMs: 0, checks: [{ emit: [['checking-for-update']], ret: 'null' }], steps: [['start'], ['check'], ['advance', 89_999], ['advance', 1], ['advance', 90_000]] },
  { name: 'stallDownload', packaged: true, launchDelayMs: 0, stallMs: 1499, checks: [{ emit: [['update-available', INFO]], ret: 'token' }],
    steps: [['start'], ['check'], ['advance', 1000], ['emit', 'download-progress', { percent: 1, bytesPerSecond: 2, transferred: 3, total: 4 }], ['advance', 1000], ['advance', 499], ['get']] },
  { name: 'noStall', packaged: true, stallMs: 0, launchDelayMs: 0, intervalMs: 0, checks: [{ emit: [['checking-for-update']], ret: 'null' }], steps: [['start'], ['check'], ['advance', 30 * H]] },
  { name: 'download', packaged: true, downloads: ['ok', E('disk full')], steps: [['start'], ['download'], ['download'], ['install']] },
  { name: 'installThrows', packaged: true, installThrows: 'locked', checks: [{ emit: [['update-downloaded', INFO]], ret: 'none' }], steps: [['start'], ['check'], ['install']] },
  { name: 'autoCheckOff', packaged: true, steps: [['start'], ['setAutoCheck', { on: false }], ['file'], ['advance', 13 * H], ['setAutoCheck', { on: true }], ['file'], ['advance', 6 * H]] },
  { name: 'storedOff', packaged: true, file: '{"version":1,"autoCheck":false}', steps: [['get'], ['start'], ['advance', 7 * H]] },
  { name: 'storedOther', packaged: true, file: '{"autoCheck":0}', steps: [['get']] },
  { name: 'storedNull', packaged: true, file: 'null', steps: [['get']] },
  { name: 'storedBad', packaged: true, file: '{', steps: [['get']] },
  { name: 'noSettings', packaged: true, settingsFile: null, steps: [['setAutoCheck', { on: false }], ['file'], ['get']] },
  { name: 'persistFail', packaged: true, settingsFile: 'blocker/x/update-settings.json', steps: [['setAutoCheck', { on: true }]] },
  { name: 'badInput', packaged: true, steps: [['setAutoCheck', {}], ['setAutoCheck', { on: 'yes' }], ['setAutoCheck', null], ['setAutoCheck', { on: true, extra: 1 }]] },
  { name: 'stopRestart', packaged: true, steps: [['start'], ['stop'], ['advance', 20 * H], ['start'], ['advance', 15_000], ['ulog']] },
];

async function recordUpdates() {
  const { UpdateService } = await core('services/UpdateService.ts');
  const { shellProcedures } = await import(pathToFileURL(path.join(root, 'packages/contract/src/app/shell.ts')).href);
  const RT = globalThis.setTimeout;
  const saved = { st: globalThis.setTimeout, ct: globalThis.clearTimeout, si: globalThis.setInterval, ci: globalThis.clearInterval, now: Date.now };
  const out = [];
  for (const sc of UPD) {
    let now = NOW, seq = 0, timers = [];
    globalThis.setTimeout = (fn, ms) => { const t = { id: ++seq, at: now + ms, fn, unref() {} }; timers.push(t); return t; };
    globalThis.setInterval = (fn, ms) => { const t = { id: ++seq, at: now + ms, fn, every: ms, unref() {} }; timers.push(t); return t; };
    globalThis.clearTimeout = globalThis.clearInterval = (t) => { timers = timers.filter((x) => x !== t); };
    Date.now = () => now;
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    const ud = path.join(SB, 'upd', sc.name);
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'blocker'), 'x');
    const sf = sc.settingsFile === undefined ? path.join(ud, 'update-settings.json') : sc.settingsFile && path.join(ud, sc.settingsFile);
    if (sc.file !== undefined) fs.writeFileSync(path.join(ud, 'update-settings.json'), sc.file);
    let events = [], calls = [], logs = [];
    const listeners = {};
    const checks = [...(sc.checks || [])], downloads = [...(sc.downloads || [])];
    const mkErr = (b) => (b.throwStr !== undefined ? b.throwStr : Object.assign(new Error(b.throw), b.code ? { code: b.code } : {}));
    const fire = (ev, arg) => (listeners[ev] || []).forEach((l) => l(arg && (arg.throw !== undefined || arg.throwStr !== undefined) ? mkErr(arg) : arg));
    let tok = 0;
    const updater = {
      on: (ev, l) => { (listeners[ev] ||= []).push(l); },
      removeAllListeners: () => { calls.push(['removeAllListeners']); for (const k of Object.keys(listeners)) delete listeners[k]; },
      checkForUpdates: async () => {
        calls.push(['checkForUpdates']);
        const b = checks.shift() || { ret: 'null' };
        for (const [ev, a] of b.emit || []) fire(ev, a);
        if (b.throw !== undefined || b.throwStr !== undefined) throw mkErr(b);
        if (b.ret === 'null') return null;
        const id = ++tok;
        return b.ret === 'token'
          ? { updateInfo: INFO, cancellationToken: { cancel: () => { calls.push(['cancel', id]); if (sc.cancelThrows) throw new Error('done'); } } }
          : { updateInfo: INFO };
      },
      downloadUpdate: async () => { calls.push(['downloadUpdate']); const b = downloads.shift() || 'ok'; if (b !== 'ok') throw mkErr(b); },
      quitAndInstall: (a, b) => { calls.push(['quitAndInstall', a, b]); if (sc.installThrows) throw new Error(sc.installThrows); },
    };
    const lg = (level) => (msg, meta) => logs.push([level, msg, meta === undefined ? null : meta]);
    const logger = { info: lg('info'), warn: lg('warn'), error: lg('error'), debug: lg('debug') };
    const svc = new UpdateService(logger, {
      ports: { app: { version: () => '2.0.5', isPackaged: () => sc.packaged }, paths: { userData: () => ud } },
      events: { publish: (e, p) => events.push([e, p]) },
      updater, packaged: sc.packaged, settingsFile: sf,
      launchDelayMs: sc.launchDelayMs, intervalMs: sc.intervalMs, stallMs: sc.stallMs,
    });
    const handlers = {
      get: () => svc.getState(), check: () => svc.check(), download: () => svc.download(), install: () => svc.install(),
      setAutoCheck: async (input) => {
        const r = await shellProcedures['updates.setAutoCheck'].input.safeParseAsync(input);
        if (!r.success) throw Object.assign(new Error('Invalid input'), { code: 'BAD_INPUT' });
        svc.setAutoCheck(r.data.on);
        return svc.getState();
      },
    };
    const log = [];
    for (const [op, a, b] of sc.steps) {
      events = []; calls = []; logs = [];
      let r, err;
      try {
        if (op === 'start') svc.start();
        else if (op === 'stop') svc.stop();
        else if (op === 'emit') fire(a, b);
        else if (op === 'ulog') { updater.logger.info('i'); updater.logger.warn('w'); updater.logger.error('e'); updater.logger.debug('d'); r = [updater.autoDownload, updater.autoInstallOnAppQuit, updater.allowPrerelease]; }
        else if (op === 'file') {
          await new Promise((res) => RT(res, 50));
          const f = path.join(ud, 'update-settings.json');
          r = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
        } else if (op === 'advance') {
          const end = now + a;
          for (;;) {
            timers.sort((x, y) => x.at - y.at || x.id - y.id);
            const t = timers[0];
            if (!t || t.at > end) break;
            now = t.at;
            if (t.every) t.at += t.every; else timers.shift();
            t.fn();
            await flush();
          }
          now = end;
          r = timers.length;
        } else r = await handlers[op](a);
        await flush();
        if (op === 'setAutoCheck') await new Promise((res) => RT(res, 50));
      } catch (e) {
        err = { code: e.code, message: e.message };
      }
      log.push({ op, arg: a === undefined ? null : a, arg2: b === undefined ? null : b, ok: err ? null : norm(r), err: err || null, events: norm(events), calls, logs: norm(logs) });
    }
    calls = [];
    svc.stop();
    out.push({ ...sc, settingsFile: sc.settingsFile === undefined ? '' : sc.settingsFile, log });
  }
  Object.assign(globalThis, { setTimeout: saved.st, clearTimeout: saved.ct, setInterval: saved.si, clearInterval: saved.ci });
  Date.now = saved.now;
  return { now: NOW, scenarios: out };
}

const dir = process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/shellhandlers/testdata');
fs.mkdirSync(dir, { recursive: true });
const diag = await recordDiag();
fs.writeFileSync(path.join(dir, 'shell_diagnostics.json'), JSON.stringify(diag, null, 1) + '\n');
console.log(`record-shell: diagnostics ${diag.scenarios.length} scenarios, ${diag.scenarios.reduce((a, s) => a + s.log.length, 0)} steps`);
const icon = await recordIcon();
fs.writeFileSync(path.join(dir, 'shell_appicon.json'), JSON.stringify(icon, null, 1) + '\n');
console.log(`record-shell: appIcon ${icon.scenarios.length} scenarios`);
const upd = await recordUpdates();
fs.writeFileSync(path.join(dir, 'shell_updates.json'), JSON.stringify(upd, null, 1) + '\n');
console.log(`record-shell: updates ${upd.scenarios.length} scenarios, ${upd.scenarios.reduce((a, s) => a + s.log.length, 0)} steps`);
fs.rmSync(SB, { recursive: true, force: true });
