/**
 * E5 · 危险工具 `write_file` 确认（headless / 拒绝路径自动化）
 *
 * 语义对齐：
 * - 真实内核跑在无界面宿主上；测试工具 `write_file`（dangerous）注册进内核插件宿主真实的工具表，
 *   GuardrailsPlugin 的危险工具分支（`installDangerToolGuardrail`）装在同一个插件宿主里；
 * - 断言（拒绝前）：`tools/pre-execute` 被拒绝（`E_TOOL_DENIED`）、`write_file.execute` 未被调用；
 * - 断言（确认请求）：订阅了的窗口收到 `tool:confirm-required`；
 * - 断言（拒绝后）：`tools/post-execute { ok: false, code: 'E_TOOL_DENIED' }` 推给窗口的 `tool:executed`。
 *
 * 同意路径涉及真实 fs / 系统对话框，见 .github/RELEASE_TEMPLATE.md 的手工验收项。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWriteFileTool } from '../helpers/fakeSeams';
import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

describe('E5 · chat-only · write_file 危险工具拒绝路径', () => {
  let core: E2eCore;
  let writeFile: ReturnType<typeof createWriteFileTool>;

  beforeEach(async () => {
    writeFile = createWriteFileTool();
    core = await startE2eCore({ tools: [writeFile], dangerTools: ['write_file'] });
  });

  afterEach(async () => {
    await core.stop();
  });

  it('client.tools.list() 显示 write_file dangerous=true', async () => {
    const { client } = core.openWindow();
    const list = await (
      client.tools as unknown as { list(): Promise<Array<{ name: string; dangerous?: boolean }>> }
    ).list();
    expect(list.find((t) => t.name === 'write_file')?.dangerous).toBe(true);
  });

  it('未确认时 tools/pre-execute 被拒绝（E_TOOL_DENIED），且 write_file.execute 不会被调用', async () => {
    await core.emit('tools/pre-execute', {
      tool: 'write_file',
      args: { path: '/tmp/e5.txt', content: 'hello' },
      reqId: 'req-e5-1',
      confirmed: false,
    });

    expect(core.denials).toEqual([
      {
        tool: 'write_file',
        reqId: 'req-e5-1',
        code: 'E_TOOL_DENIED',
        reason: expect.stringContaining('danger tool requires user confirm'),
      },
    ]);
    expect(writeFile.executions).toHaveLength(0);
  });

  it('pre-execute 时窗口收到 tool:confirm-required（带 tool + args + reqId）', async () => {
    const { client } = core.openWindow();
    const confirmEvents: Array<{ tool?: string; reqId?: string; args?: unknown }> = [];
    client.on('tool:confirm-required', (payload) => {
      confirmEvents.push(payload as { tool?: string; reqId?: string; args?: unknown });
    });
    await core.settle(); // 订阅帧到达内核

    await core.emit('tools/pre-execute', {
      tool: 'write_file',
      args: { path: '/tmp/e5.txt', content: 'hello' },
      reqId: 'req-e5-confirm',
      confirmed: false,
    });

    expect(confirmEvents).toHaveLength(1);
    expect(confirmEvents[0]).toMatchObject({
      tool: 'write_file',
      reqId: 'req-e5-confirm',
      args: { path: '/tmp/e5.txt', content: 'hello' },
    });
  });

  it('拒绝路径下 tools/post-execute { ok:false, code:"E_TOOL_DENIED" } 推给 tool:executed', async () => {
    const { client } = core.openWindow();
    const executed: Array<{ toolName?: string; ok?: boolean; code?: string }> = [];
    client.on('tool:executed', (payload) => {
      executed.push(payload as { toolName?: string; ok?: boolean; code?: string });
    });
    await core.settle();

    // 拒绝路径：编排在 catch 后显式发一次"用户拒绝"的 post-execute
    await core.emit('tools/post-execute', {
      toolName: 'write_file',
      reqId: 'req-e5-denied',
      ok: false,
      code: 'E_TOOL_DENIED',
      durationMs: 0,
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ toolName: 'write_file', ok: false, code: 'E_TOOL_DENIED' });
    expect(writeFile.executions).toHaveLength(0);
  });
});
