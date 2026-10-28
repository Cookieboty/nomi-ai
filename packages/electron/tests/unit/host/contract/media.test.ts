/**
 * D1（host/contract/media.ts）：voice / tts / desktop / screen / nav 的处理函数委派给服务、
 * 按窗口的操作用调用方的 webContents id、surfaces 与 dangerous 由内置守卫拒绝、流式识别的推送
 * 进到 `voice.streamStart` 的流里、旧通道桥接成契约事件。
 */

const fakeTts = {
  getConfig: jest.fn(() => ({ enabled: true, provider: 'edge', lastModified: 0 })),
  saveConfig: jest.fn(),
  resetConfig: jest.fn(),
  testConnection: jest.fn(async () => ({ success: true, message: 'ok', latency: 3 })),
  preview: jest.fn(async () => ({ success: true, audioBase64: 'AA==', via: 'edge' })),
  voices: jest.fn(async () => ({
    voices: [{ shortName: 'zh-CN-A', locale: 'zh-CN' }],
    source: 'builtin',
  })),
  status: jest.fn(() => ({ consecutiveFailures: 0 })),
  stop: jest.fn(() => true),
  speak: jest.fn(async () => ({ success: false, via: 'none', message: 'tts disabled' })),
  reply: jest.fn(() => true),
  promptVoice: jest.fn(() => false),
  health: jest.fn(() => ({ success: true, message: 'ok' })),
};
jest.mock('../../../../src/tts/TtsService', () => ({ getTtsService: () => fakeTts }));

import { createClient, type CallerContext } from '@nomi-ai/contract';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { createRecordingAppEvents } from '../../../../src/core/appEvents';
import {
  APP_EVENT_BRIDGE,
  createAppRouter,
  createContractEventBridge,
  createContractServices,
  type ContractDeps,
  type ContractServices,
} from '../../../../src/host/contract';
import { mediaEventBridge } from '../../../../src/host/contract/media';
import { openVoiceStreamCount } from '../../../../src/host/contract/media/voiceSenders';
import type { VoiceSender } from '../../../../src/voice/VoiceService';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const voiceSettings = {
  engine: 'volc',
  language: 'auto',
  whisperModel: 'ggml-base',
  whisperCliPath: '',
  providerId: '',
  customBaseURL: '',
  cloudModel: 'whisper-1',
  volcResourceId: 'volc.seedasr.sauc.duration',
  volcFallback: false,
  cloudAcked: [],
  autoSend: true,
  bargeIn: true,
  vadThreshold: 0.5,
  wakeWord: { enabled: false, phrase: '', windowSec: 8 },
};

const desktopState = {
  scopes: [],
  policies: {},
  localOnly: false,
  cloudAcked: [],
  tools: [{ name: 'fs_list', danger: 'read', policy: 'always', locked: false }],
  pending: [],
};

function fakeVoice() {
  const senders: VoiceSender[] = [];
  return {
    senders,
    state: jest.fn(() => ({
      settings: voiceSettings,
      platform: 'darwin-arm64',
      assets: [],
      cli: null,
      readiness: { ok: true, local: false },
      vadReady: false,
      providers: [],
      activity: 'idle',
    })),
    setSettings: jest.fn((p: object) => ({ ...voiceSettings, ...p })),
    ackCloud: jest.fn(() => voiceSettings),
    download: jest.fn(async () => ({ ok: true })),
    cancel: jest.fn(() => true),
    remove: jest.fn(() => true),
    vadOpen: jest.fn(async (wc: VoiceSender) => {
      senders.push(wc);
      return { kind: 'silero' as const, handle: `${wc.id}:1` };
    }),
    vadProb: jest.fn(async () => 0.75),
    vadClose: jest.fn(),
    transcribeResult: jest.fn(async () => ({ ok: true as const, text: 'hello' })),
    reportActivity: jest.fn(() => true),
    sendToChat: jest.fn(async () => undefined),
    setVolcKey: jest.fn(() => ({ ok: true })),
    clearVolcKey: jest.fn(() => true),
    volcTest: jest.fn(async () => ({ ok: true, message: 'ok' })),
    streamStart: jest.fn((wc: VoiceSender) => {
      senders.push(wc);
      return { ok: true as const, id: `${wc.id}:9` };
    }),
    streamPush: jest.fn(() => true),
    streamStop: jest.fn(async () => ({ ok: true as const, text: 'done' })),
    streamCancel: jest.fn(() => true),
  };
}

