#!/usr/bin/env node
/**
 * 批次 7s2：contract/coding.ts 的 cli.registry/plugin*、cliUpdate.*、delegate.*、history.* 处理函数。
 * 用记录调用的假服务（返回 {m, a} 回显）跑每个过程 × 多种入参，外加缺服务与服务抛错。
 * 结果按线上帧记录：{ok} | {err:{code,message}}（普通错误 = INTERNAL）。
 * Go 侧 internal/core/codinghandlers/coding_parity_test.go 用同样的假服务比对。
 * 输出：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/codinghandlers/testdata。
 * Usage: node --import tsx scripts/parity/record-b7s2-coding.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { C } = await importSources(root, {
  C: path.join(root, 'apps/desktop-electron/internal/core/src/contract/coding.ts'),
});

// 假服务：fail = 该次调用抛错（同步方法 throw，异步方法 reject）
let fail = false;
const echo = (m, ...a) => {
  if (fail) throw new Error(`boom ${m}`);
  return { m, a };
};
const aecho = async (m, ...a) => echo(m, ...a);
const opts = (o) => ({ offset: o.offset ?? null, limit: o.limit ?? null, force: Boolean(o.force) });
const services = {
  cliPlugins: {
    snapshot: () => echo('snapshot'),
    addExternal: (spec) => echo('addExternal', spec ?? null),
    removeExternal: (id) => (echo('removeExternal', id), id === 'yes'),
    testExternalInTemp: (spec) => aecho('testExternalInTemp', spec ?? null),
  },
  cliUpdate: {
    inspect: async (refresh) => [echo('inspect', refresh)],
    previewUpdate: (k, s) => aecho('previewUpdate', k, s),
    run: (k, s) => aecho('run', k, s),
    job: (k) => (k === 'codex' ? null : echo('job', k)),
    busyKinds: () => (echo('busyKinds'), ['claude', 'grok']),
    dismissJob: (k) => (echo('dismissJob', k), k === 'claude'),
    environment: () => aecho('environment'),
  },
  delegate: {
    settings: () => echo('settings'),
    setSettings: (s) => aecho('setSettings', s ?? null),
    pin: (c, t) => (
      echo('pin', c ?? null, t ?? null),
      typeof c === 'string' && c !== 'none' ? c : null
    ),
    clearPin: (t) => void echo('clearPin', t ?? null),
    statusOf: (id) => (id === 'missing' ? null : echo('statusOf', id)),
  },
  history: {
    list: (b, o) => aecho('list', b, opts(o)),
    index: (b, o) => aecho('index', b, opts(o)),
    open: (b, id) => aecho('open', b, id),
    remove: (b, id) => aecho('remove', b, id),
  },
};

const S = (o) => o;
const inputs = {
  'cli.registry': [{}],
  'cli.pluginAdd': [{ spec: { id: 'x', command: 'x' } }, { spec: 'raw' }, {}],
  'cli.pluginRemove': [{ id: 'yes' }, { id: 'no' }],
  'cli.pluginTest': [{ spec: { id: 't', args: [1, 2] } }],
  'cliUpdate.inspect': [
    {},
    { refresh: true },
    { refresh: false },
    { refresh: 'true' },
    { refresh: 1 },
  ],
  'cliUpdate.preview': [
    { kind: 'codex', scope: 'user' },
    { kind: 'bogus', scope: 'global' },
    {},
    { kind: 'gemini', scope: 'x' },
    { kind: 'claude' },
  ],
  'cliUpdate.run': [{ kind: 'dsh', scope: 'user' }, { kind: 'grok' }, { kind: 5, scope: 'user' }],
  'cliUpdate.job': [{ kind: 'codex' }, { kind: 'dsh' }, {}],
  'cliUpdate.busy': [{}],
  'cliUpdate.environment': [{}],
  'cliUpdate.dismiss': [{ kind: 'gemini' }, { kind: 'nope' }],
  'delegate.settings': [{}],
  'delegate.setSettings': [{ settings: { enabled: true, clis: ['codex'] } }, {}],
  'delegate.pin': [
    { cli: 'codex', turnId: 't1' },
    { cli: 'none', turnId: 't2' },
    { cli: 3, turnId: 't3' },
    {},
  ],
  'delegate.clearPin': [{ turnId: 't1' }, {}],
  'delegate.status': [{ taskId: 'k1' }, { taskId: 'missing' }],
  'history.list': [
    { backend: 'claude' },
    { backend: 'codex', options: { offset: 20, limit: 10 } },
    { backend: 'grok', options: { force: true } },
    { backend: 'dsh', options: { force: 1, limit: 2.6 } },
    { backend: 'gemini', options: null },
    { backend: 'claude', options: { force: '' } },
  ],
  'history.index': [{ backend: 'codex', options: { offset: 0, force: false } }, { backend: 'dsh' }],
  'history.open': [{ backend: 'claude', sessionId: 's1' }],
  'history.delete': [{ backend: 'codex', sessionId: 's2' }],
};
void S;

async function run(svcs, name, input) {
  const h = C.createCodingHandlers({ services: svcs, events: { publish() {} } });
  try {
    const v = await h[name](input, { fail: () => {} });
    return { ok: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
  } catch (e) {
    return { err: { code: e.code ?? 'INTERNAL', message: e.message } };
  }
}

const cases = [];
for (const [name, list] of Object.entries(inputs)) {
  for (const input of list) {
    fail = false;
    cases.push({ name, input, mode: 'ok', out: await run(services, name, input) });
    fail = true;
    cases.push({ name, input, mode: 'fail', out: await run(services, name, input) });
  }
  fail = false;
  cases.push({ name, input: list[0], mode: 'missing', out: await run({}, name, list[0]) });
}
const dir =
  process.env.NOMI_GOLDEN_DIR ||
  path.join(root, 'apps/desktop-go/internal/core/codinghandlers/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'b7s2-coding.json'), JSON.stringify(cases, null, 1) + '\n');
console.log(`b7s2-coding: ${cases.length} cases`);
