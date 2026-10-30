/**
 * 契约的 Electron IPC 接线（host/contractIpc.ts + host/ipcSenderGuard.ts 的 resolveAiCaller）：
 * - 调用者判定：受信页面按 URL 得到 surface；外站主框架 / 外站子框架一律拒绝；
 * - dangerous：不可信调用者调 tools.confirm 被拒；
 * - 会话生命周期：主框架跨文档导航提交、渲染进程退出与 webContents 销毁时断开会话；
 *   被取消的导航（windowGuards 在 will-navigate 里拦下）与页内导航不断开。
 */

const mockApp = { isPackaged: true, on: jest.fn(), off: jest.fn() };

jest.mock('electron', () => ({
  app: mockApp,
  webContents: { getAllWebContents: () => [] },
}));
// 测试注入假 adapter，不用 Electron 的 ipcMain 实现
jest.mock('../../../src/host/electronIpcAdapter', () => ({ createElectronIpcAdapter: jest.fn() }));

import { EventEmitter } from 'node:events';

import type { IpcAdapter, IpcHandler, IpcInvokeEvent } from '@nomi-ai/ai-runtime';
import { implement, type Handlers, type ProcedureDef, type ServerFrame } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';

import {
  serveContractOverIpc,
  type ContractWebContents,
  type ContractWebContentsSource,
} from '../../../src/host/contractIpc';
import { aiSurfaceForUrl, resolveAiCaller } from '../../../src/host/ipcSenderGuard';

const CHAT = 'file:///Applications/Nomi.app/Contents/Resources/ai-chat/index.html';
const MASCOT = 'file:///Applications/Nomi.app/Contents/Resources/renderer/index.html';
const EVIL = 'https://evil.example/';

const ev = (senderUrl?: string, senderFrameUrl?: string): IpcInvokeEvent => ({
  senderId: 1,
  senderUrl,
  senderFrameUrl,
  send: () => undefined,
});

describe('resolveAiCaller', () => {
  it('受信页面：对话窗口为 chat，桌面角色窗口为 mascot，trusted', () => {
    expect(resolveAiCaller(ev(CHAT))).toEqual({ surface: 'chat', trusted: true });
    expect(resolveAiCaller(ev(MASCOT))).toEqual({ surface: 'mascot', trusted: true });
    expect(resolveAiCaller(ev(CHAT, CHAT))).toEqual({ surface: 'chat', trusted: true });
  });

  it('外站主框架、受信主框架里的外站子框架、缺失 URL：拒绝', () => {
    expect(resolveAiCaller(ev(EVIL))).toBeNull();
    expect(resolveAiCaller(ev(CHAT, EVIL))).toBeNull();
    expect(resolveAiCaller(ev(undefined))).toBeNull();
  });

  it('aiSurfaceForUrl：Windows 路径与转义字符也能识别对话页', () => {
    expect(aiSurfaceForUrl('file:///C:/Program%20Files/Nomi/resources/ai-chat/index.html')).toBe(
      'chat',
    );
    expect(aiSurfaceForUrl('file:///C:/Nomi/resources/renderer/index.html')).toBe('mascot');
    expect(aiSurfaceForUrl('not a url')).toBe('mascot');
  });
});

// ---------------------------------------------------------------------------
// 传输接线
// ---------------------------------------------------------------------------

interface FakeWc extends ContractWebContents {
  emitter: EventEmitter;
}

function fakeWc(id: number): FakeWc {
  const emitter = new EventEmitter();
  return {
    id,
    emitter,
    on: (event, listener) => emitter.on(event, listener as never),
    once: (event, listener) => emitter.once(event, listener),
  };
}

