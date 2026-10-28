/**
 * E2 · chat-only profile · headless smoke
 *
 * 语义对齐：
 * - 一个 ai-chat 渲染窗口通过 `ClientAIClient.chat.sendMessage(...)` 发消息；
 * - 主进程契约过程 `ai.chat.sendMessage` 委派到 chat facade，调用 FakeLLM 拿到响应；
 * - 触发 插件事件 `tools/post-execute` → 广播为 `tool:executed` 到该窗口；
 * - `client.tools.list()` 能列出预注册的 `echo` 工具。
 */

import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { createE2eRuntime, type E2eRuntimeHandle } from '../helpers/e2eRuntime';
import { createEchoTool } from '../helpers/fakeSeams';

describe('E2 · chat-only · sendMessage + tool:executed', () => {
  let handle: E2eRuntimeHandle;

  beforeEach(() => {
    handle = createE2eRuntime({ tools: [createEchoTool()], llmId: 'fake' });
  });

  afterEach(() => {
    handle.dispose();
  });

  it('chat.sendMessage 通过 IPC 回到主进程 FakeLLM，返回文本内容', async () => {
    const chatWin = handle.createRendererClient({ id: 610 });
    const client = new ClientAIClient({ bridge: chatWin.bridge });

    handle.llm.nextContent = 'hello from fake llm';

    const res = (await (
      client.chat as unknown as {
        sendMessage(opts: {
          provider: string;
          model: string;
          messages: Array<{ role: string; content: string }>;
        }): Promise<{ content: string; provider: string }>;
      }
    ).sendMessage({
      provider: 'fake',
      model: 'default',
      messages: [{ role: 'user', content: '你好' }],
    })) as { content: string; provider: string };

    expect(res.content).toBe('hello from fake llm');
    expect(res.provider).toBe('fake');
    expect(handle.llm.chatCalls).toHaveLength(1);
    expect(handle.llm.chatCalls[0]?.messages[0]?.content).toBe('你好');

    await client.dispose();
  });

  it('client.tools.list() 列出预注册工具（echo）', async () => {
    const chatWin = handle.createRendererClient({ id: 611 });
    const client = new ClientAIClient({ bridge: chatWin.bridge });

    const list = (await (
      client.tools as unknown as {
        list(): Promise<Array<{ name: string; dangerous?: boolean }>>;
      }
    ).list()) as Array<{ name: string; dangerous?: boolean }>;

    expect(list.map((t) => t.name)).toContain('echo');
    const echo = list.find((t) => t.name === 'echo');
    expect(echo?.dangerous).toBe(false);

    await client.dispose();
  });

  it('触发 插件宿主 tools/post-execute → 渲染窗口 client.on("tool:executed") 收到广播', async () => {
    const chatWin = handle.createRendererClient({ id: 612 });
    const client = new ClientAIClient({ bridge: chatWin.bridge });

    const received: Array<{ toolName: string; ok: boolean }> = [];
    client.on('tool:executed', (payload) => {
      received.push(payload as { toolName: string; ok: boolean });
    });
    await handle.settle(); // 订阅帧到达内核

    await handle.ctx.triggerEvent('tools/post-execute', {
      toolName: 'echo',
      reqId: 'req-tool-1',
      ok: true,
      durationMs: 5,
    });
    await handle.settle(); // 事件帧到达窗口

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ toolName: 'echo', ok: true });

    await client.dispose();
  });
});
