import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mascot/characterVoice', () => ({ resolvePrefsForCharacter: () => ({}) }));
vi.mock('../../src/mascot/presence', () => ({ isMascotMuted: () => false }));
vi.mock('../../src/mascot/tts/audioPlayback', () => ({
  playSynthesized: vi.fn(),
  stopSpeaking: vi.fn(),
}));

import { ReplySpeechQueue } from '../../src/mascot/tts/replySpeech';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup(muted = false) {
  const synthed: string[] = [];
  const played: string[] = [];
  const finishers: Array<(how: 'ended' | 'interrupted') => void> = [];
  const stopAudio = vi.fn();
  const q = new ReplySpeechQueue({
    synth: async (text) => {
      synthed.push(text);
      return {
        success: true,
        audioBase64: encodeURIComponent(text),
        mimeType: 'audio/mpeg',
      } as never;
    },
    play: (r) => {
      played.push(decodeURIComponent(r.audioBase64!));
      return { done: new Promise((res) => finishers.push(res)) };
    },
    stopAudio,
    volume: () => 0.8,
    muted: () => muted,
  });
  return { q, synthed, played, finishers, stopAudio };
}

describe('ReplySpeechQueue', () => {
  it('plays sentences in order and prefetches the next one', async () => {
    const t = setup();
    t.q.handle({ op: 'say', id: 'r1', text: '一。' });
    t.q.handle({ op: 'say', id: 'r1', text: '二。' });
    t.q.handle({ op: 'say', id: 'r1', text: '三。' });
    await flush();
    expect(t.played).toEqual(['一。']);
    expect(t.synthed).toEqual(['一。', '二。']); // 预取下一句，不多合成
    t.finishers[0]!('ended');
    await flush();
    expect(t.played).toEqual(['一。', '二。']);
    expect(t.synthed).toEqual(['一。', '二。', '三。']);
  });

  it('stop interrupts immediately and drops the queue', async () => {
    const t = setup();
    t.q.handle({ op: 'say', id: 'r1', text: '一。' });
    t.q.handle({ op: 'say', id: 'r1', text: '二。' });
    await flush();
    t.q.handle({ op: 'stop', id: 'r1' });
    expect(t.stopAudio).toHaveBeenCalled();
    t.finishers[0]!('interrupted');
    await flush();
    expect(t.played).toEqual(['一。']);
    expect(t.q.pending).toBe(0);
  });

  it('a new reply id replaces the old one', async () => {
    const t = setup();
    t.q.handle({ op: 'say', id: 'r1', text: '旧。' });
    t.q.handle({ op: 'say', id: 'r1', text: '旧二。' });
    await flush();
    t.q.handle({ op: 'say', id: 'r2', text: '新。' });
    await flush();
    expect(t.q.currentId).toBe('r2');
    expect(t.played).toEqual(['旧。', '新。']);
  });

  it('abandons the reply when preempted by another line', async () => {
    const t = setup();
    t.q.handle({ op: 'say', id: 'r1', text: '一。' });
    t.q.handle({ op: 'say', id: 'r1', text: '二。' });
    await flush();
    t.finishers[0]!('interrupted');
    await flush();
    expect(t.played).toEqual(['一。']);
    expect(t.q.currentId).toBeNull();
  });

  it('stays silent when muted and ignores a stale stop', async () => {
    const m = setup(true);
    m.q.handle({ op: 'say', id: 'r1', text: '一。' });
    await flush();
    expect(m.synthed).toEqual([]);
    const t = setup();
    t.q.handle({ op: 'say', id: 'r2', text: '一。' });
    await flush();
    t.q.handle({ op: 'stop', id: 'old' });
    expect(t.stopAudio).not.toHaveBeenCalled();
  });
});
