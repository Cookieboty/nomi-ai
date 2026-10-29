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
/** LoggerService：级别过滤 / 控制台行 / app.log JSON 行 / meta 脱敏 / 轮转 */
export const LOG = [
  {
    name: 'levels', packaged: false,
    ops: [
      ['error', 'e1'], ['warn', 'w1', { a: 1 }], ['info', 'i1', { apiKey: 'k', nested: { Token: 't', ok: [1, { password: 'p' }] } }], ['debug', 'd-hidden'],
      ['setLevel', 3], ['debug', 'd1', null], ['info', 'i2', 0], ['info', 'i3', ''], ['info', 'i4', 'str'], ['info', 'ctx', { x: true }, 'Win'],
      ['setLevel', 0], ['warn', 'w-hidden'], ['error', 'e2', [1, 'a', { secret: null, cookie: undefined }]], ['getLevel'],
      ['setLevel', 1], ['info', 'i-hidden'], ['warn', 'w2', { email: 'a@b', deep: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } } }],
    ],
  },
  { name: 'packagedQuiet', packaged: true, ops: [['setLevel', 3], ['error', 'e'], ['warn', 'w'], ['info', 'i'], ['debug', 'd']] },
  { name: 'packagedDebugEnv', packaged: true, env: { NOMI_DEBUG: '1' }, ops: [['setLevel', 3], ['info', 'i'], ['debug', 'd']] },
  {
    name: 'rotate', packaged: false,
    files: [['app.log', 10 * 1024 * 1024 + 1], ['app.1.log', 5], ['app.3.log', 7], ['app.4.log', 9]],
    ops: [['info', 'after rotate']],
  },
  { name: 'noRotateAtLimit', packaged: false, files: [['app.log', 10 * 1024 * 1024]], ops: [['info', 'x']] },
];

async function recordLogger() {
  const { LoggerService } = await core('services/LoggerService.ts');
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const saved = { error: console.error, warn: console.warn, info: console.info, debug: console.debug, env: process.env.NOMI_DEBUG };
  const out = [];
  for (const sc of LOG) {
    const dir = path.join(SB, 'log', sc.name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, size] of sc.files || []) { const fd = fs.openSync(path.join(dir, n), 'w'); fs.ftruncateSync(fd, size); fs.closeSync(fd); }
    if (sc.env?.NOMI_DEBUG) process.env.NOMI_DEBUG = sc.env.NOMI_DEBUG; else delete process.env.NOMI_DEBUG;
    const consoleLines = [];
    for (const k of ['error', 'warn', 'info', 'debug']) console[k] = (m) => consoleLines.push([k, m]);
    globalThis.Date = FixedDate;
    const l = new LoggerService({ ports: { paths: { logs: () => dir }, app: { isPackaged: () => sc.packaged } } });
    const results = [];
    for (const op of sc.ops) {
      if (op[0] === 'setLevel') l.setLevel(op[1]);
      else if (op[0] === 'getLevel') results.push(l.getLevel());
      else if (op.length === 2) l[op[0]](op[1]);
      else l[op[0]](op[1], op[2], op[3]);
    }
    l.flushSync();
    globalThis.Date = RealDate;
    Object.assign(console, { error: saved.error, warn: saved.warn, info: saved.info, debug: saved.debug });
    const files = {};
    for (const n of fs.readdirSync(dir).sort()) {
      const st = fs.statSync(path.join(dir, n));
      files[n] = st.size > 1024 * 1024 ? { size: st.size } : { text: fs.readFileSync(path.join(dir, n), 'utf8') };
    }
    // undefined meta 用 {"$undef":1} 标记（JSON 写不出 undefined）
    const ops = sc.ops.map((o) => (o.length >= 3 && o[2] === undefined ? [o[0], o[1], { $undef: 1 }] : o));
    out.push({ name: sc.name, packaged: sc.packaged, env: sc.env || {}, files: sc.files || [], ops, console: consoleLines, results, after: files });
  }
  if (saved.env === undefined) delete process.env.NOMI_DEBUG; else process.env.NOMI_DEBUG = saved.env;
  return out;
}

