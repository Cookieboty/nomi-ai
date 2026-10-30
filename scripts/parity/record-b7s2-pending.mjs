#!/usr/bin/env node
/**
 * 批次 7s2：core/pendingEvents.ts + contract/eventBus.ts 的 pending.offer + contract/media.ts 的 nav.takePending。
 * 每个场景一串操作（sub/unsub/pub/tick/take/nav），记录 take / nav 的结果（JSON 字符串）。
 * Go 侧 internal/core/pendingevents/pending_parity_test.go 经 contract.Router（Pending 钩子 + 会话订阅）回放比对。
 * 输出：NOMI_GOLDEN_DIR，缺省 apps/desktop-go/internal/core/pendingevents/testdata。
 * Usage: node --import tsx scripts/parity/record-b7s2-pending.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const src = (p) => path.join(root, 'apps/desktop-electron/internal/core/src', p);
const { P, B, M } = await importSources(root, {
  P: src('core/pendingEvents.ts'),
  B: src('contract/eventBus.ts'),
  M: src('contract/media.ts'),
});

const NAV = [
  'providers.openPanel',
  'nav.desktopPanelRequested',
  'nav.scheduleRequested',
  'nav.voiceSettingsRequested',
];
const OTHER = ['desktop.summary', 'theme.changed', 'harness.changed'];
const ALL = [...NAV, ...OTHER];
const GROUPSETS = {
  core: null,
  mixed: {
    nav: ['providers.openPanel', 'theme.changed'],
    x: ['nav.scheduleRequested', 'desktop.summary'],
  },
  empty: {},
};
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const payloads = [{}, { a: 1 }, null, 'x', [1, 'b'], { nested: { k: [true, null] } }, 0];

const scen = [
  {
    name: 'basic',
    groups: 'core',
    ops: [['pub', 'providers.openPanel', { a: 1 }], ['nav'], ['nav']],
  },
  {
    name: 'delivered-clears',
    groups: 'core',
    ops: [
      ['pub', 'nav.scheduleRequested', {}],
      ['sub', 'nav.scheduleRequested'],
      ['pub', 'nav.scheduleRequested', {}],
      ['nav'],
    ],
  },
  {
    name: 'latest-wins',
    groups: 'core',
    ops: [
      ['pub', 'nav.scheduleRequested', 1],
      ['pub', 'nav.desktopPanelRequested', 2],
      ['take', 'nav'],
      ['take', 'nav'],
    ],
  },
  {
    name: 'ttl-edge',
    groups: 'core',
    ops: [
      ['pub', 'providers.openPanel', {}],
      ['tick', 60000],
      ['nav'],
      ['pub', 'providers.openPanel', {}],
      ['tick', 60001],
      ['nav'],
    ],
  },
  {
    name: 'custom-ttl',
    groups: 'core',
    ttlMs: 5,
    ops: [
      ['pub', 'desktop.summary', 's'],
      ['tick', 5],
      ['take', 'summary'],
      ['pub', 'desktop.summary', 's'],
      ['tick', 6],
      ['take', 'summary'],
    ],
  },
  {
    name: 'zero-ttl',
    groups: 'core',
    ttlMs: 0,
    ops: [
      ['pub', 'nav.voiceSettingsRequested', {}],
      ['nav'],
      ['pub', 'nav.voiceSettingsRequested', {}],
      ['tick', 1],
      ['nav'],
    ],
  },
  {
    name: 'mixed-nonnav',
    groups: 'mixed',
    ops: [
      ['pub', 'theme.changed', { t: 1 }],
      ['nav'],
      ['pub', 'providers.openPanel', {}],
      ['nav'],
      ['pub', 'desktop.summary', 3],
      ['take', 'x'],
      ['take', 'nope'],
    ],
  },
  {
    name: 'unknown-event',
    groups: 'core',
    ops: [
      ['pub', 'theme.changed', {}],
      ['take', 'nav'],
      ['take', 'summary'],
      ['take', ''],
    ],
  },
  { name: 'empty-groups', groups: 'empty', ops: [['pub', 'providers.openPanel', {}], ['nav']] },
  {
    name: 'unsub',
    groups: 'core',
    ops: [
      ['sub', 'providers.openPanel'],
      ['pub', 'providers.openPanel', {}],
      ['unsub', 'providers.openPanel'],
      ['pub', 'providers.openPanel', 9],
      ['nav'],
    ],
  },
  {
    name: 'sub-other-event',
    groups: 'core',
    ops: [
      ['pub', 'providers.openPanel', 1],
      ['sub', 'nav.scheduleRequested'],
      ['pub', 'nav.scheduleRequested', 2],
      ['nav'],
    ],
  },
];
for (let i = 0; i < 40; i++) {
  const ops = [];
  for (let j = 0, n = 5 + Math.floor(rnd() * 25); j < n; j++) {
    const r = rnd();
    if (r < 0.35) ops.push(['pub', pick(ALL), pick(payloads)]);
    else if (r < 0.45) ops.push(['sub', pick(ALL)]);
    else if (r < 0.55) ops.push(['unsub', pick(ALL)]);
    else if (r < 0.7) ops.push(['tick', pick([0, 1, 1000, 30000, 59999, 60000, 60001])]);
    else if (r < 0.85) ops.push(['take', pick(['nav', 'summary', 'x', 'nope'])]);
    else ops.push(['nav']);
  }
  scen.push({
    name: `rand-${i}`,
    groups: pick(['core', 'core', 'mixed', 'empty']),
    ttlMs: pick([undefined, undefined, 0, 1000]),
    ops,
  });
}

const cases = [];
for (const c of scen) {
  let t = 1_700_000_000_000;
  const subs = new Set();
  const pending = P.createPendingEvents({
    groups: GROUPSETS[c.groups] ?? P.CORE_PENDING_GROUPS,
    ttlMs: c.ttlMs,
    now: () => t,
  });
  const bus = B.createContractEventBus(null, undefined, pending);
  bus.attach({ publish() {}, subscribers: (e) => (subs.has(e) ? 1 : 0) });
  const h = M.createMediaHandlers({ services: { pendingEvents: pending } });
  const out = [];
  for (const op of c.ops) {
    switch (op[0]) {
      case 'sub':
        subs.add(op[1]);
        break;
      case 'unsub':
        subs.delete(op[1]);
        break;
      case 'pub':
        bus.publish(op[1], op[2]);
        break;
      case 'tick':
        t += op[1];
        break;
      case 'take':
        out.push(JSON.stringify(pending.take(op[1])));
        break;
      case 'nav':
        out.push(JSON.stringify(h['nav.takePending']()));
        break;
    }
  }
  cases.push({
    ...c,
    groupsDef: GROUPSETS[c.groups] ?? P.CORE_PENDING_GROUPS,
    ttlMs: c.ttlMs ?? null,
    out,
  });
}
const dir =
  process.env.NOMI_GOLDEN_DIR ||
  path.join(root, 'apps/desktop-go/internal/core/pendingevents/testdata');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, 'b7s2-pending.json'),
  JSON.stringify({ ttlDefault: P.PENDING_EVENT_TTL_MS, nav: [...NAV], cases }, null, 1) + '\n',
);
console.log(`b7s2-pending: ${cases.length} scenarios`);
