import { DEFAULT_CATCH_UP_MS, TaskRuntime } from '../../../src/tasks/TaskRuntime';

import { baseInput, makeRuntime, MemStore } from './runtimeHarness';

const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);
const MIN = 60_000;
const ok = (summary = 'ok') => ({ summary, artifacts: [] });

describe('TaskRuntime', () => {
  it('手动运行：入队 → 拿名额 → 执行 → 完成投递；状态变化写进日志', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const t = h.rt.create(baseInput());
    expect(h.rt.command(t.id, { type: 'runNow' })).toEqual({ ok: true });
    expect(h.exec.calls).toEqual([
      { op: 'start', taskId: t.id, gen: 1, attemptId: 'att_2', cause: { kind: 'manual' } },
    ]);
    expect(h.rt.slotHolders()).toEqual([t.id]);
    h.exec.reporters.get(t.id)!.completed(ok());
    expect(h.rt.get(t.id)!.task.status).toBe('done');
    expect(h.rt.slotHolders()).toEqual([]);
    expect(h.delivered).toEqual([{ taskId: t.id, what: 'result', attemptId: 'att_2' }]);
    expect(
      h.store.journals.get(t.id)!.map((e) => (e.t === 'state' ? `${e.from}>${e.to}` : e.t)),
    ).toEqual(['none>idle', 'idle>queued', 'queued>running', 'running>done']);
  });

  it('并发上限：超出的排队，有名额释放才开跑', () => {
    const h = makeRuntime(T0, new MemStore(), { maxConcurrent: 2 });
    h.rt.start();
    const ids = [1, 2, 3].map(() => h.rt.create(baseInput()).id);
    for (const id of ids) h.rt.command(id, { type: 'runNow' });
    expect(h.exec.calls.map((c) => c.taskId)).toEqual(ids.slice(0, 2));
    expect(h.rt.get(ids[2])!.task.status).toBe('queued');
    h.exec.reporters.get(ids[0])!.completed(ok());
    expect(h.exec.calls.map((c) => c.taskId)).toEqual(ids);
  });

  it('等人释放名额；回应后用人工名额恢复，即使名额已满', () => {
    const h = makeRuntime(T0, new MemStore(), { maxConcurrent: 1 });
    h.rt.start();
    const a = h.rt.create(baseInput()).id;
    const b = h.rt.create(baseInput()).id;
    h.rt.command(a, { type: 'runNow' });
    h.exec.reporters.get(a)!.needsUser({ kind: 'approval', requestId: 'r1' });
    expect(h.rt.slotHolders()).toEqual([]);
    h.rt.command(b, { type: 'runNow' });
    expect(h.rt.slotHolders()).toEqual([b]);
    h.rt.command(a, { type: 'decide', requestId: 'r1', approve: true });
    expect(h.rt.get(a)!.task.status).toBe('running');
    expect(h.rt.slotHolders()).toEqual([a, b].sort());
    expect(h.exec.calls.at(-1)).toEqual({
      op: 'resume',
      taskId: a,
      gen: 1,
      answer: { requestId: 'r1', approve: true },
    });
  });

  it('瞬时错误按退避重试，到点自动再开跑', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput()).id;
    h.rt.command(id, { type: 'runNow' });
    h.exec.reporters.get(id)!.failed({ code: 'network', message: 'reset' });
    expect(h.rt.get(id)!.task.status).toBe('queued');
    h.clock.advance(1999);
    expect(h.exec.calls).toHaveLength(1);
    h.clock.advance(1);
    expect(h.exec.calls.map((c) => [c.op, c.gen])).toEqual([
      ['start', 1],
      ['start', 2],
    ]);
    expect(h.exec.calls[1].cause).toEqual({ kind: 'retry', note: 'network' });
  });

  it('定时：到点触发；执行中到点跳过并记录；超出补跑窗口的不补', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(
      baseInput({
        trigger: { kind: 'schedule', at: T0 + 10 * MIN, repeat: { kind: 'interval', minutes: 10 } },
      }),
    ).id;
    expect(h.rt.get(id)!.task.nextRunAt).toBe(T0 + 10 * MIN);
    h.clock.advance(10 * MIN);
    expect(h.exec.calls).toHaveLength(1);
    expect(h.rt.get(id)!.task.nextRunAt).toBe(T0 + 20 * MIN);
    // 一直在跑（每分钟心跳），下一次到点跳过
    for (let i = 0; i < 10; i++) {
      h.clock.advance(MIN);
      h.exec.reporters.get(id)!.heartbeat();
    }
    expect(h.exec.calls).toHaveLength(1);
    expect(h.store.journals.get(id)!.some((e) => e.t === 'note' && e.msg === 'skipped:busy')).toBe(
      true,
    );
    h.exec.reporters.get(id)!.completed(ok());
    expect(h.rt.get(id)!.task.status).toBe('idle');
    h.clock.advance(10 * MIN);
    expect(h.exec.calls).toHaveLength(2);
  });

  it('重启：补跑窗口内错过的定时补一次；运行中的中断后续跑；等人的保持', () => {
    const store = new MemStore();
    const h1 = makeRuntime(T0, store);
    h1.rt.start();
    const sched = h1.rt.create(
      baseInput({ trigger: { kind: 'schedule', at: T0 + 60 * MIN, repeat: { kind: 'daily' } } }),
    ).id;
    const running = h1.rt.create(baseInput()).id;
    const waiting = h1.rt.create(baseInput()).id;
    h1.rt.command(running, { type: 'runNow' });
    h1.rt.command(waiting, { type: 'runNow' });
    h1.exec.reporters.get(waiting)!.needsUser({ kind: 'input', requestId: 'q' });
    h1.rt.stop();

    // 关机 3 小时后启动：定时错过 2 小时（在 12 小时窗口内）
    const h2 = makeRuntime(T0 + 3 * 60 * MIN, store);
    h2.rt.start();
    // 重启把代次推到 2（旧执行作废），续跑的新执行是第 3 代
    expect(h2.rt.get(running)!.task).toMatchObject({ status: 'running', gen: 3 });
    expect(h2.rt.get(waiting)!.task).toMatchObject({ status: 'waiting_user', gen: 2 });
    expect(h2.rt.get(waiting)!.task.wait).toMatchObject({ resumeTo: 'queued' });
    expect(h2.exec.calls.map((c) => [c.taskId, c.cause])).toEqual([
      [running, { kind: 'resume' }],
      [sched, { kind: 'schedule' }],
    ]);
    expect(h2.rt.get(sched)!.task.nextRunAt).toBe(T0 + 60 * MIN + 86_400_000);

    // 超出补跑窗口：不补
    const store3 = new MemStore();
    const h3 = makeRuntime(T0, store3);
    h3.rt.start();
    const s3 = h3.rt.create(baseInput({ trigger: { kind: 'schedule', at: T0 + MIN } })).id;
    h3.rt.stop();
    const h4 = makeRuntime(T0 + MIN + DEFAULT_CATCH_UP_MS + 1, store3);
    h4.rt.start();
    expect(h4.exec.calls).toEqual([]);
    expect(h4.rt.get(s3)!.task.nextRunAt).toBeUndefined();
    expect(
      store3.journals.get(s3)!.some((e) => e.t === 'note' && e.msg.startsWith('missed:')),
    ).toBe(true);
  });

  it('重启时有未确认的对外动作 → 需要核对', () => {
    const store = new MemStore();
    const h1 = makeRuntime(T0, store);
    h1.rt.start();
    const id = h1.rt.create(baseInput()).id;
    h1.rt.command(id, { type: 'runNow' });
    store.append(id, {
      t: 'intent',
      at: T0,
      attemptId: 'att_2',
      seq: 1,
      action: 'github.comment',
      hash: 'h',
    });
    const h2 = makeRuntime(T0 + MIN, store);
    h2.rt.start();
    expect(h2.rt.get(id)!.task.status).toBe('needs_reconcile');
    expect(h2.delivered).toEqual([{ taskId: id, what: 'reconcile', attemptId: 'att_2' }]);
  });

  it('看守：心跳超时判崩溃并重试；超时长判 timed_out 不重试', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput()).id;
    h.rt.command(id, { type: 'runNow' });
    // 看守每分钟醒一次：最后一次心跳 5 分钟后的下一次检查判崩溃
    h.clock.advance(6 * MIN);
    expect(h.exec.calls[1]).toEqual({ op: 'stop', taskId: id, gen: 1, reason: 'cancel' });
    expect(h.rt.get(id)!.attempts[0].error).toEqual({
      code: 'executor_crashed',
      message: 'heartbeat_timeout',
    });
    expect(h.rt.get(id)!.task.status).toBe('queued');

    const h2 = makeRuntime(T0);
    h2.rt.start();
    const id2 = h2.rt.create(baseInput({ budget: { maxDurationMsPerAttempt: 3 * MIN } })).id;
    h2.rt.command(id2, { type: 'runNow' });
    for (let i = 0; i < 4; i++) {
      h2.clock.advance(MIN);
      h2.exec.reporters.get(id2)?.heartbeat();
    }
    expect(h2.rt.get(id2)!.task).toMatchObject({
      status: 'failed',
      lastError: { code: 'timed_out' },
    });
    expect(h2.exec.calls.filter((c) => c.op === 'stop')).toEqual([
      { op: 'stop', taskId: id2, gen: 1, reason: 'timeout' },
    ]);
  });

  it('token 超出：执行先停在原地，等用户批准继续', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput({ budget: { maxTokensPerAttempt: 1000 } })).id;
    h.rt.command(id, { type: 'runNow' });
    const rep = h.exec.reporters.get(id)!;
    rep.usage({ inputTokens: 600, outputTokens: 300, costUsd: 0.01 });
    expect(h.rt.get(id)!.task.status).toBe('running');
    rep.usage({ outputTokens: 200 });
    expect(h.rt.get(id)!.task).toMatchObject({ status: 'waiting_user', wait: { kind: 'budget' } });
    expect(h.rt.get(id)!.attempts[0].usage).toEqual({
      inputTokens: 600,
      outputTokens: 500,
      costUsd: 0.01,
      costKnown: true,
    });
    expect(h.exec.calls.at(-1)).toEqual({ op: 'stop', taskId: id, gen: 1, reason: 'pause' });
    h.rt.command(id, { type: 'decide', approve: true });
    expect(h.exec.calls.at(-1)).toMatchObject({ op: 'resume', answer: { approve: true } });
  });

  it('运行中暂停、随后失败重试：恢复后重新排队开跑（不会卡在排队）', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput()).id;
    h.rt.command(id, { type: 'runNow' });
    h.rt.command(id, { type: 'pause' });
    h.exec.reporters.get(id)!.failed({ code: 'network', message: 'x' });
    h.clock.advance(MIN);
    expect(h.rt.get(id)!.task.status).toBe('queued');
    expect(h.exec.calls.filter((c) => c.op === 'start')).toHaveLength(1);
    h.rt.command(id, { type: 'resume' });
    expect(h.exec.calls.filter((c) => c.op === 'start')).toHaveLength(2);
    expect(h.rt.get(id)!.task.status).toBe('running');
  });

  it('准备失败（配置变了）：不重试，停下来问用户；继续 = 重跑，放弃 = 失败', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput()).id;
    h.exec.prepareError.set(id, { code: 'config_changed', message: 'claude not logged in' });
    h.rt.command(id, { type: 'runNow' });
    expect(h.exec.calls).toEqual([]);
    expect(h.rt.get(id)!.task).toMatchObject({
      status: 'waiting_user',
      wait: { kind: 'config', detail: 'claude not logged in', resumeTo: 'queued' },
      lastError: { code: 'config_changed' },
    });
    // 处理好了：重跑
    h.exec.prepareError.delete(id);
    expect(h.rt.command(id, { type: 'decide', approve: true }).ok).toBe(true);
    expect(h.rt.get(id)!.task.status).toBe('running');
    // 再坏一次，这次放弃
    const id2 = h.rt.create(baseInput()).id;
    h.exec.prepareError.set(id2, { code: 'config_changed', message: 'x' });
    h.rt.command(id2, { type: 'runNow' });
    expect(h.rt.command(id2, { type: 'decide', approve: false }).ok).toBe(true);
    expect(h.rt.get(id2)!.task).toMatchObject({
      status: 'failed',
      lastError: { code: 'config_changed' },
    });
  });

  it('晚到的回报只记日志', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput()).id;
    h.rt.command(id, { type: 'runNow' });
    const old = h.exec.reporters.get(id)!;
    h.rt.command(id, { type: 'cancel' });
    old.completed(ok('late'));
    expect(h.rt.get(id)!.task.status).toBe('cancelled');
    expect(h.store.journals.get(id)!.at(-1)).toMatchObject({ t: 'note', msg: 'stale:completed' });
    expect(h.delivered).toEqual([]);
  });

  it('撤销授权、重新授权；只能删除结束态的任务', () => {
    const h = makeRuntime(T0);
    h.rt.start();
    const id = h.rt.create(baseInput()).id;
    h.rt.command(id, { type: 'runNow' });
    h.rt.command(id, { type: 'revoke' });
    expect(h.exec.calls.at(-1)).toEqual({ op: 'stop', taskId: id, gen: 1, reason: 'revoked' });
    expect(h.rt.remove(id)).toBe(false);
    h.rt.command(id, { type: 'grant', grant: { level: 1, paths: [], connections: [] } });
    expect(h.rt.get(id)!.task.grant).toMatchObject({ version: 2, grantedAt: T0 });
    expect(h.exec.calls.at(-1)).toMatchObject({ op: 'start', gen: 3, cause: { kind: 'resume' } });
    h.rt.command(id, { type: 'cancel' });
    expect(h.rt.remove(id)).toBe(true);
    expect(h.rt.get(id)).toBeNull();
  });

  it('编程助手执行默认要验收；授权默认 30 天', () => {
    const h = makeRuntime(T0);
    const t = h.rt.create(
      baseInput({ executor: { kind: 'cli', cli: 'claude', cwd: '/w', isolation: 'worktree' } }),
    );
    expect(t.acceptance).toBe('user');
    expect(t.grant.expiresAt).toBe(T0 + 30 * 86_400_000);
    expect(t.budget).toEqual({
      maxTokensPerAttempt: 200_000,
      maxDurationMsPerAttempt: 30 * MIN,
      maxCostUsdPerDay: 1,
      maxRetries: 3,
    });
    expect(TaskRuntime).toBeDefined();
  });
});
