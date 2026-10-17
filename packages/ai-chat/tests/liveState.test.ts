import { describe, expect, it } from 'vitest';

import type { HarnessLiveEvent } from '../src/services/harnessClient';
import { applyLiveEvents, MAX_LIVE_TRACE } from '../src/utils/liveState';

const tool = (i: number, status: 'start' | 'done' = 'start'): HarnessLiveEvent => ({
  tabId: 't',
  type: 'tool',
  name: 'Read',
  status,
  id: `c${i}`,
});

describe('applyLiveEvents', () => {
  it('folds a whole batch into one new state: text appended, trace copied once', () => {
    const prev = applyLiveEvents(undefined, [{ tabId: 't', type: 'text-delta', text: 'a' }], 1000);
    const before = prev.trace;
    const next = applyLiveEvents(
      prev,
      [
        { tabId: 't', type: 'text-delta', text: 'b' },
        { tabId: 't', type: 'text-delta', text: 'c' },
        tool(1),
        tool(1, 'done'),
      ],
      2000,
    );
    expect(next).not.toBe(prev);
    expect(next.text).toBe('abc');
    expect(before).toBeUndefined();
    expect(next.trace).toHaveLength(2);
    expect(next.trace![0]).toMatchObject({ at: 2000, name: 'Read' });
    expect(next.startedAt).toBe(1000);
    expect(next.firstEventAt).toBe(1000);
  });

  it('does not mutate the previous state', () => {
    const prev = applyLiveEvents(undefined, [tool(1)], 1);
    const snapshot = JSON.stringify(prev);
    applyLiveEvents(prev, [tool(2), { tabId: 't', type: 'text-delta', text: 'x' }], 2);
    expect(JSON.stringify(prev)).toBe(snapshot);
  });

  it('caps the live trace at MAX_LIVE_TRACE, dropping the oldest events', () => {
    const batch = Array.from({ length: MAX_LIVE_TRACE + 500 }, (_, i) => tool(i));
    const next = applyLiveEvents(undefined, batch, 1);
    expect(next.trace).toHaveLength(MAX_LIVE_TRACE);
    expect((next.trace![0] as { id: string }).id).toBe('c500');
  });

  it('tracks permission and status, and clears them on activity / done', () => {
    let s = applyLiveEvents(undefined, [
      { tabId: 't', type: 'permission', id: 'p1', summary: 'Bash: ls' },
      { tabId: 't', type: 'status', kind: 'retry', attempt: 2, max: 5 },
    ]);
    expect(s.permission).toEqual({ id: 'p1', summary: 'Bash: ls' });
    expect(s.status).toMatchObject({ kind: 'retry', attempt: 2, max: 5 });
    s = applyLiveEvents(s, [{ tabId: 't', type: 'text-delta', text: 'hi' }]);
    expect(s.status).toBeUndefined();
    expect(s.firstEventAt).toBeDefined();
    s = applyLiveEvents(s, [{ tabId: 't', type: 'status', kind: 'compact' }]);
    expect(s.status?.kind).toBe('compact');
    s = applyLiveEvents(s, [{ tabId: 't', type: 'done', text: 'ok' }]);
    expect(s.permission).toBeUndefined();
    expect(s.status).toBeUndefined();
  });

  it('a batch of 20k deltas stays cheap (single string append, no array copies)', () => {
    const batch: HarnessLiveEvent[] = Array.from({ length: 20000 }, () => ({
      tabId: 't',
      type: 'text-delta' as const,
      text: 'xxxx',
    }));
    const t0 = performance.now();
    const next = applyLiveEvents(undefined, batch);
    expect(next.text.length).toBe(80000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
