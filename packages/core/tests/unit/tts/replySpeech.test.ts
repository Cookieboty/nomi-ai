import { REPLY_SPEECH_MAX_CHARS, ReplySpeechStream } from '@nomi-ai/types';

import { canReadReplies, replySpeechCommand } from '../../../src/tts/replySpeech';

const cfg = (o: Record<string, unknown> = {}) =>
  ({ enabled: true, provider: 'edge', readReplies: true, ...o }) as never;

const run = (chunks: string[]) => {
  const s = new ReplySpeechStream();
  const out: string[] = [];
  for (const c of chunks) out.push(...s.push(c));
  out.push(...s.finish());
  return out;
};

describe('ReplySpeechStream', () => {
  it('streams whole sentences as they complete', () => {
    const s = new ReplySpeechStream();
    expect(s.push('你好，我是诺')).toEqual([]);
    expect(s.push('米。今天')).toEqual(['你好，我是诺米。']);
    expect(s.push('天气不错！')).toEqual(['今天天气不错！']);
    expect(s.finish()).toEqual([]);
  });

  it('flushes the trailing half sentence on finish', () => {
    expect(run(['好的', '，马上'])).toEqual(['好的，马上']);
  });

  it('holds back and drops code fences and thinking blocks', () => {
    const s = new ReplySpeechStream();
    expect(s.push('<think>先想一想。')).toEqual([]);
    expect(s.push('嗯。</think>答案在这里。```js\nconst a = 1;\n')).toEqual(['答案在这里。']);
    expect(s.push('console.log(a);\n```\n说完了。')).toEqual(['说完了。']);
  });

  it('filters markdown, links and tables', () => {
    const out = run([
      '## 标题\n**重点**看 [文档](https://example.com/x) 。\n',
      '| a | b |\n|---|---|\n| 1 | 2 |\n结束。',
    ]).join('');
    expect(out).not.toMatch(/https?:|\*\*|##|\|/);
    expect(out).toContain('重点');
    expect(out).toContain('文档');
    expect(out).toContain('结束');
  });

  it(`caps long replies at about ${REPLY_SPEECH_MAX_CHARS} characters (whole sentences)`, () => {
    const s = new ReplySpeechStream();
    const out: string[] = [];
    for (let i = 0; i < 100; i++) out.push(...s.push('这是一句测试用的话。'));
    out.push(...s.finish());
    const total = out.join('').length;
    expect(total).toBeGreaterThanOrEqual(REPLY_SPEECH_MAX_CHARS);
    expect(total).toBeLessThan(REPLY_SPEECH_MAX_CHARS + 20);
    expect(s.done).toBe(true);
    expect(s.push('还有。')).toEqual([]);
  });
});

describe('replySpeechCommand gating', () => {
  it('forwards say/end when the realtime engine can read replies', () => {
    expect(replySpeechCommand({ op: 'say', id: 'a', text: '你好。' }, cfg(), {})).toEqual({
      type: 'reply-speech',
      op: 'say',
      id: 'a',
      text: '你好。',
    });
    expect(replySpeechCommand({ op: 'end', id: 'a' }, cfg(), {})).toMatchObject({ op: 'end' });
  });

  it('is silent with CD_TTS=off, the switch off, or no usable engine', () => {
    const say = { op: 'say', id: 'a', text: '你好。' };
    expect(replySpeechCommand(say, cfg(), { CD_TTS: 'off' })).toBeNull();
    expect(replySpeechCommand(say, cfg({ readReplies: false }), {})).toBeNull();
    expect(replySpeechCommand(say, cfg({ provider: 'none' }), {})).toBeNull();
    expect(replySpeechCommand(say, cfg({ enabled: false }), {})).toBeNull();
    expect(canReadReplies(cfg({ readReplies: undefined }))).toBe(true);
  });

  it('always forwards stop (interrupts must work even after switching off)', () => {
    expect(
      replySpeechCommand({ op: 'stop' }, cfg({ readReplies: false }), { CD_TTS: 'off' }),
    ).toMatchObject({ type: 'reply-speech', op: 'stop' });
  });

  it('rejects malformed messages', () => {
    expect(replySpeechCommand({ op: 'say', text: 'x' }, cfg(), {})).toBeNull();
    expect(replySpeechCommand({ op: 'nope', id: 'a' }, cfg(), {})).toBeNull();
    expect(replySpeechCommand(null, cfg(), {})).toBeNull();
  });
});
