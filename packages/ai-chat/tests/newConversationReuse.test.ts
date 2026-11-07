/** 新建 Nomi 对话：这个工作区已经有还没说话的空对话时切过去，不再新建 */
import { describe, expect, it } from 'vitest';

import { SdkIPCClient } from '../src/services/IPCClient';

describe('IPCClient.newConversation', () => {
  it('复用同一工作区的空对话；有消息后再新建才真的新建', async () => {
    const ipc = new SdkIPCClient({ dispose: () => undefined } as never, {
      defaultSystemPrompt: async () => undefined,
    });
    const store = ipc.conversationStore();
    const a = await ipc.newConversation(undefined, { cwd: '/w/app' });
    const again = await ipc.newConversation(undefined, { cwd: '/w/app' });
    expect(again).toBe(a);
    expect(store.list().filter((c) => c.cwd === '/w/app')).toHaveLength(1);
    // 别的工作区照常新建
    const other = await ipc.newConversation(undefined, { cwd: '/w/other' });
    expect(other).not.toBe(a);
    expect(ipc.currentConversationId()).toBe(other);
    // 回到 app 的空对话（当前会话跟着切过去）
    expect(await ipc.newConversation(undefined, { cwd: '/w/app' })).toBe(a);
    expect(ipc.currentConversationId()).toBe(a);
    store.append({ id: 'm', role: 'user', content: 'hi', timestamp: 1 } as never, a);
    expect(await ipc.newConversation(undefined, { cwd: '/w/app' })).not.toBe(a);
  });

  it('正在后台回复（首轮还没落盘）的会话都不复用，只排除当前会话不够（#276）', async () => {
    const ipc = new SdkIPCClient({ dispose: () => undefined } as never, {
      defaultSystemPrompt: async () => undefined,
    });
    const store = ipc.conversationStore();
    // A 首轮生成中（存储里零消息），用户切到已有历史的 B 后新建
    const a = await ipc.newConversation(undefined, { cwd: '/w/app' });
    const b = store.create({ cwd: '/w/app' }).id;
    store.append({ id: 'm', role: 'user', content: 'hi', timestamp: 1 } as never, b);
    const c = await ipc.newConversation(undefined, { cwd: '/w/app', notReuse: [b, a] });
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
    expect(ipc.currentConversationId()).toBe(c);
    // 真正空闲的空对话照常复用
    expect(await ipc.newConversation(undefined, { cwd: '/w/app', notReuse: [a] })).toBe(c);
  });
});