function fakeDesktop() {
  return {
    state: jest.fn(() => desktopState),
    grantFolder: jest.fn(async () => ({
      id: 's1',
      path: '/w',
      mode: 'read',
      kind: 'folder',
      grantedAt: 1,
    })),
    revokeScope: jest.fn(() => true),
    setToolPolicy: jest.fn(() => true),
    setLocalOnly: jest.fn(() => true),
    auditList: jest.fn(() => []),
    clearAudit: jest.fn(() => true),
    journalList: jest.fn(() => []),
    undoLast: jest.fn(async () => ({ ok: false, error: 'nothing' })),
    resetAll: jest.fn(() => true),
    resetCloudAcks: jest.fn(() => true),
    remindersList: jest.fn(() => []),
    createReminder: jest.fn(() => null),
    updateReminder: jest.fn(() => null),
    cancelReminder: jest.fn(() => true),
    snoozeReminder: jest.fn(() => true),
    answerConfirm: jest.fn(),
    dropFile: jest.fn(),
    reminderAction: jest.fn(),
    takeMissedFor: jest.fn(() => [{ id: 'r1', text: 'water', dueAt: 5 }]),
  };
}

const MASCOT: CallerContext = { surface: 'mascot', trusted: true, id: '7' };
const CHAT: CallerContext = { surface: 'chat', trusted: true, id: '8' };

function setup() {
  const services: ContractServices = createContractServices();
  const voice = fakeVoice();
  const desktop = fakeDesktop();
  const screen = { checkSend: jest.fn(async () => 'local_only' as const) };
  const config = {
    get: jest.fn(() => ({ enabled: true, volume: 0.5 })),
    set: jest.fn(),
    save: jest.fn(async () => undefined),
  };
  const windowManager = {
    openProviderPanel: jest.fn(async () => undefined),
    getMainWindow: () => null,
    getAiChatWindow: () => null,
  };
  Object.assign(services, { voice, desktop, screen, config, windowManager });
  const deps: ContractDeps = {
    services,
    ports: {} as HostPorts,
    events: createRecordingAppEvents(),
    logger,
  };
  const app = createAppRouter({ deps });
  const server = createInProcessServer();
  const stop = server.serve(app.router as never);
  const clients: Array<{ disconnect(): void }> = [];
  const connect = (caller: CallerContext) => {
    const transport = server.connect(caller);
    clients.push(transport);
    return createClient(app.router.contract, transport, { handshake: 'off' });
  };
  return {
    voice,
    desktop,
    screen,
    config,
    windowManager,
    router: app.router,
    connect,
    close: () => {
      for (const c of clients) c.disconnect();
      stop();
    },
  };
}

