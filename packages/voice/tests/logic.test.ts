import { describe, expect, it } from 'vitest';

import { encodeWav, levelOf, resampleTo16k } from '../src/audio';
import { Segmenter } from '../src/segmenter';
import { matchWakePhrase, normalizeForWake } from '../src/wake';

const frame = (v = 0) => new Float32Array(512).fill(v);

describe('audio', () => {
  it('encodes 16k mono PCM16 wav with correct header', () => {
    const w = encodeWav(new Float32Array([0, 1, -1, 0.5]));
    const td = new TextDecoder();
    expect(td.decode(w.subarray(0, 4))).toBe('RIFF');
    expect(td.decode(w.subarray(8, 12))).toBe('WAVE');
    const v = new DataView(w.buffer);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getInt16(46, true)).toBe(32767);
    expect(v.getInt16(48, true)).toBe(-32768);
    expect(w.byteLength).toBe(44 + 8);
  });
  it('resamples 48k → 16k by 3x', () => {
    expect(resampleTo16k(new Float32Array(4800), 48000).length).toBe(1600);
    const same = new Float32Array(10);
    expect(resampleTo16k(same, 16000)).toBe(same);
  });
  it('level is 0 for silence and high for loud audio', () => {
    expect(levelOf(frame(0))).toBe(0);
    expect(levelOf(frame(0.5))).toBeGreaterThan(0.8);
  });
});

describe('segmenter', () => {
  it('emits start then end with pre-roll audio after silence', () => {
    const s = new Segmenter({ minSpeechMs: 64, minSilenceMs: 96, preRollMs: 64 });
    const evs = [] as string[];
    let audioLen = 0;
    const feed = (p: number, n: number) => {
      for (let i = 0; i < n; i++)
        for (const e of s.push(frame(p), p)) {
          evs.push(e.type);
          if (e.type === 'end') audioLen = e.audio.length;
        }
    };
    feed(0, 5);
    feed(0.9, 4);
    feed(0, 4);
    expect(evs).toEqual(['start', 'end']);
    // 2 帧 pre-roll（含触发帧） + 3 帧说话 + 3 帧静音
    expect(audioLen).toBe(512 * 8);
  });
  it('treats a short blip as misfire', () => {
    const s = new Segmenter({ minSpeechMs: 200, minSilenceMs: 64 });
    const evs: string[] = [];
    for (const p of [0.9, 0, 0, 0]) for (const e of s.push(frame(), p)) evs.push(e.type);
    expect(evs).toEqual(['misfire']);
  });
  it('hysteresis keeps speech through brief dips', () => {
    const s = new Segmenter({ threshold: 0.5, minSpeechMs: 32, minSilenceMs: 96 });
    const evs: string[] = [];
    for (const p of [0.9, 0.9, 0.4, 0.4, 0.4, 0.9, 0.1, 0.1, 0.1])
      for (const e of s.push(frame(), p)) evs.push(e.type);
    expect(evs).toEqual(['start', 'end']);
  });
});

describe('wake word', () => {
  it('normalizes punctuation, case and traditional chars', () => {
    expect(normalizeForWake('妳好，诺米！')).toBe('你好诺米');
    expect(normalizeForWake('Hey, Nomi.')).toBe('heynomi');
  });
  it('matches with tolerance and returns the rest as a command', () => {
    expect(matchWakePhrase('你好诺米。', '你好，诺米')).toEqual({ matched: true, rest: '' });
    expect(matchWakePhrase('你好，诺咪，明天天气怎么样？', '你好，诺米')).toEqual({
      matched: true,
      rest: '明天天气怎么样？',
    });
    expect(matchWakePhrase('Hey nomi, open notes', 'hey nomi').rest).toBe('open notes');
  });
  it('does not match unrelated speech or phrase deep inside a sentence', () => {
    expect(matchWakePhrase('今天吃什么', '你好，诺米').matched).toBe(false);
    expect(matchWakePhrase('我刚才跟同事说了一句你好诺米', '你好，诺米').matched).toBe(false);
    expect(matchWakePhrase('', '你好，诺米').matched).toBe(false);
  });
  it('matches right after a sentence boundary (speech merged into one segment)', () => {
    expect(matchWakePhrase('刚才那个不算。你好诺米，放首歌', '你好，诺米')).toEqual({
      matched: true,
      rest: '放首歌',
    });
    expect(
      matchWakePhrase('do for your country. And so my fellow Americans.', 'and so my fellow').rest,
    ).toBe('Americans.');
  });
});
