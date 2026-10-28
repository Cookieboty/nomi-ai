import { test, expect } from '../fixtures/electronApp';

/**
 * E2 · chat-only profile · headed 复刻
 *
 * 语义对齐 e2e/tests/E2.chat-only-send-and-tool.test.ts：
 * - renderer 经契约（`window.nomiTransport`）调用 `ai.tools.list` 等过程；
 * - 主进程 emit tools/post-execute 后 renderer 收到契约事件 `ai.tool.executed`。
 */
test.describe('E2 · chat-only · 契约传输联通 + tool:executed 推送', () => {
  test('renderer 可经契约拿到 tools 列表（含 echo）', async ({ launchHeaded }) => {
    const { page } = await launchHeaded({ profile: 'chat-only' });
    expect(page).not.toBeNull();
    await page!.waitForFunction(() => typeof (window as any).__e2eProbe !== 'undefined');

    const tools = await page!.evaluate(async () => {
      const list = (await (window as any).__e2eProbe.call('ai.tools.list')) as Array<{
        name: string;
      }>;
      return list.map((t) => t.name);
    });
    expect(tools).toContain('echo');
  });

  test('主进程 emit tools/post-execute 后 renderer 收到 tool:executed 广播', async ({
    launchHeaded,
  }) => {
    const { app, page } = await launchHeaded({ profile: 'chat-only' });
    expect(page).not.toBeNull();
    await page!.waitForFunction(() => typeof (window as any).__e2eProbe !== 'undefined');
    await page!.evaluate(() => (window as any).__e2eProbe.clear());

    await app.evaluate(async () => {
      await (globalThis as any).__aiE2eProbe.emitToolExecuted({
        tool: 'echo',
        reqId: 'r-tool-h1',
        ok: true,
        result: { echoed: 'hello headed' },
      });
    });

    await expect
      .poll(() => page!.evaluate(() => (window as any).__e2eProbe.getToolExecuted().length))
      .toBeGreaterThanOrEqual(1);

    const events = await page!.evaluate(
      () => (window as any).__e2eProbe.getToolExecuted() as any[],
    );
    expect(events[0]).toMatchObject({
      tool: 'echo',
      ok: true,
      result: { echoed: 'hello headed' },
    });
  });
});
