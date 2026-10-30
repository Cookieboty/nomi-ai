import { test, expect } from '../fixtures/electronApp';

/**
 * E1 · companion profile · headed 复刻
 *
 * 语义对齐 e2e/tests/E1.companion-tts-lipsync.test.ts：
 * - 主进程 emit `tts/chunk` → 契约事件 `ai.tts.chunk` 推给订阅了的窗口
 *   → renderer preload 的契约客户端捕获到 buffer 里；
 * - renderer 中 `window.__e2eProbe.getTtsChunks()` 返回的 rms 序列与主进程发出的一致；
 * - 同一时刻多个渲染窗口场景在 headed 里通过 `app.evaluate` 只使用 1 个 primary window
 *   验证（多窗广播已在 headless E1 覆盖）。
 */
test.describe('E1 · companion · tts chunk → renderer 收到 rms 序列', () => {
  test('主进程 emit tts/chunk 后 renderer 收到匹配 rms 序列', async ({ launchHeaded }) => {
    const { app, page } = await launchHeaded({ profile: 'companion' });
    expect(page, 'headed E1 需要主窗口').not.toBeNull();

    // 等 preload/event 通道就绪
    await page!.waitForFunction(() => typeof (window as any).__e2eProbe !== 'undefined');
    await page!.evaluate(() => (window as any).__e2eProbe.clear());

    await app.evaluate(async () => {
      const probe = (globalThis as any).__aiE2eProbe;
      await probe.emitTts({
        reqId: 'r-tts-h1',
        seq: 0,
        mime: 'audio/mp3',
        data: [0, 1],
        rms: 0.65,
      });
      await probe.emitTts({
        reqId: 'r-tts-h1',
        seq: 1,
        mime: 'audio/mp3',
        data: [0, 1],
        rms: 0.42,
        isFinal: true,
      });
    });

    // 广播是异步的：poll 到 chunks.length === 2
    await expect
      .poll(() => page!.evaluate(() => (window as any).__e2eProbe.getTtsChunks().length), {
        timeout: 5_000,
      })
      .toBe(2);

    const chunks = await page!.evaluate(
      () => (window as any).__e2eProbe.getTtsChunks() as Array<{ rms: number; seq: number }>,
    );
    expect(chunks.map((c) => c.rms)).toEqual([0.65, 0.42]);
    expect(chunks.every((c) => c.rms > 0)).toBe(true);
  });

  test('agent/turn-end 推给窗口（契约事件 ai.agent.turnEnd）', async ({ launchHeaded }) => {
    const { app, page } = await launchHeaded({ profile: 'companion' });
    expect(page).not.toBeNull();
    await page!.waitForFunction(() => typeof (window as any).__e2eProbe !== 'undefined');
    await page!.evaluate(() => (window as any).__e2eProbe.clear());

    await app.evaluate(async () => {
      await (globalThis as any).__aiE2eProbe.emitTurnEnd({
        sessionId: 's-e1-headed',
        turnId: 't-1',
        ok: true,
      });
    });

    await expect
      .poll(() => page!.evaluate(() => (window as any).__e2eProbe.getTurnEnds().length))
      .toBeGreaterThanOrEqual(1);

    const ends = await page!.evaluate(() => (window as any).__e2eProbe.getTurnEnds() as any[]);
    expect(ends[0]).toMatchObject({ sessionId: 's-e1-headed', turnId: 't-1', ok: true });
  });
});
