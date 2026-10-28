/**
 * D1 对话窗口一侧：desktopClient / ttsConfigClient / screenClient / replySpeech 与语音包的契约适配
 * （hostBackends/media.ts）走契约 `desktop.*` / `tts.*` / `screen.*` / `voice.*`。
 * 假宿主用 `createTestClient(appContract, …)`（完整线协议、strict 序列化）。
 */
import type { Handlers } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createTestClient, type TestClient } from '@nomi-ai/contract/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ client: null as null | { api: unknown } }));

vi.mock('../src/services/api', () => ({
  api: new Proxy(
    {},
    {
      get(_t, key) {
        if (!host.client) throw new Error('no fake host');
        const v = (host.client.api as Record<PropertyKey, unknown>)[key];
        return typeof v === 'function'
          ? (v as (...a: unknown[]) => unknown).bind(host.client.api)
          : v;
      },
    },
  ),
  hasTransport: () => host.client !== null,
}));

import { desktopClient } from '../src/services/desktopClient';
import { contractVoiceApi } from '../src/services/hostBackends/media';
import { startReplySpeech, stopReplySpeech } from '../src/services/replySpeech';
import { screenClient } from '../src/services/screenClient';
import { DEFAULT_TTS_CONFIG, ttsConfigClient } from '../src/services/ttsConfigClient';

let current: TestClient<AppContract> | null = null;

function install(handlers: Partial<Handlers<AppContract>>): TestClient<AppContract> {
  current = createTestClient(appContract, handlers, {
    caller: { surface: 'chat', trusted: true },
  });
  host.client = current;
  return current;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  current?.close();
  current = null;
  host.client = null;
});

const state = {
  scopes: [],
  policies: { fs_list: 'always' },
  localOnly: true,
  cloudAcked: [],
  tools: [{ name: 'fs_list', danger: 'read', policy: 'always' }],
};

describe('desktopClient', () => {
  it('没有契约传输：不可用，调用报「需要桌面应用」，订阅是空操作', async () => {
    expect(desktopClient.available()).toBe(false);
    await expect(desktopClient.state()).rejects.toThrow();
    expect(typeof desktopClient.onChanged(() => undefined)).toBe('function');
  });

  it('位置参数改成具名对象；返回形状不变', async () => {
    const setPolicy = vi.fn(() => true);
    const update = vi.fn(() => null);
    const snooze = vi.fn(() => true);
    install({
      'desktop.state': () => state,
      'desktop.setPolicy': setPolicy,
      'desktop.remindersUpdate': update,
      'desktop.remindersSnooze': snooze,
      'desktop.undoLast': () => ({ ok: true, undone: 'trash a.txt' }),
      'desktop.audit': ({ limit }) => [
        { ts: limit ?? 0, tool: 'fs_list', args: {}, decision: 'auto', result: 'ok' },
      ],
    });
    expect(desktopClient.available()).toBe(true);
    await expect(desktopClient.state()).resolves.toMatchObject({ localOnly: true });
    await desktopClient.setPolicy('fs_list', 'ask');
    expect(setPolicy).toHaveBeenCalledWith({ tool: 'fs_list', policy: 'ask' }, expect.anything());
    await desktopClient.updateReminder('r1', { repeat: null });
    expect(update).toHaveBeenCalledWith({ id: 'r1', patch: { repeat: null } }, expect.anything());
    await desktopClient.snoozeReminder('r1');
    expect(snooze).toHaveBeenCalledWith({ id: 'r1', minutes: 10 }, expect.anything());
    await expect(desktopClient.undoLast()).resolves.toEqual({ ok: true, undone: 'trash a.txt' });
    await expect(desktopClient.audit()).resolves.toEqual([
      { ts: 200, tool: 'fs_list', args: {}, decision: 'auto', result: 'ok' },
    ]);
  });

  it('事件：desktop.changed / p2Changed / summary', async () => {
    const t = install({});
    const changed = vi.fn();
    const p2 = vi.fn();
    const summary = vi.fn();
    const offs = [
      desktopClient.onChanged(changed),
      desktopClient.onP2Changed(p2),
      desktopClient.onSummary(summary),
    ];
    await tick();
    t.router.events.publish('desktop.changed', state);
    t.router.events.publish('desktop.p2Changed', { kind: 'reminders' });
    t.router.events.publish('desktop.summary', { name: 'a', path: '/a', summary: 's', at: 1 });
    await tick();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ localOnly: true }));
    expect(p2).toHaveBeenCalledWith('reminders');
    expect(summary).toHaveBeenCalledWith({ name: 'a', path: '/a', summary: 's', at: 1 });
    offs.forEach((off) => off());
  });
});

