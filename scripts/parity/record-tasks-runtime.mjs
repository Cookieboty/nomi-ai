#!/usr/bin/env node
/**
 * 持续任务运行时 golden（apps/desktop-electron/internal/core/src/tasks/TaskRuntime.ts）。
 * 用 tests/unit/tasks/runtimeHarness.ts 的内存存储、假时钟、假执行者跑脚本化场景，每一步记录
 * 命令结果、新增的执行者调用与投递；场景结束记录全部任务与日志。Go 版（internal/core/tasks/runtime_parity_test.go）
 * 用同样的脚本重放比对。定时只用 interval / 一次性（与时区无关）。
 * 输出 apps/desktop-go/internal/core/tasks/testdata/tasks-runtime.json（NOMI_GOLDEN_DIR 优先）。
 * Usage: node --import tsx scripts/parity/record-tasks-runtime.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const core = (p) => path.join(root, 'apps/desktop-electron/internal/core', p);
const { R, H } = await importSources(root, {
  R: core('src/tasks/TaskRuntime.ts'),
  H: core('tests/unit/tasks/runtimeHarness.ts'),
});

const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** 按脚本跑一个场景；restart 换新的运行时与执行者，存储与 id 计数沿用 */
function play(ops, opts = {}) {
  const store = new H.MemStore();
  let ids = 0;
  let clock;
  let exec;
  let rt;
  let delivered = [];
  const boot = (t) => {
    clock = new H.FakeClock(t);
    exec = new H.FakeExecutor();
    delivered = [];
    rt = new R.TaskRuntime({
      store,
      executors: { nomi: exec, notify: exec, cli: exec },
      now: clock.now,
      setTimer: clock.setTimer,
      newId: (p) => `${p}_${++ids}`,
      logger: { info: () => undefined, warn: () => undefined },
      deliver: (task, what, attempt) =>
        delivered.push({ taskId: task.id, what, ...(attempt ? { attemptId: attempt.id } : {}) }),
      maxConcurrent: opts.maxConcurrent ?? 2,
      heartbeatTimeoutMs: 5 * MIN,
    });
  };
  boot(T0);
  const steps = [];
  for (const op of ops) {
    const callsBefore = exec.calls.length;
    const delBefore = delivered.length;
    let result;
    switch (op.op) {
      case 'start':
        rt.start();
        break;
      case 'create':
        result = rt.create(op.input).id;
        break;
      case 'cmd':
        result = rt.command(op.task, op.cmd);
        break;
      case 'advance':
        clock.advance(op.ms);
        break;
      case 'report': {
        const rep = exec.reporters.get(op.task);
        if (op.kind === 'heartbeat') rep.heartbeat();
        else if (op.kind === 'takenOver') rep.takenOver();
        else rep[op.kind](op.arg);
        break;
      }
      case 'prepareError':
        if (op.error) exec.prepareError.set(op.task, op.error);
        else exec.prepareError.delete(op.task);
        break;
      case 'intent':
        store.append(op.task, { t: 'intent', at: clock.now(), attemptId: op.attemptId, seq: 1, action: 'x', hash: 'h' });
        break;
      case 'restart': {
        rt.stop();
        const t = clock.now() + (op.ms ?? 0);
        boot(t);
        rt.start();
        steps.push({ op, calls: exec.calls, delivered });
        continue;
      }
      case 'remove':
        result = rt.remove(op.task);
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    steps.push({
      op,
      ...(result !== undefined ? { result } : {}),
      calls: exec.calls.slice(callsBefore),
      delivered: delivered.slice(delBefore),
    });
  }
  return {
    steps,
    records: store.loadAll(),
    journals: Object.fromEntries([...store.journals.keys()].sort().map((k) => [k, store.journals.get(k)])),
    slots: rt.slotHolders(),
  };
}

const input = (over = {}) => ({
  title: 't',
  goal: 'g',
  origin: { createdBy: 'user', createdAt: 0 },
  trigger: { kind: 'manual' },
  executor: { kind: 'nomi', tools: ['read'] },
  grant: { level: 1, paths: [], connections: [] },
  ...over,
});
const create = (over) => ({ op: 'create', input: input(over) });
const cmd = (task, c) => ({ op: 'cmd', task, cmd: c });
const rep = (task, kind, arg) => ({ op: 'report', task, kind, ...(arg !== undefined ? { arg } : {}) });
const adv = (ms) => ({ op: 'advance', ms });
const ok = { summary: 'ok', artifacts: [] };
const every = (min, at = T0 + 10 * MIN) => ({ kind: 'schedule', at, repeat: { kind: 'interval', minutes: min } });

const scenarios = {
  manual_done: [{ op: 'start' }, create(), cmd('task_1', { type: 'runNow' }), rep('task_1', 'completed', ok)],
  concurrency: [
    { op: 'start' },
    create(),
    create(),
    create(),
    cmd('task_1', { type: 'runNow' }),
    cmd('task_2', { type: 'runNow' }),
    cmd('task_3', { type: 'runNow' }),
    rep('task_1', 'completed', ok),
    rep('task_2', 'failed', { code: 'executor_failed', message: 'x' }),
  ],
  waiting_frees_slot: [
    { op: 'start' },
    create(),
    create(),
    cmd('task_1', { type: 'runNow' }),
    rep('task_1', 'needsUser', { kind: 'approval', requestId: 'r1', detail: 'rm' }),
    cmd('task_2', { type: 'runNow' }),
    cmd('task_1', { type: 'decide', requestId: 'r1', approve: true }),
    rep('task_1', 'completed', ok),
  ],
  retry_backoff: [
    { op: 'start' },
    create(),
    cmd('task_1', { type: 'runNow' }),
    rep('task_1', 'failed', { code: 'network', message: 'reset' }),
    adv(1999),
    adv(1),
    rep('task_1', 'failed', { code: 'upstream_transient', message: '503' }),
    adv(4000),
    rep('task_1', 'completed', ok),
  ],
  schedule_skip_and_run: [
    { op: 'start' },
    create({ trigger: every(10) }),
    adv(10 * MIN),
    ...Array.from({ length: 10 }, () => [adv(MIN), rep('task_1', 'heartbeat')]).flat(),
    rep('task_1', 'completed', ok),
    adv(10 * MIN),
    cmd('task_1', { type: 'pause' }),
    adv(30 * MIN),
    cmd('task_1', { type: 'resume' }),
    adv(10 * MIN),
  ],
  restart_recovery: [
    { op: 'start' },
    create({ trigger: every(60, T0 + 60 * MIN) }),
    create(),
    create(),
    create(),
    cmd('task_2', { type: 'runNow' }),
    cmd('task_3', { type: 'runNow' }),
    rep('task_3', 'needsUser', { kind: 'input', requestId: 'q' }),
    cmd('task_4', { type: 'runNow' }),
    { op: 'intent', task: 'task_4', attemptId: 'att_7' },
    { op: 'restart', ms: 3 * 60 * MIN },
    cmd('task_3', { type: 'decide', requestId: 'q', approve: true, input: 'main' }),
    cmd('task_4', { type: 'reconcile', outcome: 'applied' }),
  ],
  missed_one_off: [
    { op: 'start' },
    create({ trigger: { kind: 'schedule', at: T0 + MIN } }),
    { op: 'restart', ms: 13 * 60 * MIN },
  ],
  watchdog: [
    { op: 'start' },
    create(),
    create({ budget: { maxDurationMsPerAttempt: 3 * MIN } }),
    cmd('task_1', { type: 'runNow' }),
    cmd('task_2', { type: 'runNow' }),
    adv(MIN),
    rep('task_2', 'heartbeat'),
    adv(MIN),
    rep('task_2', 'heartbeat'),
    adv(MIN),
    rep('task_2', 'heartbeat'),
    adv(MIN),
    adv(3 * MIN),
  ],
  token_budget: [
    { op: 'start' },
    create({ budget: { maxTokensPerAttempt: 1000 } }),
    cmd('task_1', { type: 'runNow' }),
    rep('task_1', 'usage', { inputTokens: 600, outputTokens: 300, costUsd: 0.01 }),
    rep('task_1', 'usage', { outputTokens: 200, costKnown: false }),
    cmd('task_1', { type: 'decide', approve: true }),
    rep('task_1', 'completed', ok),
  ],
  prepare_error: [
    { op: 'start' },
    create(),
    { op: 'prepareError', task: 'task_1', error: { code: 'config_changed', message: 'logged out' } },
    cmd('task_1', { type: 'runNow' }),
    { op: 'prepareError', task: 'task_1', error: null },
    cmd('task_1', { type: 'runNow' }),
  ],
  stale_and_grants: [
    { op: 'start' },
    create({ executor: { kind: 'cli', cli: 'claude', cwd: '/w', isolation: 'worktree' } }),
    cmd('task_1', { type: 'runNow' }),
    cmd('task_1', { type: 'revoke' }),
    { op: 'remove', task: 'task_1' },
    cmd('task_1', { type: 'grant', grant: { level: 2, paths: ['/w'], connections: [], clis: ['claude'] } }),
    rep('task_1', 'completed', ok),
    cmd('task_1', { type: 'reject', feedback: 'again' }),
    rep('task_1', 'takenOver'),
    cmd('task_1', { type: 'decide', approve: true }),
    cmd('task_1', { type: 'cancel' }),
    { op: 'remove', task: 'task_1' },
    cmd('task_9', { type: 'runNow' }),
  ],
  auto_pause: [
    { op: 'start' },
    create({ trigger: every(10), budget: { maxRetries: 0 } }),
    adv(10 * MIN),
    rep('task_1', 'failed', { code: 'executor_failed', message: 'x' }),
    adv(10 * MIN),
    rep('task_1', 'failed', { code: 'executor_failed', message: 'x' }),
    adv(10 * MIN),
    rep('task_1', 'failed', { code: 'executor_failed', message: 'x' }),
    adv(30 * MIN),
    cmd('task_1', { type: 'resume' }),
    adv(10 * MIN),
  ],
};

const out = {
  T0,
  scenarios: Object.entries(scenarios).map(([name, ops]) => ({
    name,
    maxConcurrent: name === 'waiting_frees_slot' ? 1 : 2,
    ops,
    ...play(ops, { maxConcurrent: name === 'waiting_frees_slot' ? 1 : 2 }),
  })),
};

const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/tasks/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tasks-runtime.json'), `${JSON.stringify(out)}\n`);
console.info(`tasks-runtime: ${out.scenarios.length} scenarios`);