describe('media handlers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('voice.*：委派给 VoiceService，入参改成具名对象', async () => {
    const t = setup();
    const api = t.connect(CHAT);
    try {
      expect((await api.voice.state()).activity).toBe('idle');
      expect((await api.voice.setSettings({ autoSend: false })).autoSend).toBe(false);
      expect(t.voice.setSettings).toHaveBeenCalledWith({ autoSend: false });
      await expect(api.voice.download({ id: 'ggml-base' })).resolves.toEqual({ ok: true });
      expect(t.voice.download).toHaveBeenCalledWith('ggml-base');
      const wav = new Uint8Array([1, 2, 3]);
      await expect(api.voice.transcribe({ wav, source: 'chat' })).resolves.toEqual({
        ok: true,
        text: 'hello',
      });
      expect(t.voice.transcribeResult).toHaveBeenCalledWith(wav, {
        source: 'chat',
        purpose: undefined,
      });
      await api.voice.activity({ activity: 'listening', source: 'chat:ptt' });
      expect(t.voice.reportActivity).toHaveBeenCalledWith('listening', 'chat:ptt');
      await api.voice.sendToChat({ text: 'x'.repeat(5000) });
      expect(t.voice.sendToChat).toHaveBeenCalledWith('x'.repeat(4000));
      await expect(api.voice.volcSetKey({ key: 'k' })).resolves.toEqual({ ok: true });
    } finally {
      t.close();
    }
  });

  it('VAD：会话归属调用方窗口（webContents id），帧以字节传入', async () => {
    const t = setup();
    const api = t.connect(MASCOT);
    try {
      await expect(api.voice.vadOpen()).resolves.toEqual({ kind: 'silero', handle: '7:1' });
      expect(t.voice.senders[0]!.id).toBe(7);
      const frame = new Uint8Array(new Float32Array([0.1, 0.2]).buffer);
      await expect(api.voice.vadProb({ handle: '7:1', frame })).resolves.toBe(0.75);
      expect(t.voice.vadProb).toHaveBeenCalledWith(7, '7:1', frame);
      await api.voice.vadClose({ handle: '7:1' });
      expect(t.voice.vadClose).toHaveBeenCalledWith(7, '7:1');
    } finally {
      t.close();
    }
  });

  it('voice.streamStart：首条 chunk 是启动结果，临时结果只进这条流，stop 之后流结束', async () => {
    const t = setup();
    const api = t.connect(CHAT);
    try {
      const s = api.voice.streamStart({ source: 'chat' });
      const it = s[Symbol.asyncIterator]();
      await expect(it.next()).resolves.toEqual({
        done: false,
        value: { type: 'start', ok: true, id: '8:9' },
      });
      const wc = t.voice.senders[0]!;
      expect(wc.id).toBe(8);
      wc.send('ai:voice:stream', { id: '8:9', type: 'partial', text: '你好' });
      wc.send('ai:voice:stream', { id: 'other', type: 'partial', text: 'x' });
      await expect(it.next()).resolves.toEqual({
        done: false,
        value: { id: '8:9', type: 'partial', text: '你好' },
      });
      await expect(api.voice.streamPush({ id: '8:9', pcm: new Uint8Array(4) })).resolves.toBe(true);
      await expect(api.voice.streamStop({ id: '8:9' })).resolves.toEqual({
        ok: true,
        text: 'done',
      });
      await expect(it.next()).resolves.toMatchObject({ done: true });
      expect(openVoiceStreamCount()).toBe(0);
    } finally {
      t.close();
    }
  });

  it('voice.streamStart：启动失败只发一条结果就结束；视图放弃流时撤销会话', async () => {
    const t = setup();
    const api = t.connect(CHAT);
    try {
      t.voice.streamStart.mockReturnValueOnce({
        ok: false,
        code: 'no_provider',
        error: 'no key',
      } as never);
      const chunks: unknown[] = [];
      for await (const c of api.voice.streamStart({ source: 'chat' })) chunks.push(c);
      expect(chunks).toEqual([{ type: 'start', ok: false, code: 'no_provider', error: 'no key' }]);

      const s = api.voice.streamStart({ source: 'chat' });
      const it = s[Symbol.asyncIterator]();
      await it.next();
      await it.return?.();
      for (let i = 0; i < 20 && !t.voice.streamCancel.mock.calls.length; i++)
        await new Promise((r) => setTimeout(r, 0));
      expect(t.voice.streamCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 8 }), '8:9');
      expect(openVoiceStreamCount()).toBe(0);
    } finally {
      t.close();
    }
  });

  it('看板娘旧语音设置：读 / 合并保存 config.voiceSettings，只给看板娘窗口', async () => {
    const t = setup();
    const mascot = t.connect(MASCOT);
    const chat = t.connect(CHAT);
    try {
      await expect(mascot.voice.getMascotSettings()).resolves.toEqual({
        enabled: true,
        volume: 0.5,
      });
      await mascot.voice.saveMascotSettings({ sfxEnabled: false });
      expect(t.config.set).toHaveBeenCalledWith('voiceSettings', {
        enabled: true,
        volume: 0.5,
        sfxEnabled: false,
      });
      await expect(chat.voice.getMascotSettings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      t.close();
    }
  });

  it('tts.*：委派给 TtsService；对话窗口的配置过程看板娘调不了，反之亦然', async () => {
    const t = setup();
    const chat = t.connect(CHAT);
    const mascot = t.connect(MASCOT);
    try {
      await expect(chat.tts.getConfig()).resolves.toMatchObject({ provider: 'edge' });
      await chat.tts.saveConfig({ provider: 'edge', enabled: true });
      expect(fakeTts.saveConfig).toHaveBeenCalledWith({ provider: 'edge', enabled: true });
      await expect(chat.tts.voices()).resolves.toMatchObject({ source: 'builtin' });
      await expect(chat.tts.reply({ op: 'say', id: 'r', text: 'hi' })).resolves.toBe(true);
      await expect(chat.tts.stop()).resolves.toBe(true);
      await expect(mascot.tts.stop()).resolves.toBe(true);
      await expect(mascot.tts.speak({ text: 'hi' })).resolves.toMatchObject({ via: 'none' });
      await expect(mascot.tts.promptVoice()).resolves.toBe(false);
      await expect(mascot.tts.health()).resolves.toEqual({ success: true, message: 'ok' });
      await expect(mascot.tts.getConfig()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(chat.tts.speak({ text: 'hi' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      t.close();
    }
  });

  it('tts.saveConfig：服务拒绝时抛出原因', async () => {
    const t = setup();
    const chat = t.connect(CHAT);
    try {
      fakeTts.saveConfig.mockImplementationOnce(() => {
        throw new Error('TTS config invalid: provider');
      });
      await expect(chat.tts.saveConfig({ provider: 'x' })).rejects.toMatchObject({
        message: 'TTS config invalid: provider',
      });
    } finally {
      t.close();
    }
  });

  it('desktop.*：委派给 DesktopService；看板娘专用的操作带上调用方窗口 id', async () => {
    const t = setup();
    const chat = t.connect(CHAT);
    const mascot = t.connect(MASCOT);
    try {
      await expect(chat.desktop.state()).resolves.toMatchObject({ localOnly: false });
      await expect(chat.desktop.grant({ mode: 'read' })).resolves.toMatchObject({ id: 's1' });
      expect(t.desktop.grantFolder).toHaveBeenCalledWith('read');
      await chat.desktop.setPolicy({ tool: 'fs_list', policy: 'ask' });
      expect(t.desktop.setToolPolicy).toHaveBeenCalledWith('fs_list', 'ask');
      await chat.desktop.setLocalOnly({ value: true });
      expect(t.desktop.setLocalOnly).toHaveBeenCalledWith(true);
      await chat.desktop.audit({ limit: 50 });
      expect(t.desktop.auditList).toHaveBeenCalledWith(50);
      await chat.desktop.remindersUpdate({ id: 'r1', patch: { repeat: null } });
      expect(t.desktop.updateReminder).toHaveBeenCalledWith('r1', { repeat: null });
      await chat.desktop.remindersSnooze({ id: 'r1', minutes: 5 });
      expect(t.desktop.snoozeReminder).toHaveBeenCalledWith('r1', 5);

      await mascot.desktop.confirmAnswer({ id: 'c1', allow: true, remember: false });
      expect(t.desktop.answerConfirm).toHaveBeenCalledWith(7, 'c1', true, false);
      await mascot.desktop.reminderAction({ id: 'r1', action: 'snooze', minutes: 10 });
      expect(t.desktop.reminderAction).toHaveBeenCalledWith(7, 'r1', 'snooze', 10);
      await expect(mascot.desktop.takeMissedReminders()).resolves.toEqual([
        { id: 'r1', text: 'water', dueAt: 5 },
      ]);
      expect(t.desktop.takeMissedFor).toHaveBeenCalledWith(7);
    } finally {
      t.close();
    }
  });

  it('守卫：对话窗口不能答复确认；不可信调用者不能授权 / 改策略 / 确认云端', async () => {
    const t = setup();
    const chat = t.connect(CHAT);
    const untrusted = t.connect({ surface: 'mascot', trusted: false, id: '7' });
    try {
      await expect(
        chat.desktop.confirmAnswer({ id: 'c1', allow: true, remember: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const call of [
        () => untrusted.desktop.confirmAnswer({ id: 'c1', allow: true, remember: true }),
        () => untrusted.desktop.grant({ mode: 'read-write' }),
        () => untrusted.desktop.setPolicy({ tool: 'fs_trash', policy: 'always' }),
        () => untrusted.desktop.setLocalOnly({ value: false }),
        () => untrusted.desktop.resetAll(),
        () => untrusted.voice.ackCloud(),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(t.desktop.answerConfirm).not.toHaveBeenCalled();
      expect(t.desktop.grantFolder).not.toHaveBeenCalled();
      expect(t.voice.ackCloud).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('拖入文件不在契约里：看板娘页面里的脚本不能经契约提交任意路径', async () => {
    const t = setup();
    try {
      await expect(
        t.router.call('desktop.dropFile', { path: '~/.ssh/id_rsa' }, { caller: MASCOT }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(t.desktop.dropFile).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  });

  it('screen.checkSend 与 nav.openVoiceSettings', async () => {
    const t = setup();
    const chat = t.connect(CHAT);
    const mascot = t.connect(MASCOT);
    try {
      await expect(chat.screen.checkSend()).resolves.toBe('local_only');
      await mascot.nav.openVoiceSettings();
      expect(t.windowManager.openProviderPanel).toHaveBeenCalledWith('ai:settings:open-voice');
      await expect(chat.nav.openVoiceSettings()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      t.close();
    }
  });

  it('服务缺失时 UNAVAILABLE', async () => {
    const services = createContractServices();
    const app = createAppRouter({
      deps: { services, ports: {} as HostPorts, events: createRecordingAppEvents(), logger },
    });
    const server = createInProcessServer();
    const stop = server.serve(app.router as never);
    const transport = server.connect(CHAT);
    const api = createClient(app.router.contract, transport, { handshake: 'off' });
    try {
      await expect(api.voice.state()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(api.desktop.state()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(api.screen.checkSend()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      transport.disconnect();
      stop();
    }
  });
});

describe('media event bridge', () => {
  it('旧通道都在合并表里，且映射到契约事件', () => {
    for (const [channel, entry] of Object.entries(mediaEventBridge)) {
      expect(APP_EVENT_BRIDGE[channel]).toBe(entry);
    }
    expect(Object.keys(mediaEventBridge).sort()).toEqual(
      [
        'ai:voice:changed',
        'ai:voice:progress',
        'ai:voice:activity',
        'ai:voice:bargeIn',
        'ai:voice:inject',
        'voice-settings:changed',
        'ai:desktop:changed',
        'ai:desktop:p2-changed',
        'ai:desktop:summary',
        'desktop:confirm-request',
        'desktop:confirm-cancel',
        'desktop:bubble',
        'desktop:reminder',
        'ai:desktop:open-panel',
        'ai:hub:open-schedule',
        'ai:settings:open-voice',
      ].sort(),
    );
  });

  it('服务发布旧通道：旧通道照常送达，订阅了的窗口收到契约事件（payload 过 schema）', async () => {
    const t = setup();
    const inner = createRecordingAppEvents();
    const bridge = createContractEventBridge(inner, APP_EVENT_BRIDGE, logger);
    const detach = bridge.attach(t.router.events);
    const mascot = t.connect(MASCOT);
    const got: unknown[] = [];
    const offs = [
      mascot.on('desktop.bubble', (p) => got.push(['bubble', p])),
      mascot.on('desktop.confirmCancel', (p) => got.push(['cancel', p])),
      mascot.on('voice.changed', (p) => got.push(['changed', p])),
      mascot.on('desktop.reminder', (p) => got.push(['reminder', p])),
    ];
    try {
      await new Promise((r) => setTimeout(r, 0));
      bridge.publish('desktop:bubble', { text: 'hi', voice: 'cue' }, { surface: 'mascot' });
      bridge.publish('desktop:confirm-cancel', 'c1', { surface: 'mascot' });
      bridge.publish('ai:voice:changed', null);
      bridge.publish('desktop:reminder', { id: 'r', text: 't', dueAt: 1, missed: false });
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([
        ['bubble', { text: 'hi', voice: 'cue' }],
        ['cancel', 'c1'],
        ['changed', null],
        ['reminder', { id: 'r', text: 't', dueAt: 1, missed: false }],
      ]);
      expect(inner.published.map((e) => e.channel)).toEqual([
        'desktop:bubble',
        'desktop:confirm-cancel',
        'ai:voice:changed',
        'desktop:reminder',
      ]);
      expect(bridge.contractEventOf('ai:settings:open-voice')).toBe('nav.voiceSettingsRequested');
    } finally {
      offs.forEach((f) => f());
      detach();
      t.close();
    }
  });
});