describe('ttsConfigClient', () => {
  it('没有契约传输：默认配置、测试失败、其余静默', async () => {
    expect(ttsConfigClient.available()).toBe(false);
    await expect(ttsConfigClient.get()).resolves.toEqual(DEFAULT_TTS_CONFIG);
    await expect(ttsConfigClient.test(DEFAULT_TTS_CONFIG)).resolves.toEqual({
      success: false,
      message: '',
    });
    await expect(ttsConfigClient.voices()).resolves.toBeNull();
    await expect(ttsConfigClient.preview(DEFAULT_TTS_CONFIG, 'hi')).resolves.toBeNull();
  });

  it('读写配置、试听返回 data URL、保存被拒时抛出原因', async () => {
    const save = vi.fn();
    install({
      'tts.getConfig': () => ({ enabled: true, provider: 'none', lastModified: 1 }),
      'tts.saveConfig': save,
      'tts.preview': () => ({ success: true, audioBase64: 'QUJD', mimeType: 'audio/mpeg' }),
      'tts.status': () => ({ consecutiveFailures: 4 }),
      'tts.voices': () => {
        throw new Error('offline');
      },
    });
    await expect(ttsConfigClient.get()).resolves.toMatchObject({
      provider: 'none',
      promptVoice: true,
      lastModified: 1,
    });
    await ttsConfigClient.save({ ...DEFAULT_TTS_CONFIG, rate: 10 });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'edge', rate: 10 }),
      expect.anything(),
    );
    await expect(ttsConfigClient.preview(DEFAULT_TTS_CONFIG, 'hi')).resolves.toBe(
      'data:audio/mpeg;base64,QUJD',
    );
    await expect(ttsConfigClient.status()).resolves.toEqual({ consecutiveFailures: 4 });
    await expect(ttsConfigClient.voices()).resolves.toBeNull();
    save.mockImplementationOnce(() => {
      throw new Error('TTS config invalid: rate');
    });
    await expect(ttsConfigClient.save(DEFAULT_TTS_CONFIG)).rejects.toThrow(
      'TTS config invalid: rate',
    );
  });
});

describe('screenClient / replySpeech', () => {
  it('screen.checkSend', async () => {
    await expect(screenClient.checkSend()).rejects.toThrow();
    install({ 'screen.checkSend': () => 'user_denied' });
    expect(screenClient.available()).toBe(true);
    await expect(screenClient.checkSend()).resolves.toBe('user_denied');
  });

  it('朗读 AI 回复的分句经 tts.reply 发给主进程；没有传输时静默', async () => {
    stopReplySpeech(); // 没有传输：不抛错
    const reply = vi.fn(() => true);
    install({ 'tts.reply': reply });
    const sp = startReplySpeech('m1');
    sp.push('你好。');
    sp.finish();
    stopReplySpeech();
    for (let i = 0; i < 5; i++) await tick();
    expect(reply.mock.calls.map((c) => c[0])).toEqual([
      { op: 'say', id: 'm1', text: '你好。' },
      { op: 'end', id: 'm1' },
      { op: 'stop' },
    ]);
  });
});

describe('contractVoiceApi（@nomi-ai/voice 的注入实现）', () => {
  it('请求改成具名对象；VAD 帧以字节传；事件经契约订阅', async () => {
    const vadProb = vi.fn(() => 0.5);
    const transcribe = vi.fn(() => ({ ok: true as const, text: 'hi' }));
    const t = install({
      'voice.vadProb': vadProb,
      'voice.transcribe': transcribe,
      'voice.download': () => ({ ok: false, error: 'busy' }),
    });
    const v = contractVoiceApi(t.api);
    await expect(v.vadProb('8:1', new Float32Array([0.25]))).resolves.toBe(0.5);
    const frame = (vadProb.mock.calls[0] as unknown as [{ frame: Uint8Array }])[0].frame;
    expect(new Float32Array(frame.slice().buffer)[0]).toBe(0.25);
    const wav = new Uint8Array([1, 2]);
    await expect(v.transcribe(wav, 'chat')).resolves.toEqual({ ok: true, text: 'hi' });
    expect(transcribe).toHaveBeenCalledWith(
      { wav, source: 'chat', purpose: 'command' },
      expect.anything(),
    );
    await expect(v.download('m')).resolves.toEqual({ ok: false, error: 'busy' });

    const inject = vi.fn();
    const changed = vi.fn();
    const offs = [v.onInject(inject), v.onChanged(changed)];
    await tick();
    t.router.events.publish('voice.inject', { text: '你好', autoSend: true });
    t.router.events.publish('voice.changed', null);
    await tick();
    expect(inject).toHaveBeenCalledWith({ text: '你好', autoSend: true });
    expect(changed).toHaveBeenCalledTimes(1);
    offs.forEach((off) => off());
  });

  it('流式识别：streamStart 回启动结果，临时结果交给 onStream，失败原样返回', async () => {
    let push: ((c: unknown) => void) | null = null;
    let end: (() => void) | null = null;
    const t = install({
      'voice.streamStart': async function* () {
        yield { type: 'start' as const, ok: true as const, id: '8:1' };
        const queue: unknown[] = [];
        let wake: (() => void) | null = null;
        let done = false;
        push = (c) => {
          queue.push(c);
          wake?.();
        };
        end = () => {
          done = true;
          wake?.();
        };
        for (;;) {
          while (queue.length) yield queue.shift() as never;
          if (done) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
      'voice.streamStop': () => ({ ok: true as const, text: '你好' }),
    });
    const v = contractVoiceApi(t.api);
    const events: unknown[] = [];
    const off = v.onStream((e) => events.push(e));
    await expect(v.streamStart('chat')).resolves.toEqual({ ok: true, id: '8:1' });
    push!({ type: 'partial', id: '8:1', text: '你' });
    for (let i = 0; i < 5; i++) await tick();
    expect(events).toEqual([{ type: 'partial', id: '8:1', text: '你' }]);
    await expect(v.streamStop('8:1')).resolves.toEqual({ ok: true, text: '你好' });
    end!();
    off();

    t.close();
    const t2 = install({
      'voice.streamStart': async function* () {
        yield {
          type: 'start' as const,
          ok: false as const,
          code: 'local_only' as const,
          error: 'x',
        };
      },
    });
    await expect(contractVoiceApi(t2.api).streamStart('chat')).resolves.toEqual({
      ok: false,
      code: 'local_only',
      error: 'x',
    });
  });
});
