/**
 * 工具确认发到哪：对话窗口开着 → 只发给对话窗口（授权卡片），不打扰桌面角色；桌面角色被关掉了 →
 * 打开对话窗口，不把她叫出来；否则发给桌面角色。请求文件夹在对话里问，必要时才打开系统选择框。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('../../../src/ai/mascotCommand', () => ({
  sendMascotCommand: jest.fn(),
  avatarGesture: jest.fn(),
  avatarEmotion: jest.fn(),
  publishAvatarCue: jest.fn(),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { DesktopService } from '../../../src/desktop/DesktopService';
import type { ConfirmRequest } from '../../../src/desktop/PermissionBroker';
import { fakeHostPorts } from '../helpers/fakeHostPorts';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const live: AbortController[] = [];

function setup(opts: { chat: boolean; hidden: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-route-'));
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-home-')));
  const events = createRecordingAppEvents();
  const ports = fakeHostPorts({ userData: root, home });
  const picks: Array<string | undefined> = [];
  ports.dialogs.pickDirectory = jest.fn(async (o: { defaultPath?: string }) => {
    picks.push(o.defaultPath);
    return null;
  }) as never;
  const svc = new DesktopService(root, logger as never, { ports, events });
  const sent: Array<{ ch: string; payload: unknown; surface?: string }> = [];
  const publish = events.publish.bind(events);
  events.publish = (channel, payload, o) => {
    publish(channel, payload, o);
    sent.push({ ch: channel, payload, surface: o?.surface as string | undefined });
  };
  const win = {
    isDestroyed: () => false,
    isVisible: () => !opts.hidden,
    showInactive: jest.fn(),
    webContents: { id: 7 },
  };
  const openChat = jest.fn(async () => ({}) as never);
  const summonMascot = jest.fn();
  svc.attachWindows({
    main: () => (opts.hidden ? null : (win as never)),
    openChat,
    mascotHidden: () => opts.hidden,
    summonMascot,
    chatOpen: () => opts.chat,
  });
  const requests = (surface: string) =>
    sent
      .filter((e) => e.ch === 'desktop.confirmRequest' && e.surface === surface)
      .map((e) => e.payload as ConfirmRequest);
  // 没答复的请求在用例结束时取消，不留 120 秒的超时计时器
  const turn = new AbortController();
  live.push(turn);
  const ask = () =>
    svc.broker.authorize({
      tool: 'fs_write_text',
      danger: 'write',
      summary: 's',
      args: {},
      signal: turn.signal,
    });
  return { svc, home, sent, requests, ask, openChat, summonMascot, picks };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => {
  for (const c of live.splice(0)) c.abort();
});

describe('confirm routing', () => {
  it('chat window open: only the chat window gets the request; its answer settles it', async () => {
    const t = setup({ chat: true, hidden: false });
    const p = t.ask();
    await tick();
    expect(t.requests('chat')).toHaveLength(1);
    expect(t.requests('mascot')).toHaveLength(0);
    t.svc.answerConfirm(8, t.requests('chat')[0]!.id, true, false, false, 'chat');
    expect(await p).toBe('allowed');
    expect(t.sent.filter((e) => e.ch === 'desktop.confirmCancel').map((e) => e.surface)).toContain(
      'chat',
    );
  });

  it('chat closed, mascot on the desktop: the mascot gets it', async () => {
    const t = setup({ chat: false, hidden: false });
    void t.ask();
    await tick();
    expect(t.requests('mascot')).toHaveLength(1);
    expect(t.requests('chat')).toHaveLength(0);
  });

  it('chat closed, mascot hidden: opens the chat window instead of summoning the mascot', async () => {
    const t = setup({ chat: false, hidden: true });
    void t.ask();
    await tick();
    await tick();
    expect(t.openChat).toHaveBeenCalled();
    expect(t.summonMascot).not.toHaveBeenCalled();
    expect(t.requests('chat')).toHaveLength(1);
  });

  it('answers from neither the chat window nor the mascot window are ignored', async () => {
    const t = setup({ chat: true, hidden: false });
    const p = t.svc.broker.authorize({
      tool: 'fs_write_text',
      danger: 'write',
      summary: 's',
      args: {},
      signal: AbortSignal.timeout(200),
    });
    await tick();
    t.svc.answerConfirm(99, t.requests('chat')[0]!.id, true, false, false, 'settings');
    expect(await p).toBe('denied');
  });
});

describe('requestFolder', () => {
  it('chat open: a valid suggested folder is granted from the card, without the system picker', async () => {
    const t = setup({ chat: true, hidden: false });
    const dir = path.join(t.home, 'proj');
    fs.mkdirSync(dir);
    const p = t.svc.requestFolder(dir, 'read-write', 'need the repo');
    await tick();
    await tick();
    const req = t.requests('chat')[0]!;
    expect(req).toMatchObject({ kind: 'scope', scopePath: dir, scopeMode: 'read-write' });
    expect(req.preview).toBe('need the repo');
    t.svc.answerConfirm(8, req.id, true, false, false, 'chat');
    expect(await p).toBe(dir);
    expect(t.picks).toEqual([]);
  });

  it('pick opens the system picker; a too-broad suggestion (home) is not offered for one-click grant', async () => {
    const t = setup({ chat: true, hidden: false });
    const p = t.svc.requestFolder(t.home, 'read');
    await tick();
    await tick();
    const req = t.requests('chat')[0]!;
    expect(req.kind).toBe('scope');
    expect(req.scopePath).toBeUndefined();
    t.svc.answerConfirm(8, req.id, false, false, true, 'chat');
    expect(await p).toBeNull(); // 选择框被取消
    expect(t.picks).toEqual([t.home]);
  });

  it('chat closed: straight to the system picker, like before', async () => {
    const t = setup({ chat: false, hidden: false });
    expect(await t.svc.requestFolder('~/x', 'read')).toBeNull();
    expect(t.picks).toEqual([path.join(t.home, 'x')]);
    expect(t.requests('chat')).toHaveLength(0);
    expect(t.requests('mascot')).toHaveLength(0);
  });
});
