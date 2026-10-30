/**
 * E7 · 契约的 WebSocket 传输（docs/design/core-host-decoupling.md §5.2、§8、§11.3「视图在普通浏览器运行」）：
 * 真实内核跑在无界面宿主上，`serveContractOverWebSocket` 只监听 127.0.0.1；视图侧用
 * `createWebSocketClientTransport`（浏览器里 ai-chat 用的就是它）连上来：
 * - 握手（`meta.version`）、查询（主题 / 界面语言 / 供应商 / 人设）、修改与事件订阅走得通；
 * - 换一个连接改主题，WebSocket 上订阅了 `theme.changed` 的视图收到事件；
 * - 错 token、外站 Origin 连不上，内核的会话数不变。
 */
import { createClient, createWebSocketClientTransport } from '@nomi-ai/contract';
import { appContract } from '@nomi-ai/contract/app';
import { startHeadlessCore, type HeadlessCore } from '@nomi-ai/host-node/core';
import {
  createDevToken,
  createNodeWebSocketFactory,
  serveContractOverWebSocket,
  type WebSocketContractServer,
} from '@nomi-ai/host-node/websocket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = 'http://127.0.0.1:6128';

describe('E7 · WebSocket 传输：视图经 127.0.0.1 连内核', () => {
  let headless: HeadlessCore;
  let server: WebSocketContractServer;
  const token = createDevToken();

  beforeAll(async () => {
    headless = await startHeadlessCore({ logLevel: 'warn' });
    server = await serveContractOverWebSocket(headless.router as never, {
      token,
      allowedOrigins: [ORIGIN],
    });
  });

  afterAll(async () => {
    await server?.close();
    await headless?.stop();
  });

  const connect = (opts: { token?: string; origin?: string } = {}) => {
    const transport = createWebSocketClientTransport({
      url: server.url,
      token: opts.token ?? token,
      surface: 'chat',
      createSocket: createNodeWebSocketFactory({ origin: opts.origin ?? ORIGIN }),
    });
    return { transport, api: createClient(appContract, transport) };
  };

  it('握手、查询、修改与事件订阅', async () => {
    const { transport, api } = connect();
    await transport.ready;
    expect(server.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

    const info = await api.$connect();
    expect(info.version.major).toBe(appContract.version.major);

    expect(await api.theme.get()).toMatchObject({ pref: expect.any(String) });
    expect(await api.locale.get()).toMatchObject({ locale: 'zh-CN' });
    expect(await api.providers.state()).toBeTruthy();
    expect(await api.persona.get()).toMatchObject({ characterId: expect.any(String) });

    // 订阅 → 另一个连接（in-process，相当于另一个窗口）改主题 → WebSocket 上的视图收到事件
    const seen: Array<{ pref: string }> = [];
    api.on('theme.changed', (e) => seen.push(e as { pref: string }));
    await new Promise((r) => setTimeout(r, 20));
    const other = headless.connect().api;
    const current = await api.theme.get();
    const next = current.pref === 'ink' ? 'sunset' : 'ink';
    await other.theme.set({ pref: next });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.at(-1)).toMatchObject({ pref: next });

    // 修改也能从 WebSocket 发起
    await api.theme.set({ pref: current.pref });
    expect((await other.theme.get()).pref).toBe(current.pref);

    // AI 门面的过程也在同一个 router 上
    expect(Array.isArray(await api.ai.tools.list())).toBe(true);

    transport.close();
  });

  it('错 token 与外站 Origin 被拒绝', async () => {
    await new Promise((r) => setTimeout(r, 50)); // 上一个用例关掉的连接在服务端收尾
    const before = server.connectionCount;
    const wrong = connect({ token: createDevToken() });
    await expect(wrong.transport.ready).rejects.toMatchObject({ code: 'TRANSPORT' });
    await expect(wrong.api.theme.get()).rejects.toMatchObject({ code: 'TRANSPORT' });
    const foreign = connect({ origin: 'https://evil.example' });
    await expect(foreign.transport.ready).rejects.toMatchObject({ code: 'TRANSPORT' });
    expect(server.connectionCount).toBe(before);
    expect(server.rejectedCount).toBeGreaterThanOrEqual(2);
  });
});
