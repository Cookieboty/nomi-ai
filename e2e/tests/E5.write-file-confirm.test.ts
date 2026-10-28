/**
 * E5 · 危险工具 `write_file` 确认弹窗（headless / 拒绝路径自动化）
 *
 * 语义对齐：
 * - 场景：chat-only profile，Agent 触发 `write_file` 时应弹出确认；
 *   本 headless 用例只跑**拒绝路径自动化**（同意路径涉及真实 fs / dialog，
 *   见 .github/RELEASE_TEMPLATE.md 的手工验收项）；
 * - 断言（拒绝前）：`tools/pre-execute` 被 插件宿主 拒绝、`write_file.execute` 未被调用；
 * - 断言（弹窗）：AIClient 侧收到 `tool:confirm-required` 事件；
 * - 断言（拒绝后）：`tools/post-execute { ok: false, code: 'E_TOOL_DENIED' }` 广播到渲染窗口的 `tool:executed`。
 *
 * 与 E2 的差异：E2 走"echo（非危险）+ 手动 emit tools/post-execute"，
 * 本用例接入 GuardrailsPlugin 的 headless 等价物 `installDangerToolGuardrail`，
 * 覆盖"pre-execute → confirm-required → reject → 拒绝路径 post-execute"完整链路。
 */

import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';

import { createE2eRuntime, type E2eRuntimeHandle } from '../helpers/e2eRuntime';
import { createWriteFileTool, installDangerToolGuardrail } from '../helpers/fakeSeams';

describe('E5 · chat-only · write_file 危险工具拒绝路径', () => {
  let handle: E2eRuntimeHandle;
  let writeFile: ReturnType<typeof createWriteFileTool>;

  beforeEach(() => {
    writeFile = createWriteFileTool();
    handle = createE2eRuntime({ tools: [writeFile], llmId: 'fake' });
    installDangerToolGuardrail(handle.ctx, ['write_file']);
  });

  afterEach(() => {
    handle.dispose();
  });

  it('client.tools.list() 应显示 write_file dangerous=true', async () => {
    const win = handle.createRendererClient({ id: 710 });
    const client = new ClientAIClient({ bridge: win.bridge });

    const list = (await (
      client.tools as unknown as {
        list(): Promise<Array<{ name: string; dangerous?: boolean }>>;
      }
    ).list()) as Array<{ name: string; dangerous?: boolean }>;

    const wf = list.find((t) => t.name === 'write_file');
    expect(wf?.dangerous).toBe(true);

    await client.dispose();
  });

  it('未确认时 tools/pre-execute 被 插件宿主 拒绝，且 write_file.execute 不会被调用', async () => {
    let rejected: { reason: string; code?: string } | undefined;
    try {
      await handle.ctx.triggerEvent('tools/pre-execute', {
        tool: 'write_file',
        args: { path: '/tmp/e5.txt', content: 'hello' },
        reqId: 'req-e5-1',
        confirmed: false,
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      rejected = { reason: e.message, code: e.code };
    }

    expect(rejected?.code).toBe('E_TOOL_DENIED');
    expect(rejected?.reason).toContain('danger tool requires user confirm');
    expect(writeFile.executions).toHaveLength(0);
  });

  it('触发 pre-execute 时 AIClient 侧收到 tool:confirm-required（承载 tool + args + reqId）', async () => {
    const win = handle.createRendererClient({ id: 711 });
    const client = new ClientAIClient({ bridge: win.bridge });

    const confirmEvents: Array<{ tool?: string; reqId?: string; args?: unknown }> = [];
    client.on('tool:confirm-required', (payload) => {
      confirmEvents.push(payload as { tool?: string; reqId?: string; args?: unknown });
    });
    await handle.settle(); // 订阅帧到达内核

    try {
      await handle.ctx.triggerEvent('tools/pre-execute', {
        tool: 'write_file',
        args: { path: '/tmp/e5.txt', content: 'hello' },
        reqId: 'req-e5-confirm',
        confirmed: false,
      });
    } catch {
      /* 期望 reject */
    }
    await handle.settle(); // 事件帧到达窗口

    expect(confirmEvents).toHaveLength(1);
    expect(confirmEvents[0]).toMatchObject({
      tool: 'write_file',
      reqId: 'req-e5-confirm',
      args: { path: '/tmp/e5.txt', content: 'hello' },
    });

    await client.dispose();
  });

  it('拒绝路径下 tools/post-execute { ok:false, code:"E_TOOL_DENIED" } 广播为 tool:executed', async () => {
    const win = handle.createRendererClient({ id: 712 });
    const client = new ClientAIClient({ bridge: win.bridge });

    const executed: Array<{ toolName?: string; ok?: boolean; code?: string }> = [];
    client.on('tool:executed', (payload) => {
      executed.push(payload as { toolName?: string; ok?: boolean; code?: string });
    });
    await handle.settle();

    // 拒绝路径：Agent/主进程编排在 catch 后应显式广播一次"用户拒绝"的 post-execute
    await handle.ctx.triggerEvent('tools/post-execute', {
      toolName: 'write_file',
      reqId: 'req-e5-denied',
      ok: false,
      code: 'E_TOOL_DENIED',
      durationMs: 0,
    });
    await handle.settle();

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({
      toolName: 'write_file',
      ok: false,
      code: 'E_TOOL_DENIED',
    });
    expect(writeFile.executions).toHaveLength(0);

    await client.dispose();
  });
});
