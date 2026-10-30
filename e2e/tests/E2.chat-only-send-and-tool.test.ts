/**
 * E2 · chat-only profile · headless smoke
 *
 * 语义对齐：
 * - 真实内核跑在无界面宿主上，对话窗口经 in-process 传输用 `ClientAIClient.chat.sendMessage(...)` 发消息；
 * - 内核的契约过程 `ai.chat.sendMessage` 委派到 chat facade，经内核的外发检查后调用 FakeLLM 拿到响应；
 * - 插件事件 `tools/post-execute` → 推给订阅了的窗口（`tool:executed`）；
 * - `client.tools.list()` 列出内核内置的 `echo` 工具。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

interface ChatApi {
  sendMessage(opts: {
    provider: string;
    model: string;
    messages: Array<{ role: string; content: string }>;
  }): Promise<{ content: string; provider: string }>;
}

interface ToolsApi {
  list(): Promise<Array<{ name: string; dangerous?: boolean }>>;
}

describe('E2 · chat-only · sendMessage + tool:executed', () => {
  let core: E2eCore;

  beforeEach(async () => {
    core = await startE2eCore({ llmId: 'fake' });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('chat.sendMessage 经契约回到内核的 FakeLLM，返回文本内容', async () => {
    const { client } = core.openWindow();
    core.llm.nextContent = 'hello from fake llm';

    const res = await (client.chat as unknown as ChatApi).sendMessage({
      provider: 'fake',
      model: 'default',
      messages: [{ role: 'user', content: '你好' }],
    });

    expect(res.content).toBe('hello from fake llm');
    expect(res.provider).toBe('fake');
    expect(core.llm.chatCalls).toHaveLength(1);
    expect(core.llm.chatCalls[0]?.messages.at(-1)?.content).toBe('你好');
  });

  it('client.tools.list() 列出内核内置的工具（echo）', async () => {
    const { client } = core.openWindow();
    const list = await (client.tools as unknown as ToolsApi).list();

    expect(list.map((t) => t.name)).toContain('echo');
    const echo = list.find((t) => t.name === 'echo');
    expect(echo?.dangerous).toBeFalsy();
  });

  it('插件事件 tools/post-execute → 窗口 client.on("tool:executed") 收到', async () => {
    const { client } = core.openWindow();
    const received: Array<{ toolName: string; ok: boolean }> = [];
    client.on('tool:executed', (payload) => {
      received.push(payload as { toolName: string; ok: boolean });
    });
    await core.settle(); // 订阅帧到达内核

    await core.emit('tools/post-execute', {
      toolName: 'echo',
      reqId: 'req-tool-1',
      ok: true,
      durationMs: 5,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ toolName: 'echo', ok: true });
  });
});
