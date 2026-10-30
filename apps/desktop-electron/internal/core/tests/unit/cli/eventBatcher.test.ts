import { EventBatcher } from '../../../src/cli/eventBatcher';

type Ev = { type: string; tabId: string; text?: string; name?: string };

describe('EventBatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('coalesces adjacent text-delta of the same tab and flushes once per interval', () => {
    const sink = jest.fn();
    const b = new EventBatcher<Ev>(sink, 16);
    for (let i = 0; i < 1000; i++) b.push({ type: 'text-delta', tabId: 'a', text: 'x' });
    expect(sink).not.toHaveBeenCalled();
    jest.advanceTimersByTime(20);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toEqual([
      { type: 'text-delta', tabId: 'a', text: 'x'.repeat(1000) },
    ]);
  });

  it('keeps ordering across tabs and event types; never merges across a tool event', () => {
    const sink = jest.fn();
    const b = new EventBatcher<Ev>(sink, 16);
    b.push({ type: 'text-delta', tabId: 'a', text: '1' });
    b.push({ type: 'tool', tabId: 'a', name: 'Read' });
    b.push({ type: 'text-delta', tabId: 'a', text: '2' });
    b.push({ type: 'text-delta', tabId: 'b', text: '3' });
    b.flush();
    expect(
      sink.mock.calls[0]![0].map((e: Ev) => `${e.tabId}:${e.type}:${e.text ?? e.name}`),
    ).toEqual(['a:text-delta:1', 'a:tool:Read', 'a:text-delta:2', 'b:text-delta:3']);
  });

  it('flush() is synchronous and idempotent; dispose flushes the remainder', () => {
    const sink = jest.fn();
    const b = new EventBatcher<Ev>(sink, 16);
    b.push({ type: 'done', tabId: 'a' });
    b.flush();
    b.flush();
    expect(sink).toHaveBeenCalledTimes(1);
    b.push({ type: 'error', tabId: 'a' });
    b.dispose();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(b.pending).toBe(0);
  });
});
