#!/usr/bin/env node
/**
 * 持续任务状态机 golden（apps/desktop-electron/internal/core/src/tasks/machine.ts）。
 * 先用事件前缀造出各种起始状态，再对每个起始状态施加全部事件类型（含代次过期的回报），逐步记录
 * { ok, reason, task, attempt, effects }（遍历只记最后一步，长链逐步记）。Go 版（internal/core/tasks/machine_parity_test.go）重放同样的事件逐条比对。
 * 输出 apps/desktop-go/internal/core/tasks/testdata/tasks-machine.json（NOMI_GOLDEN_DIR 优先）。
 * CI 由 record-b7-drivers.mjs 链式录制。
 * Usage: node --import tsx scripts/parity/record-tasks-machine.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { M } = await importSources(root, {
  M: path.join(root, 'apps/desktop-electron/internal/core/src/tasks/machine.ts'),
});
const { transition } = M;

const T0 = 1_800_000_000_000;
const grant = (v = 1, over = {}) => ({
  version: v,
  level: 1,
  paths: [],
  connections: [],
  grantedAt: T0,
  ...over,
});
const mkTask = (over = {}) => ({
  id: 'task_1',
  title: 't',
  goal: 'g',
  origin: { createdBy: 'user', createdAt: T0 },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: grant(),
  budget: { maxRetries: 3 },
  acceptance: 'auto',
  status: 'idle',
  enabled: true,
  gen: 0,
  retryCount: 0,
  consecutiveFailures: 0,
  updatedAt: T0,
  schemaVersion: 1,
  ...over,
});
const daily = { trigger: { kind: 'schedule', at: T0, repeat: { kind: 'daily' } } };
const event = {
  trigger: {
    kind: 'event',
    sourceId: 'github',
    filter: { repo: 'o/r' },
    cooldownMs: 30000,
    mode: 'act',
  },
};

// ---- 事件构造（gen 取当前任务代次；stale 版本取旧代次） ----
const E = {
  trig: (at, cause = 'manual', extra = {}) => ({ type: 'trigger', at, cause, ...extra }),
  slot: (at, id = 'att_1') => ({
    type: 'slot_acquired',
    at,
    attemptId: id,
    snapshot: { grantVersion: 1, model: 'm' },
  }),
  need: (at, gen, kind = 'approval', requestId = 'r1') => ({
    type: 'needs_user',
    at,
    gen,
    wait: kind === 'budget' ? { kind } : { kind, requestId, detail: 'd' },
  }),
  done: (at, gen) => ({
    type: 'completed',
    at,
    gen,
    result: { summary: 'ok', artifacts: [{ kind: 'file', ref: 'out.md' }] },
  }),
  fail: (at, gen, code = 'network') => ({ type: 'failed', at, gen, error: { code, message: code } }),
  take: (at, gen) => ({ type: 'taken_over', at, gen }),
  restart: (at, unconfirmedExternal = false) => ({ type: 'restarted', at, unconfirmedExternal }),
};

/** 起始状态：名字 → [初始任务, 事件前缀] */
const bases = {
  idle: [mkTask(), []],
  idle_daily: [mkTask(daily), []],
  idle_event_user_accept: [mkTask({ ...event, acceptance: 'user' }), []],
  idle_paused: [mkTask({ ...daily, enabled: false }), []],
  idle_revoked: [mkTask({ grant: grant(1, { revokedAt: T0 }) }), []],
  idle_expiring: [mkTask({ ...daily, grant: grant(1, { expiresAt: T0 + 5 }) }), []],
  queued: [mkTask(), [E.trig(T0 + 1)]],
  queued_backoff: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.fail(T0 + 3, 1)]],
  running: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2)]],
  running_daily_cf2: [
    mkTask({ ...daily, consecutiveFailures: 2, budget: { maxRetries: 0 } }),
    [E.trig(T0 + 1, 'schedule'), E.slot(T0 + 2)],
  ],
  running_paused: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), { type: 'pause', at: T0 + 3 }]],
  running_retries_spent: [
    mkTask({ budget: { maxRetries: 1 } }),
    [E.trig(T0 + 1), E.slot(T0 + 2), E.fail(T0 + 3, 1), E.slot(T0 + 2003, 'att_2')],
  ],
  waiting_approval: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.need(T0 + 3, 1)]],
  waiting_input: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.need(T0 + 3, 1, 'input', 'q1')]],
  waiting_budget_live: [mkTask(daily), [E.trig(T0 + 1, 'schedule'), E.slot(T0 + 2), E.need(T0 + 3, 1, 'budget')]],
  waiting_budget_trigger: [mkTask(daily), [E.trig(T0 + 1, 'schedule', { budgetExceeded: true, eventKey: 'k1' })]],
  waiting_taken_over: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.take(T0 + 3, 1)]],
  waiting_after_restart: [
    mkTask(),
    [E.trig(T0 + 1), E.slot(T0 + 2), E.need(T0 + 3, 1, 'input', 'q1'), E.restart(T0 + 4)],
  ],
  waiting_grant: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), { type: 'grant_revoked', at: T0 + 3 }]],
  waiting_grant_idle: [mkTask(daily), [{ type: 'grant_revoked', at: T0 + 1 }]],
  awaiting_accept: [
    mkTask({ acceptance: 'user' }),
    [E.trig(T0 + 1), E.slot(T0 + 2), E.done(T0 + 3, 1)],
  ],
  needs_reconcile: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.restart(T0 + 3, true)]],
  done: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.done(T0 + 3, 1)]],
  failed: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), E.fail(T0 + 3, 1, 'timed_out')]],
  cancelled: [mkTask(), [E.trig(T0 + 1), E.slot(T0 + 2), { type: 'cancel', at: T0 + 3 }]],
  expired: [mkTask(daily), [{ type: 'grant_expired', at: T0 + 1 }]],
};

