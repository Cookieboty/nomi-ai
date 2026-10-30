#!/usr/bin/env node
/**
 * 批次 8 服务级往返 golden：MemoryService / SchedulerService 在临时目录上跑一段固定调用序列，
 * 录下每步返回值、事件、审计、模型提示词与最终落盘 JSON。
 * Go 侧 apps/desktop-go/internal/core/knowledgehandlers/svc_parity_test.go 以同样的序列回放比对。
 * Usage: TZ=Asia/Shanghai npx tsx scripts/parity/record-b8-svc.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('run with TZ=Asia/Shanghai');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = (p) =>
  import(pathToFileURL(join(root, 'apps/desktop-electron/internal/core/src', p)).href);

let clock = new Date(2026, 9, 29, 9, 30).getTime();
Date.now = () => clock;
let seq = 0;
crypto.randomUUID = () => `id-${++seq}`;

const { MemoryService } = await core('memory/MemoryService.ts');
const { SchedulerService } = await core('schedule/SchedulerService.ts');

function harness(replies) {
  const t = { events: [], audits: [], notices: [], prompts: [], flushed: 0 };
  const desktop = {
    audit: {
      append: (e) => {
        const { ms, ...rest } = e;
        t.audits.push(rest);
      },
    },
    notify: (n) => t.notices.push(n),
    flushDeferred: () => t.flushed++,
    reminders: { today: () => [] },
    deferredCount: () => 0,
  };
  const events = { publish: (ch, p) => t.events.push([ch, p ?? null]) };
  const logger = { info() {}, warn() {} };
  const complete = async (msgs) => {
    t.prompts.push(msgs);
    return replies.shift() ?? '';
  };
  return { t, desktop, events, logger, complete };
}
const run = async (steps, f) => {
  try {
    steps.push({ out: JSON.parse(JSON.stringify((await f()) ?? null)) });
  } catch (e) {
    steps.push({ err: e.code ?? 'Error', msg: e.message });
  }
};
const readJ = (d, n) => {
  try {
    return JSON.parse(fs.readFileSync(join(d, n), 'utf8'));
  } catch {
    return null;
  }
};

const out = {};
{
  // memory
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'b8mem-'));
  const h = harness([
    '好的 {"title":"周末计划","summary":"用户打算周末去爬山，并询问了天气。","keywords":["爬山","天气","爬山"],"facts":[{"kind":"preference","text":"喜欢爬山"},{"kind":"bogus","text":"住在杭州"},{"text":"api key sk-abcdefghijklmnopqrstuv"}]}',
    'not json',
    '{"summary":"更新后的摘要","facts":[{"kind":"preference","text":"喜欢爬山"}]}',
  ]);
  const s = new MemoryService({
    root: dir,
    logger: h.logger,
    desktop: h.desktop,
    complete: h.complete,
    embed: async () => null,
    facade: () => null,
    ports: {},
    events: h.events,
  });
  const steps = [];
  const msgs = [
    { role: 'user', content: '周末去爬山怎么样' },
    { role: 'assistant', content: '好主意，记得看天气' },
    { role: 'system', content: 'x' },
    { role: 'user', content: '  ' },
  ];
  await run(steps, () => s.getSettings());
  await run(steps, () => s.setSettings({ minMessages: 2, bogus: 1, enabled: 'yes' }));
  await run(steps, () => s.setPersona('# 我\n喜欢简洁'));
  await run(steps, () => s.persona());
  await run(steps, () => s.ingest('c1', msgs.slice(0, 1)));
  clock += 1000;
  await run(steps, () => s.ingest('c1', msgs));
  await run(steps, () => s.ingest('c1', msgs));
  await run(steps, () => s.ingest('c2', msgs, { force: true }));
  clock += 1000;
  await run(steps, () =>
    s.ingest('c1', [
      ...msgs,
      { role: 'user', content: '再说一句' },
      { role: 'assistant', content: '好' },
    ]),
  );
  await run(steps, () => s.upsertFact({ text: '  喝美式  ', kind: 'preference' }));
  await run(steps, () => s.upsertFact({ text: '' }));
  clock += 1000;
  await run(steps, () => s.upsertFact({ id: 'id-3', text: '喜欢徒步', kind: 'nope' }));
  await run(steps, () =>
    s.updateEpisode('id-1', { title: '新标题', pinned: true, keywords: ['a', 'a', 'b'] }),
  );
  await run(steps, () => s.updateEpisode('missing', {}));
  await run(steps, () => s.list(''));
  await run(steps, () => s.list('美式'));
  await run(steps, () => s.remove('fact', 'id-4'));
  await run(steps, () => s.remove('fact', 'nope'));
  await run(steps, () => s.state());
  await run(steps, () => {
    const d = s.exportData();
    return d;
  });
  s.flush();
  const files = {
    'memory.json': readJ(dir, 'memory.json'),
    'settings.json': readJ(dir, 'settings.json'),
  };
  await run(steps, () => s.clearAll());
  s.flush();
  files['memory.json#cleared'] = readJ(dir, 'memory.json');
  out.memory = { steps, files, ...h.t };
}
{
  // schedule
  seq = 0;
  clock = new Date(2026, 9, 29, 9, 30).getTime();
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'b8sched-'));
  const h = harness(['  晨报：今天晴。  ', '']);
  const s = new SchedulerService({
    root: dir,
    logger: h.logger,
    desktop: h.desktop,
    complete: h.complete,
    memory: async () => '',
    openChat() {},
    ports: { power: { idleSeconds: () => 0 } },
    events: h.events,
  });
  const steps = [];
  await run(steps, () => s.settings());
  await run(steps, () =>
    s.upsertTask({ name: '晨报', prompt: '总结今天', time: '08:00', repeat: { kind: 'weekdays' } }),
  );
  await run(steps, () =>
    s.upsertTask({ name: '', prompt: 'x', time: '25:00', repeat: { kind: 'daily' } }),
  );
  await run(steps, () =>
    s.upsertTask({
      name: '喝水',
      prompt: '提醒喝水',
      time: '10:00',
      repeat: { kind: 'interval', minutes: 1 },
    }),
  );
  await run(steps, () =>
    s.upsertTask({ name: '坏', prompt: 'p', time: '10:00', repeat: { kind: 'zzz' } }),
  );
  clock += 60_000;
  await run(steps, () =>
    s.upsertTask({
      id: 'id-1',
      name: '晨报2',
      prompt: '总结今天',
      time: '07:30',
      repeat: { kind: 'weekly', days: [5, 1] },
      enabled: true,
    }),
  );
  await run(steps, () => s.setTaskEnabled('id-2', false));
  await run(steps, () => s.setTaskEnabled('nope', true));
  await run(steps, () =>
    s.setSettings({
      quiet: { enabled: true, start: '09:00', end: '10:00' },
      proactive: { enabled: true, perDay: 99 },
    }),
  );
  await run(steps, () => s.runTask('id-1', { manual: true }));
  await run(steps, () => s.setSettings({ quiet: { enabled: false } }));
  clock += 60_000;
  await run(steps, () => s.runTask('id-2'));
  await run(steps, () => s.runTask('nope'));
  await run(steps, () => s.tasks());
  await run(steps, () => s.results());
  await run(steps, () => s.state());
  await run(steps, () => s.removeTask('id-2'));
  await run(steps, () => s.removeTask('id-2'));
  const files = { 'schedule.json': readJ(dir, 'schedule.json') };
  await run(steps, () => s.clearResults());
  files['schedule.json#cleared'] = readJ(dir, 'schedule.json');
  out.schedule = { steps, files, ...h.t };
}
const dest = join(
  root,
  'apps/desktop-go/internal/core/knowledgehandlers/testdata/parity-b8-svc.json',
);
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
console.log('wrote', dest);
process.exit(0);
