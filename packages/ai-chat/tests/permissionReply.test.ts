// 后台委派的审批：任务已经结束 / 请求已失效时，点「允许」也必须真的答掉标签里的请求，
// 否则卡片挂在那儿谁也点不动，只能等 7 天超时（用户报过）。
import { describe, expect, it, vi } from 'vitest';

import { replyPermissionRequest, type PermissionReplyDeps } from '../src/services/permissionReply';

function deps(over: Partial<PermissionReplyDeps> = {}): PermissionReplyDeps {
  return {
    decide: vi.fn(async () => ({ ok: true })),
    reply: vi.fn(async () => true),
    replyApprovePlan: vi.fn(async () => true),
    ...over,
  };
}

describe('replyPermissionRequest', () => {
  it('任务回应成功：只走任务，不再重复回标签', async () => {
    const d = deps();
    expect(await replyPermissionRequest('tab_1', 'p1', true, { taskId: 'task_1' }, d)).toBe(true);
    expect(d.decide).toHaveBeenCalledWith({ id: 'task_1', requestId: 'p1', approve: true });
    expect(d.reply).not.toHaveBeenCalled();
  });

  it('任务已结束（ok:false / illegal）：退回直接回标签', async () => {
    const d = deps({ decide: vi.fn(async () => ({ ok: false, reason: 'illegal' })) });
    expect(await replyPermissionRequest('tab_1', 'p1', true, { taskId: 'task_1' }, d)).toBe(true);
    expect(d.reply).toHaveBeenCalledWith('tab_1', 'p1', true);
  });

  it('任务回应抛错（任务不在了 / 被接管）：同样退回标签', async () => {
    const d = deps({
      decide: vi.fn(async () => {
        throw new Error('unknown task');
      }),
    });
    expect(await replyPermissionRequest('tab_1', 'p1', false, { taskId: 'task_1' }, d)).toBe(true);
    expect(d.reply).toHaveBeenCalledWith('tab_1', 'p1', false);
  });

  it('{ ok, data: { ok:false } } 包装也能识别为没成功', async () => {
    const d = deps({
      decide: vi.fn(async () => ({ ok: true, data: { ok: false, reason: 'stale' } })),
    });
    expect(await replyPermissionRequest('tab_1', 'p1', true, { taskId: 'task_1' }, d)).toBe(true);
    expect(d.reply).toHaveBeenCalled();
  });

  it('没有任务（普通委派）：直接回标签', async () => {
    const d = deps();
    expect(await replyPermissionRequest('tab_1', 'p1', true, {}, d)).toBe(true);
    expect(d.decide).not.toHaveBeenCalled();
    expect(d.reply).toHaveBeenCalledWith('tab_1', 'p1', true);
  });

  it('计划批准卡只走标签的 replyApprovePlan', async () => {
    const d = deps();
    await replyPermissionRequest(
      'tab_1',
      'p1',
      true,
      { taskId: 'task_1', approvePlan: 'acceptEdits' },
      d,
    );
    expect(d.decide).not.toHaveBeenCalled();
    expect(d.replyApprovePlan).toHaveBeenCalledWith('tab_1', 'p1', 'acceptEdits');
  });

  it('两条路都不通：返回 false（调用方把卡片收掉，不留死按钮）', async () => {
    const d = deps({
      decide: vi.fn(async () => ({ ok: false })),
      reply: vi.fn(async () => false),
    });
    expect(await replyPermissionRequest('tab_1', 'p1', true, { taskId: 'task_1' }, d)).toBe(false);
  });
});

it('preserves transport errors so callers can offer a retry', async () => {
  const failure = new Error('connection temporarily unavailable');
  const d = deps({
    reply: vi.fn(async () => {
      throw failure;
    }),
  });
  await expect(replyPermissionRequest('tab_1', 'p1', true, {}, d)).rejects.toBe(failure);
});
