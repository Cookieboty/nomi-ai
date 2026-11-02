import { applyDispatchHint, DISPATCH_HINT } from '../../../src/cli/delegate/intentHint';

describe('applyDispatchHint（persistent-tasks §7.4）', () => {
  it('用户对话：追加到已有系统提示后面；没有系统提示时插到最前', () => {
    const a = {
      messages: [
        { role: 'system', content: '人设' },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(applyDispatchHint(a)).toBe(true);
    expect(a.messages[0]!.content).toBe(`人设\n\n${DISPATCH_HINT}`);
    const b = { messages: [{ role: 'user', content: 'hi' }] };
    applyDispatchHint(b);
    expect(b.messages[0]).toEqual({ role: 'system', content: DISPATCH_HINT });
  });

  it('后台任务的执行、编程助手标签里的调用不加', () => {
    for (const extra of [{ taskId: 't1' }, { callerTabId: 'tab' }]) {
      const o = { extra, messages: [{ role: 'system', content: 's' }] };
      expect(applyDispatchHint(o)).toBe(false);
      expect(o.messages[0]!.content).toBe('s');
    }
  });

  it('规则覆盖：直接做 / 派给 Nomi / 编程助手 / 持续任务 / 提醒', () => {
    for (const k of ['delegate_to_nomi', 'delegate_to_cli', 'task_propose', 'reminder_create'])
      expect(DISPATCH_HINT).toContain(k);
  });
});
