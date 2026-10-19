import type { SherpaModelStatus } from '@nomi-ai/types';

import { TtsModelController, type TtsModelSpeaker } from '../../../src/tts/TtsModelController';

function fakeSherpa(initialReady = false) {
  let ready = initialReady;
  let settle: { ok: () => void; fail: (e: unknown) => void } | null = null;
  const listeners: Array<(s: SherpaModelStatus) => void> = [];
  const status = (): SherpaModelStatus => ({
    modelId: 'm',
    state: ready ? 'ready' : settle ? 'downloading' : 'missing',
  });
  const sherpa: TtsModelSpeaker & { finish(): void; failWith(e: unknown): void } = {
    getStatus: status,
    isReady: () => ready,
    download: jest.fn(() => {
      if (ready) return Promise.resolve();
      return new Promise<void>((ok, fail) => {
        settle = {
          ok: () => {
            ready = true;
            settle = null;
            ok();
          },
          fail: (e) => {
            settle = null;
            fail(e);
          },
        };
      });
    }),
    cancelDownload: jest.fn(async () => {
      settle?.fail(Object.assign(new Error('download cancelled'), { code: 'superseded' }));
    }),
    deleteModel: jest.fn(async () => {
      ready = false;
      return status();
    }),
    onStatus: (fn) => {
      listeners.push(fn);
      return () => undefined;
    },
    finish: () => settle?.ok(),
    failWith: (e) => settle?.fail(e),
  };
  return { sherpa, listeners };
}

function setup(o: { voice?: boolean; ready?: boolean; sherpa?: boolean; ttsOff?: boolean } = {}) {
  const { sherpa } = fakeSherpa(o.ready);
  let voice = o.voice ?? false;
  const broadcasts: Array<{ state: string; voiceEnabled: boolean }> = [];
  const setVoice = jest.fn((v: boolean) => {
    voice = v;
  });
  const ctl = new TtsModelController({
    sherpa,
    getVoiceEnabled: () => voice,
    setVoiceEnabled: setVoice,
    usesSherpa: () => o.sherpa ?? true,
    ttsDisabled: () => o.ttsOff ?? false,
    broadcast: (s) => broadcasts.push(s),
  });
  return { ctl, sherpa, setVoice, broadcasts, voice: () => voice };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TtsModelController', () => {
  it('startup: existing user with voice on and no model → downloads automatically', () => {
    const t = setup({ voice: true });
    t.ctl.start();
    expect(t.sherpa.download).toHaveBeenCalledTimes(1);
  });

  it('startup: download failure does NOT turn voice off (not a user action)', async () => {
    const t = setup({ voice: true });
    t.ctl.start();
    t.sherpa.failWith(new Error('offline'));
    await tick();
    expect(t.voice()).toBe(true);
    expect(t.setVoice).not.toHaveBeenCalled();
  });

  it('startup: no download when voice off, model present, non-sherpa provider or CD_TTS=off', () => {
    for (const o of [
      { voice: false },
      { voice: true, ready: true },
      { voice: true, sherpa: false },
      { voice: true, ttsOff: true },
    ]) {
      const t = setup(o);
      t.ctl.start();
      expect(t.sherpa.download).not.toHaveBeenCalled();
    }
  });

  it('enable with model missing → persists on, downloads, resolves ok when done', async () => {
    const t = setup();
    const p = t.ctl.setVoiceEnabled(true);
    expect(t.voice()).toBe(true);
    expect(t.sherpa.download).toHaveBeenCalledTimes(1);
    t.sherpa.finish();
    await expect(p).resolves.toMatchObject({ ok: true, voiceEnabled: true });
  });

  it('enable → download fails → voice flipped back off with the error', async () => {
    const t = setup();
    const p = t.ctl.setVoiceEnabled(true);
    t.sherpa.failWith(new Error('HTTP 503'));
    await expect(p).resolves.toMatchObject({ ok: false, voiceEnabled: false, error: 'HTTP 503' });
    expect(t.voice()).toBe(false);
    expect(t.broadcasts.at(-1)).toMatchObject({ voiceEnabled: false });
  });

  it('enable → cancel → voice off, error "cancelled"', async () => {
    const t = setup();
    const p = t.ctl.setVoiceEnabled(true);
    await t.ctl.cancel();
    await expect(p).resolves.toMatchObject({ ok: false, error: 'cancelled' });
    expect(t.voice()).toBe(false);
  });

  it('toolbar path (alreadyPersisted) does not write again but still rolls back on failure', async () => {
    const t = setup({ voice: true });
    const p = t.ctl.setVoiceEnabled(true, true);
    expect(t.setVoice).not.toHaveBeenCalled();
    t.sherpa.failWith(new Error('x'));
    await p;
    expect(t.setVoice).toHaveBeenCalledWith(false);
  });

  it('enable with model present or non-sherpa provider → no download', async () => {
    const a = setup({ ready: true });
    await expect(a.ctl.setVoiceEnabled(true)).resolves.toMatchObject({ ok: true });
    expect(a.sherpa.download).not.toHaveBeenCalled();
    const b = setup({ sherpa: false });
    await b.ctl.setVoiceEnabled(true);
    expect(b.sherpa.download).not.toHaveBeenCalled();
  });

  it('disable just persists off', async () => {
    const t = setup({ voice: true, ready: true });
    await expect(t.ctl.setVoiceEnabled(false)).resolves.toMatchObject({ voiceEnabled: false });
    expect(t.voice()).toBe(false);
  });

  it('deleteModel turns voice off (no model → no voice)', async () => {
    const t = setup({ voice: true, ready: true });
    const st = await t.ctl.deleteModel();
    expect(st).toMatchObject({ state: 'missing', voiceEnabled: false });
  });

  it('download() (retry) never touches the voice switch', async () => {
    const t = setup({ voice: false });
    const p = t.ctl.download();
    t.sherpa.failWith(new Error('boom'));
    await expect(p).resolves.toMatchObject({ ok: false, error: 'boom' });
    expect(t.setVoice).not.toHaveBeenCalled();
  });
});