/** CliTrace：tap 子进程收发 → logs/cli-YYYY-MM-DD.jsonl（脱敏、截断、日上限、开关） */
export const TRACE = [
  {
    name: 'basic', ops: [
      ['spawn', '/usr/bin/claude', ['-p', '--api-key', 'sk-abcdefghijklmnopqrstuvwx'], 'tab-1', 4242],
      ['in', '{"type":"user","text":"hi Bearer abcdefghijklmnopqrstu"}\n'], ['out', 'hello\n'], ['err', 'warn: nomi-gw-abcdefghij\n'],
      ['close', 0, null],
    ],
  },
  { name: 'noTabNoPid', ops: [['spawn', 'C:\\tools\\codex.exe', [], '', 0], ['out', 'x'], ['close', null, 'SIGTERM']] },
  { name: 'truncate', ops: [['spawn', 'grok', [], 't', 7], ['out', 'a'.repeat(64 * 1024 + 5)], ['out', '😀'.repeat(32 * 1024 + 1)]] },
  { name: 'disabled', enabled: false, ops: [['spawn', 'claude', ['x'], 't', 1], ['out', 'nope']] },
  { name: 'toggleOff', ops: [['spawn', 'claude', [], 't', 2], ['out', 'one'], ['enable', false], ['out', 'two'], ['enable', true], ['out', 'three']] },
  { name: 'dayCap', preSize: 200 * 1024 * 1024 - 150, ops: [['spawn', 'claude', [], 't', 3], ['out', 'fits'], ['out', 'x'.repeat(200)], ['out', 'after cap']] },
];