/** 对一个状态施加的全部事件（at 统一取 T0 + 100000，越过所有退避） */
const probes = (task) => {
  const at = T0 + 100_000;
  const g = task.gen;
  const rq = task.wait?.requestId;
  return [
    E.trig(at),
    E.trig(at, 'schedule'),
    E.trig(at, 'event', { eventKey: 'ev1' }),
    E.trig(at, 'manual', { budgetExceeded: true }),
    E.slot(at, 'att_new'),
    E.need(at, g),
    E.need(at, g, 'budget'),
    E.need(at, g - 1),
    E.done(at, g),
    E.done(at, g - 1),
    E.fail(at, g),
    E.fail(at, g, 'executor_failed'),
    E.fail(at, g, 'nope'),
    E.take(at, g),
    { type: 'decide', at, gen: g, requestId: rq, approve: true, input: 'yes' },
    { type: 'decide', at, requestId: rq, approve: false },
    { type: 'decide', at, gen: g + 7, requestId: rq, approve: true },
    { type: 'decide', at, requestId: 'other', approve: true },
    { type: 'accept', at },
    { type: 'reject', at, feedback: 'redo' },
    { type: 'cancel', at },
    { type: 'pause', at },
    { type: 'resume', at },
    { type: 'reconcile', at, outcome: 'applied' },
    { type: 'reconcile', at, outcome: 'not_applied' },
    { type: 'reconcile', at, outcome: 'abandon' },
    E.restart(at),
    E.restart(at, true),
    { type: 'grant_revoked', at },
    { type: 'grant_expired', at },
    { type: 'grant_updated', at, grant: grant(task.grant.version + 1, { grantedAt: at }) },
    { type: 'grant_updated', at, grant: grant(task.grant.version, { grantedAt: at }) },
  ];
};

const play = (task, attempt, events) => {
  const steps = [];
  let cur = { task, attempt };
  for (const ev of events) {
    const r = transition(cur.task, cur.attempt, ev);
    steps.push(JSON.parse(JSON.stringify(r)));
    cur = r;
  }
  return { steps, end: cur };
};

const scenarios = [];
for (const [name, [task, prefix]] of Object.entries(bases)) {
  const { steps, end } = play(task, null, prefix);
  if (steps.some((s) => !s.ok)) throw new Error(`base ${name}: prefix step rejected`);
  for (const [i, ev] of probes(end.task).entries()) {
    const events = [...prefix, ev];
    // 前缀在造起始状态时已确认全部 ok；只记最后一步，Go 侧重放前缀、比对最后一步
    scenarios.push({ name: `${name}#${i}:${ev.type}`, task, events, last: play(task, null, events).steps.at(-1) });
  }
}

// 长链：重试三次后失败；重复任务连续失败自动暂停后恢复
const chain = (name, task, events) =>
  scenarios.push({ name, task, events, steps: play(task, null, events).steps });
{
  const evs = [E.trig(T0 + 1), E.slot(T0 + 2)];
  let at = T0 + 10;
  for (let i = 1; i <= 4; i++) {
    evs.push(E.fail(at, i));
    at += 70_000;
    evs.push(E.slot(at, `att_${i + 1}`));
  }
  chain('retry_chain', mkTask(), evs);
}
{
  const evs = [];
  for (let i = 1; i <= 3; i++) {
    const at = T0 + i * 1000;
    evs.push(E.trig(at, 'schedule'), E.slot(at + 1, `att_${i}`), E.fail(at + 2, i, 'executor_failed'));
  }
  evs.push({ type: 'resume', at: T0 + 9000 }, E.trig(T0 + 9001, 'schedule'));
  chain('auto_pause_chain', mkTask({ ...daily, budget: { maxRetries: 0 } }), evs);
}
chain('answer_after_restart', mkTask(), [
  E.trig(T0 + 1),
  E.slot(T0 + 2),
  E.need(T0 + 3, 1, 'input', 'q1'),
  E.restart(T0 + 4),
  { type: 'decide', at: T0 + 5, requestId: 'q1', approve: true, input: 'main' },
  E.slot(T0 + 6, 'att_2'),
  E.done(T0 + 7, 2),
]);

// 事件触发的执行：重试与重启续跑都沿用原事件批（#240）
chain('event_key_carried', mkTask(event), [
  E.trig(T0 + 1, 'event', { eventKey: 'ev1' }),
  E.slot(T0 + 2),
  E.fail(T0 + 3, 1),
  E.slot(T0 + 70_000, 'att_2'),
  E.restart(T0 + 70_001),
  E.slot(T0 + 70_002, 'att_3'),
  E.done(T0 + 70_003, 3),
]);

const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/tasks/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tasks-machine.json'), `${JSON.stringify({ scenarios })}\n`);
console.info(`tasks-machine: ${scenarios.length} scenarios`);
