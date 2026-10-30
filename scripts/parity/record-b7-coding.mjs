#!/usr/bin/env node
/**
 * 批次 7（b7c）：contract/coding.ts 的 harness.* 处理函数（createCodingHandlers）。
 * 场景表 b7-coding-scenarios.json：每个场景按序调用过程（"$N" = 第 N 个 tabCreate 返回的 id，
 * "$W" = 工作目录，"$T" = 临时根），记录线上值（JSON 往返）或错误 {code, message}。
 * Go 侧 internal/core/codinghandlers/harness_parity_test.go 经 Router 会话回放比对。
 * 输出目录：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/codinghandlers/testdata。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
process.env.NOMI_USE_MOCK_CLI = '1';
process.env.NOMI_LOCALE = process.env.NOMI_LOCALE || 'en';
const scen = JSON.parse(fs.readFileSync(path.join(here, 'b7-coding-scenarios.json'), 'utf8'));
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { HarnessOrchestrator } = await imp(
  'apps/desktop-electron/internal/core/src/cli/harness/Orchestrator.ts',
);
const { createCodingHandlers } = await imp(
  'apps/desktop-electron/internal/core/src/contract/coding.ts',
);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMEKEYS = new Set([
  'ts',
  'at',
  'expiresAt',
  'startedAt',
  'durationMs',
  'updatedAt',
  'createdAt',
  'timestamp',
  'lastActiveAt',
]);
function norm(v, tmp) {
  if (typeof v === 'string')
    return v.split(tmp).join('<T>').split(root).join('<R>').replace(UUID, '<U>');
  if (Array.isArray(v)) return v.map((x) => norm(x, tmp));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'bins') continue;
      o[k] = TIMEKEYS.has(k) && typeof x === 'number' ? '<N>' : norm(x, tmp);
    }
    return o;
  }
  return v;
}
// 线上值 = JSON 往返（undefined → 缺省 / null）
const wire = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const out = [];
for (const c of scen.cases) {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7c-')));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'docs', 'nomi'), { recursive: true });
  const ids = [];
  const sub = (v) => {
    if (typeof v === 'string') {
      if (/^\$\d+$/.test(v)) return ids[Number(v.slice(1))] ?? v;
      return v.split('$W').join(work).split('$T').join(tmp);
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  const harness = c.noHarness
    ? null
    : new HarnessOrchestrator({
        root: path.join(tmp, 'harness'),
        home: tmp,
        defaultCwd: path.join(tmp, 'docs', 'nomi'),
        legacyDefaultCwd: path.join(tmp, 'docs'),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        ports: {
          dialogs: { pickDirectory: async () => null },
          windows: { anyFocused: () => false },
        },
        idleReclaimMs: 0,
      });
  const events = { publish() {} };
  const handlers = createCodingHandlers({ services: { harness }, events });
  const steps = [];
  for (const [name, input] of c.calls) {
    let r;
    try {
      const v = wire(await handlers[name](sub(input), { fail: () => {} }));
      if (name === 'harness.tabCreate' && v) ids.push(v.id);
      r = { ok: v };
    } catch (e) {
      r = { err: { code: e?.code ?? 'INTERNAL', message: String(e?.message ?? e) } };
    }
    steps.push([name, r]);
  }
  harness?.flushPersist();
  harness?.dispose();
  out.push(norm({ name: c.name, steps }, tmp));
  await new Promise((r) => setTimeout(r, 20));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}

const dir =
  process.env.NOMI_GOLDEN_DIR ??
  path.join(root, 'apps/desktop-go/internal/core/codinghandlers/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'b7_coding_harness.json'),
  JSON.stringify({ cases: out }, null, 2) + '\n',
);
console.log(`b7 coding harness: ${out.length} cases -> ${dir}`);
process.exit(0);