/** 终端命令（TerminalCommands）：平台 × shell × 来源 × set/refresh 步骤；落盘文件树全量比对 */
const TSRC = {
  url: 'http://127.0.0.1:17890',
  clients: {
    claude: { token: 'tok-claude', models: { main: 'p1/claude-x', fast: 'p1/haiku' } },
    codex: { token: 'tok-codex', models: { main: 'p1/gpt-x' } },
    gemini: { token: null, models: {} },
    grok: { token: 'tok-grok', models: { main: 'p1/grok-x' } },
    dsh: { token: 'tok-dsh', models: { main: 'p1/ds-x' } },
  },
  metas: {
    'p1/claude-x': { label: 'Claude X', provider: 'P1', ctx: 200000, maxOutput: 8192, reasoning: true },
    'p1/gpt-x': { label: 'GPT X', ctx: 128000, vision: true },
    'p1/ds-x': { provider: 'P1', ctx: 64000, maxOutput: 4096 },
  },
  catalog: ['p1/claude-x', 'p1/gpt-x', 'p1/grok-x', 'p1/ds-x'],
};
export const TERM = [
  { name: 'linuxBash', platform: 'linux', shell: '/bin/bash', rc: ['.bashrc'], steps: [['state'], ['set', true], ['set', true, true], ['state'], ['refresh'], ['set', true, false], ['set', false]] },
  { name: 'darwinZsh', platform: 'darwin', shell: '/bin/zsh', rc: ['.zshrc', '.bash_profile'], steps: [['set', true, true], ['state'], ['set', false]] },
  { name: 'fish', platform: 'linux', shell: '/usr/bin/fish', mkdir: ['.config/fish'], steps: [['set', true, true], ['set', false]] },
  { name: 'noSource', platform: 'linux', shell: '/bin/bash', noSource: true, steps: [['set', true], ['state']] },
  { name: 'win', platform: 'win32', shell: '', steps: [['set', true], ['set', true, true], ['state'], ['set', false]] },
  { name: 'winPathFail', platform: 'win32', shell: '', winPath: false, steps: [['set', true, true], ['state']] },
  { name: 'persisted', platform: 'linux', shell: '/bin/bash', file: '{"enabled":true,"pathAdded":"yes","rcFiles":["x"]}', steps: [['state'], ['refresh']] },
  { name: 'persistedBad', platform: 'linux', shell: '/bin/bash', file: '{', steps: [['state']] },
];
let RUNNER_SELF = null; // 本进程（tsx）下 buildWindowsRunner() 的原文：落盘的 nomi-runner.cjs 等于它 → '<RUNNER>'（Go 端等于内嵌副本 → '<RUNNER>'）
function tree(dir) {
  const out = {};
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(d, e.name);
      const rel = path.relative(dir, f).split(path.sep).join('/');
      if (e.isDirectory()) { out[rel + '/'] = null; walk(f); }
      else if (e.isSymbolicLink()) out[rel] = { link: fs.readlinkSync(f) };
      else out[rel] = { text: ((t) => (t === RUNNER_SELF ? '<RUNNER>' : t))(fs.readFileSync(f, 'utf8')), mode: process.platform === 'win32' ? null : fs.statSync(f).mode & 0o777 };
    }
  };
  walk(dir);
  return out;
}
async function recordTerminal() {
  const T = await core('gateway/TerminalCommands.ts');
  RUNNER_SELF = (await core('gateway/windowsTerminal.ts')).buildWindowsRunner();
  const scenarios = [];
  for (const sc of TERM) {
    const base = path.join(SB, 'term', sc.name);
    const home = path.join(base, 'home');
    const root = path.join(base, 'root');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    for (const r of sc.rc || []) fs.writeFileSync(path.join(home, r), '# existing\n');
    for (const m of sc.mkdir || []) fs.mkdirSync(path.join(home, m), { recursive: true });
    if (sc.file) fs.writeFileSync(path.join(root, 'terminal.json'), sc.file);
    const winCalls = [];
    const warns = [];
    let enabledCalls = 0;
    const src = sc.noSource ? null : { url: TSRC.url, clients: TSRC.clients, metaOf: (r) => TSRC.metas[r], catalog: TSRC.catalog };
    const t = new T.TerminalCommands({
      root, home, platform: sc.platform, shell: sc.shell, source: () => src,
      logger: { warn: (m, e) => warns.push([m, String(e?.message ?? e)]) },
      windowsPath: (dir, add) => { winCalls.push([dir, add]); return sc.winPath !== false; },
      onEnabled: () => { enabledCalls++; },
    });
    const log = [];
    for (const st of sc.steps) {
      let r;
      if (st[0] === 'state') r = t.state();
      else if (st[0] === 'refresh') { t.refresh(); r = null; }
      else r = t.set(st.length > 2 ? { enabled: st[1], addToPath: st[2] } : { enabled: st[1] });
      log.push({ step: st, out: norm(r), home: norm(tree(home)), root: norm(tree(root)) });
    }
    scenarios.push({ ...sc, log, winCalls: norm(winCalls), warns: norm(warns), enabledCalls });
  }
  const scripts = [];
  for (const platform of ['linux', 'darwin', 'win32'])
    for (const kind of T.TERMINAL_KINDS)
      for (const model of [null, 'p1/m'])
        scripts.push({ kind, platform, model, name: T.commandName(kind, platform),
          out: T.buildScript({ kind, platform, url: TSRC.url, tokenFile: '/t/' + kind, model,
            ...(model ? { launch: { env: { A: '1', B: "it's" }, args: ['--x', 'y z'], strip: ['S1'] } } : {}),
            ...(model && kind === 'dsh' ? { template: '/tpl/patch.yml' } : {}) }) });
  const rc = [];
  for (const c of ['', '# a\n', 'x', `pre\n${T.RC_BEGIN}\nold\n${T.RC_END}\npost\n`, `${T.RC_BEGIN}\nonly\n${T.RC_END}`, `a\n\n${T.RC_BEGIN}\n${T.RC_END}\n\nb`])
    for (const shell of ['posix', 'fish']) rc.push({ in: c, shell, add: T.addRcBlock(c, shell), remove: T.removeRcBlock(c) });
  // run.toString() 取决于打包器：tsx 会注入 __name；这里用 esbuild（与 Go 内嵌 nomi-runner.cjs 的生成方式一致）转译后取值，
  // 用来发现 windowsTerminal.ts 改了而 Go 内嵌副本没重新生成
  const esbuild = createRequire(import.meta.url)('esbuild');
  const ts = fs.readFileSync(path.join(root, 'packages/core/src/gateway/windowsTerminal.ts'), 'utf8');
  const js = esbuild.transformSync(ts, { loader: 'ts', format: 'cjs', target: 'node18' }).code;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', js)(m, m.exports, createRequire(import.meta.url));
  return { home: '<SB>', scenarios, scripts, rc, runner: m.exports.buildWindowsRunner() };
}

