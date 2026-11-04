import { retryBackoffMs } from '../../../src/tasks/errors';
import { transition, type TaskEvent, type TransitionResult } from '../../../src/tasks/machine';
import { fromExternalEvent, type Attempt, type Task } from '../../../src/tasks/types';

const T0 = 1_800_000_000_000;

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: 't',
    goal: 'g',
    origin: { createdBy: 'user', createdAt: T0 },
    trigger: { kind: 'manual' },
    executor: { kind: 'nomi', tools: ['read'] },
    grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: T0 },
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
  };
}

const daily: Partial<Task> = {
  trigger: { kind: 'schedule', at: T0, repeat: { kind: 'daily' } },
};

/** 依次喂事件，每步都要求 ok（除非 expectFail），返回最后一步与全部效果 */
function run(task: Task, events: TaskEvent[], attempt: Attempt | null = null) {
  let r: TransitionResult = { ok: true, task, attempt, effects: [] };
  const all: TransitionResult[] = [];
  for (const ev of events) {
    r = transition(r.task, r.attempt, ev);
    all.push(r);
  }
  return { last: r, all };
}

const trig = (at = T0 + 1): TaskEvent => ({ type: 'trigger', at, cause: 'manual' });
const slot = (at = T0 + 2, id = 'att_1'): TaskEvent => ({
  type: 'slot_acquired',
  at,
  attemptId: id,
  snapshot: { grantVersion: 1 },
});
const kinds = (r: TransitionResult) => r.effects.map((e) => e.kind);

