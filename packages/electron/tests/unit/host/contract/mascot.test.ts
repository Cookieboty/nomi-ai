/**
 * D5（host/contract/mascot.ts）：mascot / character / persona / island / chatBg / window 的处理函数
 * 委派给窗口控制器与服务、surfaces 按原 preload 拒绝别的窗口、背景图错误换成契约码、
 * 建 router 时把应用事件总线接给看板娘推送、旧通道桥接成契约事件。
 */

const allWindows: Array<{ isDestroyed(): boolean; webContents: unknown }> = [];
jest.mock('electron', () => ({
  // ai/mascotCommand.ts 仍用 BrowserWindow 数窗口
  BrowserWindow: { getAllWindows: () => allWindows },
}));

import { createClient, type Surface } from '@nomi-ai/contract';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { broadcastMascotCommand } from '../../../../src/ai/mascotCommand';
import { createRecordingAppEvents } from '../../../../src/core/appEvents';
import {
  APP_EVENT_BRIDGE,
  createAppRouter,
  createContractEventBridge,
  createContractServices,
  type ContractDeps,
  type ContractServices,
} from '../../../../src/host/contract';
import { mascotEventBridge } from '../../../../src/host/contract/mascot';
import { mascotAppEvents, setMascotAppEvents } from '../../../../src/mascot/mascotEvents';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const scale = (s: number) => ({
  scale: s,
  min: 0.3,
  max: 1.5,
  hardMax: 1.5,
  default: 0.5,
  step: 0.1,
  window: { width: 330, height: 355 },
});
const bg = { imageUrl: 'chat-asset://presets/background.jpg', blur: 8, opacity: 0.4 };
const persona = {
  characterId: 'nomi',
  displayName: 'Nomi',
  systemPromptIdentity: 'You are Nomi.',
  greetings: ['hi'],
};
const snapshot = {
  source: 'builtin',
  id: 'nomi',
  mode: 'rive',
  displayName: { zh: '诺米', en: 'Nomi' },
  assetBaseUrl: null,
  onboarding: null,
  voiceBaseUrl: null,
  riveUrl: null,
  staticUrl: null,
  spriteManifestUrl: null,
  hitboxes: null,
  rive: null,
  locales: {},
  reason: undefined,
};

function fakes() {
  const controller = {
    reportHit: jest.fn(),
    reportShape: jest.fn(),
    reportGeometry: jest.fn(),
    beginDrag: jest.fn(),
    moveDrag: jest.fn(),
    endDrag: jest.fn(),
    setConfig: jest.fn(),
    wanderNow: jest.fn(),
    snapshot: jest.fn(() => ({
      body: { x: 1, y: 2, vx: 0, vy: 0, mode: 'idle' },
      ignoring: false,
      shapeRects: 0,
      clickThroughMode: 'ignore',
      box: null,
      cfg: { clickThrough: true, gravity: false, wander: false, reactions: true, globalLook: true },
    })),
    scaleState: jest.fn(() => scale(0.5)),
    scaleSet: jest.fn((v: number) => scale(v)),
    scaleStep: jest.fn(() => scale(0.6)),
    scaleWheel: jest.fn(() => scale(0.7)),
    scaleReset: jest.fn(() => scale(0.5)),
  };
  const windowActions = {
    quitApp: jest.fn(),
    setAlwaysOnTop: jest.fn(),
    moveWindow: jest.fn(),
    getPosition: jest.fn(() => [10, 20]),
    setPosition: jest.fn(),
    getCursorPosition: jest.fn(() => ({ x: 3, y: 4 })),
    openAiChat: jest.fn(async () => ({ success: true })),
    openTaskBoard: jest.fn(async () => ({ success: false, error: 'boom' })),
  };
  const store: Record<string, unknown> = { modelName: 'nomi' };
  return {
    controller,
    windowActions,
    windowManager: { mascotController: controller as unknown },
    config: {
      get: jest.fn((k: string, d?: unknown) => (k in store ? store[k] : d)),
      set: jest.fn((k: string, v: unknown) => {
        store[k] = v;
      }),
      save: jest.fn(async () => undefined),
    },
    characterPack: { getActive: jest.fn(() => snapshot) },
    persona: { get: jest.fn(() => persona) },
    island: {
      get: jest.fn(() => ({
        enabled: true,
        style: 'auto',
        kinds: { message: true, agent: true, reminder: true },
        mode: 'notch',
        platform: 'darwin',
      })),
      set: jest.fn((_p: object) => ({
        enabled: true,
        style: 'auto',
        kinds: { message: true, agent: false, reminder: true },
      })),
      test: jest.fn(() => true),
    },
    chatBg: {
      get: jest.fn(() => bg),
      set: jest.fn(async (p: object) => ({ ...bg, ...p })),
      reset: jest.fn(async () => bg),
      pickImage: jest.fn(async (): Promise<typeof bg> => bg),
    },
  };
}