/** 供应商探测（probe/detect.ts）：假 fetch 规则表 × 地址 / Key；请求按序记录（并发下排序比较） */
const OAI = 'https://api.example.test/v1';
const R = (m, u, status, body, auth, key) => ({ m, u, status, body: typeof body === 'string' ? body : JSON.stringify(body), ...(auth ? { auth } : {}), ...(key ? { key } : {}) });
const MODELS = { data: [{ id: 'gpt-x', context_length: 128000, max_output_tokens: 16000 }, { id: 'text-embed-3' }, { id: 'claude-y', max_context_length: 200000 }] };
export const DETECT = [
  { name: 'openaiOk', url: OAI, keys: ['k1'], rules: [R('GET', '/v1/models', 200, MODELS, 'bearer'), R('POST', '/chat/completions', 200, '{}'), R('POST', '/responses', 200, '{}')] },
  { name: 'altAuth', url: OAI, keys: ['k1'], rules: [R('GET', '/v1/models', 200, MODELS, 'x-api-key'), R('POST', '/messages', 200, '{}', 'bearer'), R('POST', '/messages', 401, 'no'), R('POST', '/chat/completions', 403, 'no', 'bearer'), R('POST', '/chat/completions', 200, '{}', 'x-api-key')] },
  { name: 'paramErr', url: OAI, keys: ['k1'], rules: [R('GET', '/v1/models', 200, MODELS), R('POST', '/chat/completions', 400, { error: { message: 'Unsupported parameter: max_tokens' } }), R('POST', '/responses', 400, { error: { message: 'model not found' } })] },
  { name: 'fallback', url: OAI, keys: ['k1'], fallbackModel: 'fb-1', rules: [R('GET', '/v1/models', 500, 'x'), R('POST', '', 200, '{}')] },
  { name: 'noModel', url: OAI, keys: ['k1'], rules: [R('GET', '/v1/models', 200, { data: [] })] },
  { name: 'twoKeys', url: OAI, keys: ['bad', 'good'], rules: [R('GET', '/v1/models', 200, MODELS, null, 'good'), R('POST', '', 200, '{}', null, 'good'), R('GET', '', 401, 'no'), R('POST', '', 401, 'no')] },
  { name: 'private', url: 'http://10.0.0.5:8080/v1', keys: ['k1'], fallbackModel: 'm', rules: [R('POST', '', 200, '{}')] },
  { name: 'privateAllowed', url: 'http://10.0.0.5:8080/v1', allowed: ['10.0.0.5:8080'], keys: ['k1'], fallbackModel: 'm', rules: [R('GET', '/models', 200, MODELS), R('POST', '', 200, '{}')] },
  { name: 'connErr', url: OAI, keys: ['k1'], fallbackModel: 'm', throw: 'ECONNREFUSED', rules: [] },
  { name: 'gemini', url: 'https://gen.example.test/v1beta', keys: ['g1'], rules: [R('GET', '/models', 200, { models: [{ name: 'models/gemini-x', inputTokenLimit: 1000000, outputTokenLimit: 65536 }] }), R('POST', ':generateContent', 200, '{}', 'x-goog-api-key'), R('POST', '', 404, 'nf')] },
  { name: 'altAuth400', url: OAI, keys: ['k1'], rules: [R('GET', '/v1/models', 200, MODELS), R('POST', '/chat/completions', 401, 'no', 'bearer'), R('POST', '/chat/completions', 400, { error: { message: 'bad request' } }, 'x-api-key'), R('POST', '/messages', 401, 'no', 'x-api-key'), R('POST', '/messages', 400, 'bad', 'bearer'), R('POST', '/responses', 404, '')] },
  { name: 'anthropicBase', url: 'https://api.anthropic-like.test', keys: ['a1'], rules: [R('GET', '/models', 200, { data: [{ id: 'claude-z', type: 'model' }] }, 'x-api-key'), R('POST', '/v1/messages', 200, '{}', 'x-api-key'), R('POST', '', 404, '')] },
];
function authOf(h) {
  const g = (k) => h[k] ?? h[k.toLowerCase()];
  const a = g('authorization');
  if (a) return ['bearer', a.replace(/^Bearer /, '')];
  if (g('x-api-key')) return ['x-api-key', g('x-api-key')];
  if (g('x-goog-api-key')) return ['x-goog-api-key', g('x-goog-api-key')];
  return ['none', ''];
}
async function recordDetect() {
  const { detect, normalizeBases } = await import(pathToFileURL(path.join(root, 'packages/gateway/src/probe/detect.ts')).href);
  const RealNow = Date.now;
  const scenarios = [];
  for (const sc of DETECT) {
    const reqs = [];
    const fetchImpl = async (url, init = {}) => {
      const h = Object.fromEntries(new Headers(init.headers || {}).entries());
      const [auth, key] = authOf(h);
      const method = init.method || 'GET';
      reqs.push([method, String(url), auth, key, init.body ?? null]);
      if (sc.throw) throw new Error(sc.throw);
      const r = sc.rules.find((x) => x.m === method && String(url).includes(x.u) && (!x.auth || x.auth === auth) && (!x.key || x.key === key));
      return new Response(r ? r.body : '', { status: r ? r.status : 404 });
    };
    Date.now = () => NOW;
    const out = await detect({
      bases: normalizeBases(sc.url), keys: sc.keys.map((v, i) => ({ id: 'key' + i, value: v })),
      ...(sc.fallbackModel ? { fallbackModel: sc.fallbackModel } : {}),
      ...(sc.allowed ? { allowedPrivateHosts: sc.allowed } : {}),
      fetchImpl, lookupAll: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    Date.now = RealNow;
    reqs.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    scenarios.push({ ...sc, bases: normalizeBases(sc.url), out, reqs });
  }
  return { scenarios };
}

async function recordTrace() {
  const { CliTrace } = await core('diagnostics/cliTrace.ts');
  const { EventEmitter } = await import('node:events');
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }
  const day = new RealDate(NOW).toISOString().slice(0, 10);
  const out = [];
  for (const sc of TRACE) {
    const dir = path.join(SB, 'trace', sc.name, 'logs');
    let on = sc.enabled !== false;
    if (sc.preSize) { fs.mkdirSync(dir, { recursive: true }); const fd = fs.openSync(path.join(dir, `cli-${day}.jsonl`), 'w'); fs.ftruncateSync(fd, sc.preSize); fs.closeSync(fd); }
    globalThis.Date = FixedDate;
    const t = new CliTrace({ dir, enabled: () => on });
    let child;
    for (const op of sc.ops) {
      if (op[0] === 'spawn') {
        child = new EventEmitter();
        child.pid = op[4] || undefined;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { write: () => true };
        t.tap(child, op[1], op[2], op[3] ? { tabId: op[3] } : {});
      } else if (op[0] === 'in') child.stdin.write(op[1]);
      else if (op[0] === 'out') child.stdout.emit('data', Buffer.from(op[1]));
      else if (op[0] === 'err') child.stderr.emit('data', Buffer.from(op[1]));
      else if (op[0] === 'close') child.emit('close', op[1], op[2]);
      else if (op[0] === 'enable') on = op[1];
    }
    await t.flush();
    t.dispose();
    globalThis.Date = RealDate;
    const f = path.join(dir, `cli-${day}.jsonl`);
    let text = null, mode = null;
    if (fs.existsSync(f)) {
      const buf = fs.readFileSync(f);
      text = buf.subarray(sc.preSize || 0).toString('utf8');
      mode = process.platform === 'win32' ? null : fs.statSync(f).mode & 0o777;
    }
    out.push({ name: sc.name, enabled: sc.enabled !== false, preSize: sc.preSize || 0, ops: sc.ops, day, text, mode });
  }
  return out;
}

const diag = await recordDiag();
fs.writeFileSync(path.join(dir, 'shell_diagnostics.json'), JSON.stringify(diag, null, 1) + '\n');
console.log(`record-shell: diagnostics ${diag.scenarios.length} scenarios, ${diag.scenarios.reduce((a, s) => a + s.log.length, 0)} steps`);
const icon = await recordIcon();
fs.writeFileSync(path.join(dir, 'shell_appicon.json'), JSON.stringify(icon, null, 1) + '\n');
console.log(`record-shell: appIcon ${icon.scenarios.length} scenarios`);
const upd = await recordUpdates();
fs.writeFileSync(path.join(dir, 'shell_updates.json'), JSON.stringify(upd, null, 1) + '\n');
console.log(`record-shell: updates ${upd.scenarios.length} scenarios, ${upd.scenarios.reduce((a, s) => a + s.log.length, 0)} steps`);
const term = await recordTerminal();
fs.writeFileSync(path.join(dir, 'shell_terminal.json'), JSON.stringify(term, null, 1) + '\n');
console.log(`record-shell: terminal ${term.scenarios.length} scenarios, ${term.scripts.length} scripts, ${term.rc.length} rc`);
const det = await recordDetect();
fs.writeFileSync(path.join(dir, 'shell_detect.json'), JSON.stringify(det, null, 1) + '\n');
console.log(`record-shell: detect ${det.scenarios.length} scenarios`);
fs.rmSync(SB, { recursive: true, force: true });
const logs = await recordLogger();
fs.writeFileSync(path.join(dir, 'shell_logger.json'), JSON.stringify(logs, null, 1) + '\n');
const traces = await recordTrace();
fs.writeFileSync(path.join(dir, 'shell_clitrace.json'), JSON.stringify(traces, null, 1) + '\n');
