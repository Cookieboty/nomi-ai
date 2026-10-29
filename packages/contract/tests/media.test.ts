/**
 * D1（media）：voice / tts / desktop / screen / nav 的过程与事件
 * （docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 */

import { describe, expect, it } from 'vitest';

import { appContract, mediaEvents, mediaProcedures } from '../src/app';
import { createTestClient } from '../src/testing';

const NAMESPACES = ['voice', 'tts', 'desktop', 'screen', 'nav'];

type Def = { kind: string; surfaces?: readonly string[]; dangerous?: boolean };

describe('media 契约', () => {
  it('过程名 / kind / surfaces / dangerous', () => {
    const table = Object.entries(mediaProcedures).map(([name, def]) => {
      const d = def as Def;
      const flags = d.dangerous ? ' dangerous' : '';
      return `${name} ${d.kind} ${d.surfaces?.join('|') ?? '*'}${flags}`;
    });
    expect(table).toMatchSnapshot();
    expect(Object.keys(mediaEvents)).toMatchSnapshot();
  });

  it('只用本域命名空间，驼峰、不带连字符', () => {
    for (const name of [...Object.keys(mediaProcedures), ...Object.keys(mediaEvents)]) {
      expect(NAMESPACES).toContain(name.split('.')[0]);
      expect(name).toMatch(/^[a-z]+\.[a-z][A-Za-z0-9]*$/);
    }
  });

  it('回答确认 / 授予权限的过程是 dangerous；只在一个 preload 里的过程限定界面', () => {
    const entries = Object.entries(mediaProcedures) as Array<[string, Def]>;
    expect(
      entries
        .filter(([, d]) => d.dangerous)
        .map(([n]) => n)
        .sort(),
    ).toEqual([
      'desktop.confirmAnswer',
      'desktop.grant',
      'desktop.resetAll',
      'desktop.setLocalOnly',
      'desktop.setPolicy',
      'voice.ackCloud',
    ]);
    const only = (surface: string) =>
      entries
        .filter(([, d]) => d.surfaces?.length === 1 && d.surfaces[0] === surface)
        .map(([n]) => n)
        .sort();
    expect(only('mascot')).toEqual([
      'desktop.confirmAnswer',
      'desktop.reminderAction',
      'desktop.takeMissedReminders',
      'nav.openVoiceSettings',
      'tts.health',
      'tts.promptVoice',
      'tts.speak',
      'voice.getMascotSettings',
      'voice.saveMascotSettings',
    ]);
    expect(only('chat')).toEqual([
      'tts.getConfig',
      'tts.preview',
      'tts.reply',
      'tts.resetConfig',
      'tts.saveConfig',
      'tts.status',
      'tts.testConnection',
      'tts.voices',
      'voice.takePendingInject',
    ]);
    // ai:voice:* / ai:desktop:* / ai:screen:* 在 aiIPC 上（两个窗口都有）；tts:stop 两个 preload 都有
    for (const name of ['voice.state', 'desktop.state', 'screen.checkSend', 'tts.stop']) {
      expect(mediaProcedures[name as keyof typeof mediaProcedures]).not.toHaveProperty('surfaces');
    }
  });

  it('schema 接受旧形状、拒绝错误值', () => {
    const p = appContract.procedures;
    const wav = new Uint8Array(48);
    expect(p['voice.transcribe'].input.safeParse({ wav, source: 'chat' }).success).toBe(true);
    expect(p['voice.transcribe'].input.safeParse({ wav: [1, 2], source: 'chat' }).success).toBe(
      false,
    );
    expect(
      p['voice.transcribe'].input.safeParse({ wav, source: 'chat', purpose: 'dictate' }).success,
    ).toBe(false);
    expect(p['voice.vadProb'].input.safeParse({ handle: '1:1', frame: wav }).success).toBe(true);
    expect(p['voice.streamPush'].input.safeParse({ id: '1:1', pcm: 'AAAA' }).success).toBe(false);
    expect(p['voice.setSettings'].input.safeParse({ autoSend: true, extra: 1 }).success).toBe(true);
    expect(p['voice.setSettings'].input.safeParse({ autoSend: 'yes' }).success).toBe(false);
    expect(
      p['voice.transcribe'].output.safeParse({ ok: false, code: 'local_only', error: 'x' }).success,
    ).toBe(true);
    expect(
      p['voice.transcribe'].output.safeParse({ ok: false, code: 'weird', error: 'x' }).success,
    ).toBe(false);
    expect(
      p['voice.streamStart'].chunk.safeParse({ type: 'start', ok: true, id: 'a' }).success,
    ).toBe(true);
    expect(
      p['voice.streamStart'].chunk.safeParse({ type: 'partial', id: 'a', text: '你' }).success,
    ).toBe(true);
    expect(p['voice.streamStart'].chunk.safeParse({ type: 'final', id: 'a' }).success).toBe(false);

    expect(p['tts.reply'].input.safeParse({ op: 'say', id: 'm', text: 'hi' }).success).toBe(true);
    expect(p['tts.reply'].input.safeParse({ op: 'stop' }).success).toBe(true);
    expect(p['tts.reply'].input.safeParse({ op: 'say', id: 'm' }).success).toBe(false);
    expect(p['tts.saveConfig'].input.safeParse({ provider: 'edge', rate: -5, x: 1 }).success).toBe(
      true,
    );
    expect(p['tts.saveConfig'].input.safeParse({ rate: -5 }).success).toBe(false);
    expect(p['tts.health'].input.safeParse(undefined).success).toBe(true);
    expect(
      p['tts.getConfig'].output.safeParse({
        enabled: true,
        provider: 'polly',
        lastModified: 0,
      }).success,
    ).toBe(true);

    expect(p['desktop.grant'].input.safeParse({ mode: 'read-write' }).success).toBe(true);
    expect(p['desktop.grant'].input.safeParse({ mode: 'write' }).success).toBe(false);
    expect(
      p['desktop.remindersCreate'].input.safeParse({
        text: '喝水',
        inMinutes: 10,
        repeat: { kind: 'weekly', days: [1, 3] },
      }).success,
    ).toBe(true);
    expect(
      p['desktop.remindersCreate'].input.safeParse({ text: 'x', repeat: { kind: 'yearly' } })
        .success,
    ).toBe(false);
    expect(
      p['desktop.remindersUpdate'].input.safeParse({ id: 'r1', patch: { repeat: null } }).success,
    ).toBe(true);
    expect(p['desktop.reminderAction'].input.safeParse({ id: 'r1', action: 'later' }).success).toBe(
      false,
    );
    // 视图不能提交路径：拖入文件只经 preload（nomiHost.dropFile）
    expect(p).not.toHaveProperty('desktop.dropFile');
    expect(p['screen.checkSend'].output.safeParse('ok').success).toBe(true);
    expect(p['screen.checkSend'].output.safeParse('denied').success).toBe(false);

    const ev = appContract.events;
    expect(ev['voice.changed'].safeParse(null).success).toBe(true);
    expect(ev['desktop.confirmCancel'].safeParse('c1').success).toBe(true);
    expect(ev['desktop.bubble'].safeParse({ text: 'hi', voice: 'cue', kind: 'done' }).success).toBe(
      true,
    );
    expect(ev['desktop.bubble'].safeParse({ voice: 'cue' }).success).toBe(false);
  });

  it('往返（strict 序列化）：二进制、流式识别、看板娘专用过程与事件', async () => {
    const { api, router, close } = createTestClient(
      appContract,
      {
        'voice.transcribe': ({ wav, source }) => ({
          ok: true,
          text: `${source}:${wav.byteLength}`,
        }),
        'voice.streamStart': async function* ({ source }) {
          yield { type: 'start' as const, ok: true as const, id: `${source}:1` };
          yield { type: 'partial' as const, id: `${source}:1`, text: '你' };
        },
        'desktop.takeMissedReminders': () => [{ id: 'r1', text: '喝水', dueAt: 1 }],
        'tts.speak': ({ text }) => ({ success: true, audioBase64: text, via: 'edge' }),
      },
      { caller: { surface: 'mascot', trusted: true } },
    );
    try {
      await expect(
        api.voice.transcribe({ wav: new Uint8Array(100), source: 'mascot' }),
      ).resolves.toEqual({ ok: true, text: 'mascot:100' });
      const chunks: unknown[] = [];
      for await (const c of api.voice.streamStart({ source: 'm' })) chunks.push(c);
      expect(chunks).toEqual([
        { type: 'start', ok: true, id: 'm:1' },
        { type: 'partial', id: 'm:1', text: '你' },
      ]);
      await expect(api.desktop.takeMissedReminders()).resolves.toEqual([
        { id: 'r1', text: '喝水', dueAt: 1 },
      ]);
      await expect(api.tts.speak({ text: 'QQ==' })).resolves.toMatchObject({ via: 'edge' });
      await expect(api.tts.getConfig()).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const got: unknown[] = [];
      const off = api.on('desktop.reminder', (r) => got.push(r));
      await new Promise((r) => setTimeout(r, 0));
      router.events.publish('desktop.reminder', { id: 'r2', text: 't', dueAt: 2, missed: false });
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([{ id: 'r2', text: 't', dueAt: 2, missed: false }]);
      off();
    } finally {
      close();
    }
  });

  it('dangerous：不可信调用者被拒绝', async () => {
    const { api, close } = createTestClient(
      appContract,
      { 'desktop.confirmAnswer': () => undefined, 'voice.ackCloud': () => ({}) as never },
      { caller: { surface: 'mascot', trusted: false } },
    );
    try {
      await expect(
        api.desktop.confirmAnswer({ id: 'c', allow: true, remember: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.voice.ackCloud()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      close();
    }
  });
});