describe('tasks/machine', () => {
  it('idle → queued → running → done（不需要验收）', () => {
    const { all, last } = run(mkTask(), [
      trig(),
      slot(),
      { type: 'completed', at: T0 + 3, gen: 1, result: { summary: 'ok', artifacts: [] } },
    ]);
    expect(all.map((r) => r.task.status)).toEqual(['queued', 'running', 'done']);
    expect(kinds(all[0])).toEqual(['enqueue']);
    expect(all[1].effects).toEqual([{ kind: 'start_attempt', attemptId: 'att_1', gen: 1 }]);
    expect(kinds(last)).toEqual(['release_slot', 'deliver']);
    expect(last.attempt).toMatchObject({ status: 'succeeded', gen: 1, endedAt: T0 + 3 });
  });

  it('输入对象不被修改', () => {
    const t = mkTask();
    const snap = JSON.stringify(t);
    transition(t, null, trig());
    expect(JSON.stringify(t)).toBe(snap);
  });

  it('重复任务结束回到 idle 并算下一次；验收任务进 awaiting_accept', () => {
    const rec = run(mkTask(daily), [
      { type: 'trigger', at: T0 + 1, cause: 'schedule' },
      slot(),
      { type: 'completed', at: T0 + 3, gen: 1, result: { summary: 'ok', artifacts: [] } },
    ]).last;
    expect(rec.task.status).toBe('idle');
    expect(kinds(rec)).toContain('schedule_next');

    const acc = run(mkTask({ acceptance: 'user' }), [
      trig(),
      slot(),
      { type: 'completed', at: T0 + 3, gen: 1, result: { summary: 'ok', artifacts: [] } },
    ]).last;
    expect(acc.task.status).toBe('awaiting_accept');
    expect(transition(acc.task, acc.attempt, { type: 'accept', at: T0 + 4 }).task.status).toBe(
      'done',
    );
    const rej = transition(acc.task, acc.attempt, {
      type: 'reject',
      at: T0 + 4,
      feedback: '改一下',
    });
    expect(rej.task.status).toBe('queued');
    expect(rej.task.pending).toEqual({ cause: 'rework', note: '改一下' });
    expect(rej.attempt?.status).toBe('rejected');
  });

  it('执行中再触发 → busy（运行时决定跳过或合并）', () => {
    const { last } = run(mkTask(), [trig(), slot()]);
    const r = transition(last.task, last.attempt, trig(T0 + 5));
    expect(r).toMatchObject({ ok: false, reason: 'busy' });
  });

  it('暂停的任务不触发；暂停时排队的回到 idle；运行中的不受影响', () => {
    const paused = mkTask({ enabled: false });
    expect(transition(paused, null, trig())).toMatchObject({ ok: false, reason: 'paused' });

    const q = run(mkTask(), [trig(), { type: 'pause', at: T0 + 2 }]).last;
    expect(q.task).toMatchObject({ status: 'idle', enabled: false });
    expect(q.task.pending).toBeUndefined();

    const r = run(mkTask(), [trig(), slot(), { type: 'pause', at: T0 + 3 }]).last;
    expect(r.task).toMatchObject({ status: 'running', enabled: false });
  });

  describe('等人（references §2.1）', () => {
    const toWaiting = () =>
      run(mkTask(), [
        trig(),
        slot(),
        {
          type: 'needs_user',
          at: T0 + 3,
          gen: 1,
          wait: { kind: 'approval', requestId: 'r1', detail: 'rm -rf build' },
        },
      ]).last;

    it('停下来等人立即释放名额', () => {
      const w = toWaiting();
      expect(w.task.status).toBe('waiting_user');
      expect(w.task.wait).toEqual({
        kind: 'approval',
        requestId: 'r1',
        detail: 'rm -rf build',
        resumeTo: 'running',
      });
      expect(w.effects[0]).toEqual({ kind: 'release_slot', gen: 1 });
    });

    it('回应后用人工名额原地继续', () => {
      const w = toWaiting();
      const r = transition(w.task, w.attempt, {
        type: 'decide',
        at: T0 + 4,
        gen: 1,
        requestId: 'r1',
        approve: true,
      });
      expect(r.task.status).toBe('running');
      expect(r.effects).toEqual([
        { kind: 'acquire_slot', gen: 1, reserved: true },
        { kind: 'resume_attempt', gen: 1, requestId: 'r1', approve: true },
      ]);
      expect(r.attempt?.status).toBe('running');
    });

    it('requestId 或代次对不上的回应作废', () => {
      const w = toWaiting();
      expect(
        transition(w.task, w.attempt, {
          type: 'decide',
          at: T0 + 4,
          requestId: 'rX',
          approve: true,
        }),
      ).toMatchObject({ ok: false, reason: 'stale' });
      expect(
        transition(w.task, w.attempt, {
          type: 'decide',
          at: T0 + 4,
          gen: 0,
          requestId: 'r1',
          approve: true,
        }),
      ).toMatchObject({ ok: false, reason: 'stale' });
    });

    it('等人时取消不再释放名额（已释放过）', () => {
      const w = toWaiting();
      const r = transition(w.task, w.attempt, { type: 'cancel', at: T0 + 4 });
      expect(r.task.status).toBe('cancelled');
      expect(r.effects).toEqual([{ kind: 'stop_attempt', gen: 1, reason: 'cancel' }]);
    });

    it('拒绝继续花预算：停执行、一次性任务失败、不计连续失败', () => {
      const w = run(mkTask(), [
        trig(),
        slot(),
        { type: 'needs_user', at: T0 + 3, gen: 1, wait: { kind: 'budget' } },
      ]).last;
      const r = transition(w.task, w.attempt, { type: 'decide', at: T0 + 4, approve: false });
      expect(r.task).toMatchObject({ status: 'failed', lastError: { code: 'budget_denied' } });
      expect(r.task.consecutiveFailures).toBe(0);
      expect(r.attempt?.status).toBe('cancelled');
      expect(kinds(r)).toEqual(['stop_attempt', 'deliver']);
    });

    it('触发时每日预算已用完：等人，批准后排队', () => {
      const w = transition(mkTask(), null, {
        type: 'trigger',
        at: T0 + 1,
        cause: 'manual',
        budgetExceeded: true,
      });
      expect(w.task.wait).toEqual({ kind: 'budget', resumeTo: 'queued' });
      const r = transition(w.task, w.attempt, { type: 'decide', at: T0 + 2, approve: true });
      expect(r.task.status).toBe('queued');
      expect(r.task.pending).toEqual({ cause: 'manual' });
    });
  });

  describe('重试与失败（references §2.3、§2.4）', () => {
    const fail = (gen: number, at: number, code = 'network'): TaskEvent => ({
      type: 'failed',
      at,
      gen,
      error: { code, message: code },
    });

    it('瞬时错误最多重试 3 次，退避 2s/4s/8s', () => {
      let r = run(mkTask(), [trig(), slot()]).last;
      const notBefores: number[] = [];
      for (let i = 1; i <= 3; i++) {
        r = transition(r.task, r.attempt, fail(i, T0 + 10 * i));
        expect(r.task.status).toBe('queued');
        notBefores.push(r.task.pending!.notBefore! - (T0 + 10 * i));
        expect(
          transition(r.task, r.attempt, slot(r.task.pending!.notBefore! - 1, `att_${i + 1}`)),
        ).toMatchObject({ ok: false, reason: 'not_ready' });
        r = transition(r.task, r.attempt, slot(r.task.pending!.notBefore!, `att_${i + 1}`));
      }
      expect(notBefores).toEqual([2000, 4000, 8000]);
      r = transition(r.task, r.attempt, fail(4, T0 + 100));
      expect(r.task.status).toBe('failed');
    });

    it('不可重试的错误直接失败；未知错误码按不可重试', () => {
      const r = run(mkTask(), [trig(), slot(), fail(1, T0 + 3, 'timed_out')]).last;
      expect(r.task.status).toBe('failed');
      const u = run(mkTask(), [trig(), slot(), fail(1, T0 + 3, 'whatever')]).last;
      expect(u.task.status).toBe('failed');
    });

    it('退避封顶 60 秒', () => {
      expect([1, 2, 3, 4, 5, 6, 7, 10].map(retryBackoffMs)).toEqual([
        2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
      ]);
    });

    it('重复任务连续失败 3 次自动暂停；成功一次清零', () => {
      let t = mkTask({ ...daily, budget: { maxRetries: 0 } });
      let a: Attempt | null = null;
      for (let i = 1; i <= 2; i++) {
        const r = run(t, [
          { type: 'trigger', at: T0 + i * 10, cause: 'schedule' },
          slot(T0 + i * 10 + 1, `att_${i}`),
          fail(i, T0 + i * 10 + 2, 'executor_failed'),
        ]).last;
        t = r.task;
        a = r.attempt;
        expect(t).toMatchObject({ status: 'idle', enabled: true, consecutiveFailures: i });
      }
      const third = run(
        t,
        [
          { type: 'trigger', at: T0 + 30, cause: 'schedule' },
          slot(T0 + 31, 'att_3'),
          fail(3, T0 + 32, 'executor_failed'),
        ],
        a,
      ).last;
      expect(third.task).toMatchObject({ status: 'idle', enabled: false, consecutiveFailures: 3 });
      expect(third.effects).toContainEqual({ kind: 'deliver', what: 'auto_paused' });
      expect(kinds(third)).not.toContain('schedule_next');

      const resumed = transition(third.task, third.attempt, { type: 'resume', at: T0 + 40 });
      expect(resumed.task).toMatchObject({ enabled: true, consecutiveFailures: 0 });

      const ok = run(mkTask({ ...daily, consecutiveFailures: 2 }), [
        { type: 'trigger', at: T0 + 1, cause: 'schedule' },
        slot(),
        { type: 'completed', at: T0 + 3, gen: 1, result: { summary: '', artifacts: [] } },
      ]).last;
      expect(ok.task.consecutiveFailures).toBe(0);
    });
  });

  it('事件触发的执行重试 / 重启续跑：新的执行沿用原事件批（#240）', () => {
    const evTrig: TaskEvent = { type: 'trigger', at: T0 + 1, cause: 'event', eventKey: 'evt:1' };
    const err = { code: 'network', message: 'x' };
    const r1 = run(mkTask(), [
      evTrig,
      slot(),
      { type: 'failed', at: T0 + 3, gen: 1, error: err },
      slot(T0 + 3 + retryBackoffMs(1), 'att_2'),
    ]).last;
    expect(r1.attempt!.cause).toMatchObject({ kind: 'retry', eventKey: 'evt:1' });
    const r2 = run(
      r1.task,
      [
        { type: 'restarted', at: T0 + 10_000, unconfirmedExternal: false },
        slot(T0 + 10_001, 'att_3'),
      ],
      r1.attempt,
    ).last;
    expect(r2.attempt!.cause).toMatchObject({ kind: 'resume', eventKey: 'evt:1' });
    // 重试 / 续跑仍带着那批外部内容：审批照样按外部内容来（#250）
    expect(fromExternalEvent(r1.attempt!.cause)).toBe(true);
    expect(fromExternalEvent(r2.attempt!.cause)).toBe(true);
    // 新的一次手动触发不串批
    const r3 = run(mkTask(), [trig(), slot()]).last;
    expect(r3.attempt!.cause.eventKey).toBeUndefined();
    expect(fromExternalEvent(r3.attempt!.cause)).toBe(false);
  });

  describe('代次与晚到结果（§5.3）', () => {
    it('取消后晚到的完成作废，不复活任务', () => {
      const r = run(mkTask(), [trig(), slot(), { type: 'cancel', at: T0 + 3 }]).last;
      expect(r.task).toMatchObject({ status: 'cancelled', gen: 2 });
      expect(r.effects).toEqual([
        { kind: 'stop_attempt', gen: 1, reason: 'cancel' },
        { kind: 'release_slot', gen: 1 },
      ]);
      const late = transition(r.task, r.attempt, {
        type: 'completed',
        at: T0 + 4,
        gen: 1,
        result: { summary: 'late', artifacts: [] },
      });
      expect(late).toMatchObject({ ok: false, reason: 'stale' });
      expect(late.effects).toEqual([{ kind: 'drop_stale', gen: 1, event: 'completed' }]);
      expect(late.task.status).toBe('cancelled');
    });

    it('取消后才到的审批回应作废（2.7）', () => {
      const w = run(mkTask(), [
        trig(),
        slot(),
        { type: 'needs_user', at: T0 + 3, gen: 1, wait: { kind: 'approval', requestId: 'r1' } },
      ]).last;
      const c = transition(w.task, w.attempt, { type: 'cancel', at: T0 + 4 });
      const late = transition(c.task, c.attempt, {
        type: 'decide',
        at: T0 + 5,
        gen: 1,
        requestId: 'r1',
        approve: true,
      });
      expect(late.ok).toBe(false);
      expect(late.task.status).toBe('cancelled');
    });

    it('配置变了：等用户；放弃后晚到的完成作废', () => {
      const f = run(mkTask(), [
        trig(),
        slot(),
        { type: 'failed', at: T0 + 3, gen: 1, error: { code: 'config_changed', message: 'm' } },
      ]).last;
      expect(f.task).toMatchObject({
        status: 'waiting_user',
        gen: 2,
        wait: { kind: 'config', resumeTo: 'queued' },
      });
      expect(kinds(f)).toContain('deliver');
      const late = transition(f.task, f.attempt, {
        type: 'completed',
        at: T0 + 4,
        gen: 1,
        result: { summary: 'late', artifacts: [] },
      });
      expect(late.ok).toBe(false);
      const retry = transition(f.task, f.attempt, { type: 'decide', at: T0 + 5, approve: true });
      expect(retry.task.status).toBe('queued');
    });

    it('接管：代次前进，旧标签的结果作废；用户确认做完 → 完成，交回 → 续跑', () => {
      const r = run(mkTask(), [trig(), slot(), { type: 'taken_over', at: T0 + 3, gen: 1 }]).last;
      expect(r.task).toMatchObject({ status: 'waiting_user', gen: 2 });
      expect(r.task.wait).toEqual({ kind: 'taken_over', resumeTo: 'idle' });
      expect(r.attempt?.status).toBe('taken_over');
      expect(
        transition(r.task, r.attempt, {
          type: 'completed',
          at: T0 + 4,
          gen: 1,
          result: { summary: '', artifacts: [] },
        }).reason,
      ).toBe('stale');
      expect(
        transition(r.task, r.attempt, { type: 'decide', at: T0 + 5, approve: true }).task.status,
      ).toBe('done');
      const back = transition(r.task, r.attempt, {
        type: 'decide',
        at: T0 + 5,
        approve: false,
        input: '你接着做',
      });
      expect(back.task.pending).toEqual({ cause: 'resume', note: '你接着做' });
    });
  });

  describe('重启（§10.3；references §2.5）', () => {
    it('运行中、没有未确认的对外动作 → 中断并重新排队', () => {
      const r = run(mkTask(), [
        trig(),
        slot(),
        { type: 'restarted', at: T0 + 10, unconfirmedExternal: false },
      ]).last;
      expect(r.task).toMatchObject({ status: 'queued', gen: 2, pending: { cause: 'resume' } });
      expect(r.attempt?.status).toBe('interrupted');
    });

    it('有 intent 没 done → needs_reconcile；核对后续跑或放弃', () => {
      const r = run(mkTask(), [
        trig(),
        slot(),
        { type: 'restarted', at: T0 + 10, unconfirmedExternal: true },
      ]).last;
      expect(r.task.status).toBe('needs_reconcile');
      expect(r.effects).toEqual([{ kind: 'deliver', what: 'reconcile', attemptId: 'att_1' }]);
      const ok = transition(r.task, r.attempt, {
        type: 'reconcile',
        at: T0 + 11,
        outcome: 'applied',
      });
      expect(ok.task.pending).toEqual({ cause: 'resume', note: 'reconciled:applied' });
      const ab = transition(r.task, r.attempt, {
        type: 'reconcile',
        at: T0 + 11,
        outcome: 'abandon',
      });
      expect(ab.task).toMatchObject({
        status: 'failed',
        lastError: { code: 'reconcile_abandoned' },
      });
    });

    it('等人的保持原样，回答带进续跑的执行', () => {
      const w = run(mkTask(), [
        trig(),
        slot(),
        { type: 'needs_user', at: T0 + 3, gen: 1, wait: { kind: 'input', requestId: 'q1' } },
        { type: 'restarted', at: T0 + 10, unconfirmedExternal: false },
      ]).last;
      expect(w.task).toMatchObject({ status: 'waiting_user', gen: 2 });
      expect(w.task.wait).toEqual({ kind: 'input', requestId: 'q1', resumeTo: 'queued' });
      expect(w.effects).toEqual([]);
      expect(w.attempt?.status).toBe('interrupted');

      const r = transition(w.task, w.attempt, {
        type: 'decide',
        at: T0 + 11,
        requestId: 'q1',
        approve: true,
        input: '用 main 分支',
      });
      expect(r.task.status).toBe('queued');
      expect(r.task.pending).toEqual({
        cause: 'resume',
        answer: { requestId: 'q1', approve: true, input: '用 main 分支' },
      });
      // 回答随新执行持久化，不会因 pending 清空而丢
      const s = transition(r.task, r.attempt, slot(T0 + 12, 'att_2'));
      expect(s.attempt?.cause).toEqual({
        kind: 'resume',
        answer: { requestId: 'q1', approve: true, input: '用 main 分支' },
      });
    });

    it('其他状态不动；排队中的重新登记', () => {
      const q = run(mkTask(), [
        trig(),
        { type: 'restarted', at: T0 + 10, unconfirmedExternal: false },
      ]).last;
      expect(q.task.status).toBe('queued');
      expect(q.effects).toEqual([{ kind: 'enqueue' }]);
      const idle = transition(mkTask(), null, {
        type: 'restarted',
        at: T0,
        unconfirmedExternal: false,
      });
      expect(idle).toMatchObject({ ok: true, effects: [] });
    });
  });

  describe('授权（§8）', () => {
    it('撤销：停执行，等重新授权；重新授权后从头排队', () => {
      const r = run(mkTask(), [trig(), slot(), { type: 'grant_revoked', at: T0 + 3 }]).last;
      expect(r.task).toMatchObject({ status: 'waiting_user', gen: 2 });
      expect(r.task.wait).toEqual({ kind: 'grant', resumeTo: 'queued' });
      expect(r.task.grant.revokedAt).toBe(T0 + 3);
      expect(kinds(r)).toEqual(['stop_attempt', 'release_slot', 'deliver']);
      expect(
        transition(r.task, r.attempt, { type: 'decide', at: T0 + 4, approve: true }).reason,
      ).toBe('illegal');

      const g2 = { version: 2, level: 1 as const, paths: [], connections: [], grantedAt: T0 + 5 };
      const re = transition(r.task, r.attempt, { type: 'grant_updated', at: T0 + 5, grant: g2 });
      expect(re.task).toMatchObject({ status: 'queued', grant: g2 });
    });

    it('已撤销的授权不能触发；版本不前进的更新拒绝', () => {
      const t = mkTask({ grant: { ...mkTask().grant, revokedAt: T0 } });
      expect(transition(t, null, trig()).reason).toBe('grant');
      expect(
        transition(mkTask(), null, { type: 'grant_updated', at: T0, grant: mkTask().grant }).reason,
      ).toBe('illegal');
    });

    it('到期：触发时或运行中都进 expired；续期回到 idle', () => {
      const t = mkTask({ ...daily, grant: { ...mkTask().grant, expiresAt: T0 + 1 } });
      const r = transition(t, null, { type: 'trigger', at: T0 + 1, cause: 'schedule' });
      expect(r.task.status).toBe('expired');

      const running = run(mkTask(), [trig(), slot(), { type: 'grant_expired', at: T0 + 3 }]).last;
      expect(running.task).toMatchObject({ status: 'expired', gen: 2 });
      expect(kinds(running)).toEqual(['stop_attempt', 'release_slot', 'deliver']);

      const g2 = { version: 2, level: 1 as const, paths: [], connections: [], grantedAt: T0 + 5 };
      const renewed = transition(r.task, r.attempt, {
        type: 'grant_updated',
        at: T0 + 5,
        grant: g2,
      });
      expect(renewed.task.status).toBe('idle');
      expect(kinds(renewed)).toEqual(['schedule_next']);
    });

    it('待验收时撤销，重新授权后回到待验收', () => {
      const acc = run(mkTask({ acceptance: 'user' }), [
        trig(),
        slot(),
        { type: 'completed', at: T0 + 3, gen: 1, result: { summary: '', artifacts: [] } },
        { type: 'grant_revoked', at: T0 + 4 },
      ]).last;
      expect(acc.task.wait).toEqual({ kind: 'grant', resumeTo: 'awaiting_accept' });
      const g2 = { version: 2, level: 1 as const, paths: [], connections: [], grantedAt: T0 + 5 };
      expect(
        transition(acc.task, acc.attempt, { type: 'grant_updated', at: T0 + 5, grant: g2 }).task
          .status,
      ).toBe('awaiting_accept');
    });
  });

  it('结束态不再接受事件', () => {
    const done = run(mkTask(), [
      trig(),
      slot(),
      { type: 'completed', at: T0 + 3, gen: 1, result: { summary: '', artifacts: [] } },
    ]).last;
    expect(transition(done.task, done.attempt, { type: 'cancel', at: T0 + 4 }).reason).toBe(
      'terminal',
    );
    expect(transition(done.task, done.attempt, { type: 'grant_revoked', at: T0 + 4 }).reason).toBe(
      'terminal',
    );
    // 一次性任务完成后仍可手动再跑
    expect(transition(done.task, done.attempt, trig(T0 + 5)).task.status).toBe('queued');
  });
});