function setup(
  opts: { resolveCaller?: Parameters<typeof serveContractOverIpc>[0]['resolveCaller'] } = {},
) {
  const handlers = new Map<string, IpcHandler>();
  const adapter: IpcAdapter = {
    handle: (ch, h) => void handlers.set(ch, h),
    removeHandler: (ch) => void handlers.delete(ch),
    on: () => undefined,
    off: () => undefined,
    getAllWebContents: () => [],
  };
  const confirmed: unknown[] = [];
  const table = Object.fromEntries(
    Object.entries(appContract.procedures as unknown as Record<string, ProcedureDef>).map(
      ([name, def]) => [
        name,
        def.kind === 'stream'
          ? async function* () {}
          : () => {
              throw new Error(`${name} not stubbed`);
            },
      ],
    ),
  ) as Record<string, unknown>;
  table['ai.sessions.list'] = () => [];
  table['ai.tools.confirm'] = (input: unknown) => void confirmed.push(input);
  const router = implement(appContract, table as unknown as Handlers<AppContract>);

  const existing = fakeWc(1);
  let created: ((wc: ContractWebContents) => void) | undefined;
  const contents: ContractWebContentsSource = {
    all: () => [existing],
    onCreated: (fn) => {
      created = fn;
      return () => {
        created = undefined;
      };
    },
  };
  const handle = serveContractOverIpc({ router, adapter, contents, ...opts });

  /** 以某个 sender 发一帧，收集它收到的回帧 */
  const sent: Array<{ senderId: number; frame: ServerFrame }> = [];
  const invoke = (senderId: number, url: string, c: string, frame: unknown) =>
    handlers.get('contract:request')!(
      {
        senderId,
        senderUrl: url,
        send: (_ch, payload) =>
          sent.push({ senderId, frame: (payload as { frame: ServerFrame }).frame }),
      },
      { c, frame },
    );
  const call = async (senderId: number, url: string, id: string, name: string, input?: unknown) => {
    await invoke(senderId, url, `c${senderId}`, { t: 'req', id, kind: 'call', name, input });
    await new Promise((r) => setTimeout(r, 5));
    return sent.filter((s) => s.senderId === senderId && 'id' in s.frame && s.frame.id === id);
  };
  return { handlers, handle, existing, created: () => created, invoke, call, confirmed };
}

describe('serveContractOverIpc', () => {
  it('挂 contract:request；受信页面能调用，外站发送方收到 FORBIDDEN', async () => {
    const { handlers, call } = setup();
    expect([...handlers.keys()]).toEqual(['contract:request']);
    const ok = await call(1, CHAT, 'r1', 'ai.sessions.list');
    expect(ok.map((s) => s.frame)).toEqual([{ t: 'res', id: 'r1', output: [] }]);
    const denied = await call(2, EVIL, 'r2', 'ai.sessions.list');
    expect(denied[0]!.frame).toMatchObject({ t: 'err', error: { code: 'FORBIDDEN' } });
  });

  it('dangerous：不可信调用者调 tools.confirm 被拒，受信调用者照常', async () => {
    const untrusted = setup({ resolveCaller: () => ({ surface: 'chat', trusted: false }) });
    const r = await untrusted.call(1, CHAT, 'd1', 'ai.tools.confirm', { reqId: 'x', ok: true });
    expect(r[0]!.frame).toMatchObject({ t: 'err', error: { code: 'FORBIDDEN' } });
    expect(untrusted.confirmed).toEqual([]);

    const trusted = setup();
    const ok = await trusted.call(1, CHAT, 'd2', 'ai.tools.confirm', { reqId: 'x', ok: true });
    expect(ok[0]!.frame).toMatchObject({ t: 'res', id: 'd2' });
    expect(trusted.confirmed).toEqual([{ reqId: 'x', ok: true }]);
  });

  it('被取消的导航（只有 will-navigate / did-start-navigation）与页内导航不断开会话', async () => {
    const { handle, existing, call } = setup();
    await call(1, CHAT, 'a', 'ai.sessions.list');
    expect(handle.transport.sessionCount).toBe(1);

    // windowGuards 在 will-navigate 里 preventDefault：不会有 did-navigate
    existing.emitter.emit('will-navigate', { url: EVIL });
    existing.emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    existing.emitter.emit('did-fail-navigation', { isMainFrame: true });
    existing.emitter.emit('did-navigate-in-page', {});
    expect(handle.transport.sessionCount).toBe(1);

    // 会话仍然可用
    const ok = await call(1, CHAT, 'b', 'ai.sessions.list');
    expect(ok.map((s) => s.frame)).toEqual([{ t: 'res', id: 'b', output: [] }]);
  });

  it('跨文档导航提交、渲染进程退出与销毁断开会话；之后创建的 webContents 也被监听', async () => {
    const { handle, existing, created, call } = setup();
    await call(1, CHAT, 'a', 'ai.sessions.list');
    expect(handle.transport.sessionCount).toBe(1);
    existing.emitter.emit('did-navigate');
    expect(handle.transport.sessionCount).toBe(0);

    await call(1, CHAT, 'a2', 'ai.sessions.list');
    expect(handle.transport.sessionCount).toBe(1);
    existing.emitter.emit('render-process-gone');
    expect(handle.transport.sessionCount).toBe(0);

    const later = fakeWc(7);
    created()!(later);
    await call(7, MASCOT, 'b', 'ai.sessions.list');
    expect(handle.transport.sessionCount).toBe(1);
    later.emitter.emit('destroyed');
    expect(handle.transport.sessionCount).toBe(0);
  });

  it('stop 移除通道与 webContents 监听', () => {
    const { handle, handlers, created } = setup();
    handle.stop();
    expect(handlers.size).toBe(0);
    expect(created()).toBeUndefined();
  });
});
