import { describe, expect, it, vi } from 'vitest';

import { startReplySpeech, stopReplySpeech } from '../src/services/replySpeech';

describe('reply speech (chat side)', () => {
  it('sends whole sentences while streaming, then the rest and end', () => {
    const sink = vi.fn();
    const s = startReplySpeech('a', sink);
    s.push('你好');
    expect(sink).not.toHaveBeenCalled();
    s.push('呀。我在');
    expect(sink).toHaveBeenLastCalledWith({ op: 'say', id: 'a', text: '你好呀。' });
    s.finish();
    expect(sink.mock.calls.map((c) => c[0])).toEqual([
      { op: 'say', id: 'a', text: '你好呀。' },
      { op: 'say', id: 'a', text: '我在' },
      { op: 'end', id: 'a' },
    ]);
  });

  it('stop interrupts and nothing more is sent', () => {
    const sink = vi.fn();
    const s = startReplySpeech('b', sink);
    s.push('第一句。');
    s.stop();
    s.push('第二句。');
    s.finish();
    expect(sink.mock.calls.map((c) => c[0].op)).toEqual(['say', 'stop']);
  });

  it('a new reply or stopReplySpeech cuts off the previous one', () => {
    const sink = vi.fn();
    const s = startReplySpeech('c', sink);
    stopReplySpeech();
    s.push('不该念。');
    s.finish();
    expect(sink).not.toHaveBeenCalled();
  });
});