function setup(surface: Surface = 'mascot', trusted = true) {
  const f = fakes();
  const services: ContractServices = Object.assign(createContractServices(), {
    windowManager: f.windowManager,
    windowActions: f.windowActions,
    config: f.config,
    characterPack: f.characterPack,
    persona: f.persona,
    island: f.island,
    chatBg: f.chatBg,
  } as never);
  const events = createRecordingAppEvents();
  const ports = { app: { platform: () => 'linux' } } as unknown as HostPorts;
  const deps: ContractDeps = { services, ports, events, logger };
  const app = createAppRouter({ deps });
  const server = createInProcessServer();
  const stop = server.serve(app.router as never);
  const transport = server.connect({ surface, trusted });
  const api = createClient(app.router.contract, transport, { handshake: 'off' });
  return {
    f,
    events,
    api,
    router: app.router,
    close: () => {
      transport.disconnect();
      stop();
      app.dispose();
      setMascotAppEvents(null);
    },
  };
}

describe('host/contract/mascot', () => {
  beforeEach(() => jest.clearAllMocks());

  it('看板娘窗口：互动上报与大小委派给窗口控制器（原位置参数）', async () => {
    const { f, api, close } = setup('mascot');
    try {
      await api.mascot.setHit({ hit: true });
      await api.mascot.setShape({ rects: [{ x: 0, y: 1, width: 2, height: 3 }] });
      await api.mascot.setGeometry({ left: 1, right: 2, top: 3, bottom: 4, vw: 5, vh: 6 });
      await api.mascot.dragStart({ screenX: 7, screenY: 8 });
      await api.mascot.dragMove({ screenX: 9, screenY: 10 });
      await api.mascot.dragEnd();
      await api.mascot.setInteractionConfig({ gravity: true, bubbleReplies: false });
      await api.mascot.wanderNow();
      expect(f.controller.reportHit).toHaveBeenCalledWith(true);
      expect(f.controller.reportShape).toHaveBeenCalledWith([{ x: 0, y: 1, width: 2, height: 3 }]);
      expect(f.controller.reportGeometry).toHaveBeenCalledWith({
        left: 1,
        right: 2,
        top: 3,
        bottom: 4,
        vw: 5,
        vh: 6,
      });
      expect(f.controller.beginDrag).toHaveBeenCalledWith(7, 8);
      expect(f.controller.moveDrag).toHaveBeenCalledWith(9, 10);
      expect(f.controller.endDrag).toHaveBeenCalled();
      expect(f.controller.setConfig).toHaveBeenCalledWith({ gravity: true, bubbleReplies: false });
      expect(f.controller.wanderNow).toHaveBeenCalled();

      expect(await api.mascot.scaleGet()).toMatchObject({ scale: 0.5 });
      expect(await api.mascot.scaleSet({ scale: 1.2 })).toMatchObject({ scale: 1.2 });
      expect(await api.mascot.scaleStep({ dir: -1 })).toMatchObject({ scale: 0.6 });
      expect(await api.mascot.scaleWheel({ deltaY: -100, deltaMode: 1 })).toMatchObject({
        scale: 0.7,
      });
      expect(await api.mascot.scaleReset()).toMatchObject({ scale: 0.5 });
      expect(f.controller.scaleStep).toHaveBeenCalledWith(-1);
      expect(f.controller.scaleWheel).toHaveBeenCalledWith(-100, 1);
      expect(await api.mascot.debugSnapshot()).toMatchObject({ clickThroughMode: 'ignore' });
    } finally {
      close();
    }
  });

  it('看板娘窗口：窗口操作、模型名、角色包、人设、平台', async () => {
    const { f, api, close } = setup('mascot');
    try {
      await api.window.quit();
      await api.window.setAlwaysOnTop({ flag: false });
      await api.window.move({ deltaX: 5, deltaY: -5 });
      await api.window.setPosition({ x: 1, y: 2 });
      expect(await api.window.getPosition()).toEqual([10, 20]);
      expect(await api.window.getCursorPosition()).toEqual({ x: 3, y: 4 });
      expect(await api.window.openAiChat()).toEqual({ success: true });
      expect(await api.window.openTaskBoard()).toEqual({ success: false, error: 'boom' });
      expect(await api.window.platform()).toBe('linux');
      expect(f.windowActions.quitApp).toHaveBeenCalled();
      expect(f.windowActions.setAlwaysOnTop).toHaveBeenCalledWith(false);
      expect(f.windowActions.moveWindow).toHaveBeenCalledWith(5, -5);
      expect(f.windowActions.setPosition).toHaveBeenCalledWith(1, 2);

      expect(await api.mascot.getSavedModel()).toBe('nomi');
      await api.mascot.saveModel({ modelName: '' });
      expect(f.config.set).toHaveBeenCalledWith('modelName', '');
      expect(f.config.save).toHaveBeenCalled();
      expect(await api.mascot.getSavedModel()).toBe('');

      expect(await api.character.getActivePack()).toMatchObject({ source: 'builtin', id: 'nomi' });
      expect(await api.persona.get()).toEqual(persona);
    } finally {
      close();
    }
  });

  it('对话窗口：灵动岛与聊天背景；选图对话框挂在对话窗口上，导入错误换成契约码', async () => {
    const { f, api, close } = setup('chat');
    try {
      expect(await api.island.get()).toMatchObject({ mode: 'notch' });
      expect(await api.island.set({ kinds: { agent: false } })).toMatchObject({ enabled: true });
      expect(f.island.set).toHaveBeenCalledWith({ kinds: { agent: false } });
      expect(await api.island.test()).toBe(true);

      expect(await api.chatBg.get()).toEqual(bg);
      expect(await api.chatBg.set({ blur: 3 })).toMatchObject({ blur: 3 });
      expect(f.chatBg.set).toHaveBeenCalledWith({ blur: 3 });
      expect(await api.chatBg.reset()).toEqual(bg);
      expect(await api.chatBg.pickImage()).toEqual(bg);
      expect(f.chatBg.pickImage).toHaveBeenCalledWith('chat');

      f.chatBg.pickImage.mockRejectedValueOnce(
        new Error('CHAT_BG_TOO_LARGE: image too large: 99 bytes'),
      );
      await expect(api.chatBg.pickImage()).rejects.toMatchObject({
        code: 'CHAT_BG_TOO_LARGE',
        message: 'CHAT_BG_TOO_LARGE: image too large: 99 bytes',
      });
      f.chatBg.pickImage.mockRejectedValueOnce(new Error('CHAT_BG_UNSUPPORTED: .bmp'));
      await expect(api.chatBg.pickImage()).rejects.toMatchObject({ code: 'CHAT_BG_UNSUPPORTED' });
      f.chatBg.pickImage.mockRejectedValueOnce(new Error('EACCES'));
      await expect(api.chatBg.pickImage()).rejects.toMatchObject({
        code: 'INTERNAL',
        message: 'EACCES',
      });

      // 大小在对话窗口的设置页里也能调
      expect(await api.mascot.scaleSet({ scale: 0.8 })).toMatchObject({ scale: 0.8 });
    } finally {
      close();
    }
  });

  it('surfaces：看板娘专属的过程拒绝对话窗口，对话窗口专属的拒绝看板娘窗口', async () => {
    const chat = setup('chat');
    try {
      await expect(chat.api.mascot.setHit({ hit: true })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(chat.api.window.quit()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(chat.api.mascot.getSavedModel()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(chat.f.controller.reportHit).not.toHaveBeenCalled();
      expect(chat.f.windowActions.quitApp).not.toHaveBeenCalled();
    } finally {
      chat.close();
    }
    const mascot = setup('mascot');
    try {
      await expect(mascot.api.island.set({ enabled: false })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(mascot.api.chatBg.pickImage()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mascot.f.island.set).not.toHaveBeenCalled();
      expect(mascot.f.chatBg.pickImage).not.toHaveBeenCalled();
    } finally {
      mascot.close();
    }
  });

  it('本域没有 dangerous 过程：不可信调用者（受 surfaces 约束）照常调用', async () => {
    const { api, close } = setup('mascot', false);
    try {
      expect(await api.persona.get()).toEqual(persona);
    } finally {
      close();
    }
  });

  it('看板娘窗口还没建好：上报直接丢弃，大小以 UNAVAILABLE 失败', async () => {
    const { f, api, close } = setup('mascot');
    try {
      f.windowManager.mascotController = null;
      await expect(api.mascot.setHit({ hit: true })).resolves.toBeUndefined();
      await expect(api.mascot.scaleGet()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      close();
    }
  });

  it('建 router 时把应用事件总线接给看板娘推送：看板娘指令经事件总线发给所有窗口', () => {
    const { events, close } = setup('mascot');
    try {
      expect(mascotAppEvents()).toBe(events);
      allWindows.splice(0, allWindows.length, {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: jest.fn() },
      });
      expect(broadcastMascotCommand({ type: 'motion', name: 'wave' })).toBe(1);
      expect(events.published).toEqual([
        { channel: 'mascot:command', payload: { type: 'motion', name: 'wave' }, surfaces: null },
      ]);
    } finally {
      allWindows.splice(0);
      close();
    }
    expect(mascotAppEvents()).toBeNull();
  });

  it('旧通道桥接成契约事件（window-mouse-* 没有 payload → null）', () => {
    const inner = createRecordingAppEvents();
    const bridge = createContractEventBridge(inner, mascotEventBridge);
    const sink = { publish: jest.fn() };
    bridge.attach(sink);
    const cursor = { x: 1, y: 2, inside: true };
    bridge.publish('mascot:cursor', cursor, { surface: 'mascot' });
    bridge.publish('mascot:scale-changed', scale(0.5), { surface: ['mascot', 'chat'] });
    bridge.publish('character:persona-changed', persona);
    bridge.publish('chat-bg:changed', bg);
    bridge.publish('window-mouse-enter', undefined, { surface: 'mascot' });
    bridge.publish('window-mouse-leave', null, { surface: 'mascot' });
    expect(sink.publish.mock.calls).toEqual([
      ['mascot.cursor', cursor],
      ['mascot.scaleChanged', scale(0.5)],
      ['persona.changed', persona],
      ['chatBg.changed', bg],
      ['window.mouseEnter', null],
      ['window.mouseLeave', null],
    ]);
    // 旧通道照常发（迁移期间两路并行）
    expect(inner.published.map((p) => p.channel)).toEqual([
      'mascot:cursor',
      'mascot:scale-changed',
      'character:persona-changed',
      'chat-bg:changed',
      'window-mouse-enter',
      'window-mouse-leave',
    ]);
    for (const channel of [
      'mascot:body',
      'mascot:physics-event',
      'mascot:command',
      'character:persona-changed',
    ])
      expect(APP_EVENT_BRIDGE[channel]).toBeDefined();
  });

  it('桥接后的事件经 router 推给订阅了的窗口（schema 校验通过）', async () => {
    const { api, router, close } = setup('mascot');
    try {
      const got: unknown[] = [];
      const offs = [
        api.on('mascot.physicsEvent', (e) => got.push(e)),
        api.on('mascot.body', (e) => got.push(e)),
      ];
      await new Promise((r) => setTimeout(r, 0));
      const bridge = createContractEventBridge(
        createRecordingAppEvents(),
        mascotEventBridge,
        logger,
      );
      bridge.attach(router.events as never);
      bridge.publish('mascot:physics-event', { type: 'release', vx: 1, vy: 2 });
      bridge.publish('mascot:body', { mode: 'falling', vx: 0, vy: 9, ax: 0, ay: 0, dir: 0 });
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([
        { type: 'release', vx: 1, vy: 2 },
        { mode: 'falling', vx: 0, vy: 9, ax: 0, ay: 0, dir: 0 },
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
      for (const off of offs) off();
    } finally {
      close();
    }
  });
});
