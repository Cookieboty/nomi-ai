import {
  buildTrace,
  compactOldTraces,
  MAX_TRACE_EVENTS,
  stampEvent,
} from '../../../src/cli/traceBuilder';
import type { HarnessEvent } from '../../../src/cli/types';

describe('traceBuilder', () => {
  it('keeps only tool / thinking events and merges consecutive thinking chunks', () => {
    const events: HarnessEvent[] = [
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: 'a' },
      { type: 'thinking', text: 'b' },
      { type: 'tool', name: 'Read', status: 'start', detail: '1' },
      { type: 'tool', name: 'Read', status: 'done', detail: '1', output: 'x' },
      { type: 'done', text: 'ok' },
    ];
    const t = buildTrace(events);
    expect(t.map((e) => e.type)).toEqual(['thinking', 'tool', 'tool']);
    expect(t[0]).toMatchObject({ text: 'ab' });
  });

  it('caps event count and drops oldest outputs when the payload is too large', () => {
    const many: HarnessEvent[] = Array.from({ length: MAX_TRACE_EVENTS + 20 }, (_, i) => ({
      type: 'tool',
      name: 'x',
      status: 'done',
      detail: String(i),
    }));
    expect(buildTrace(many)).toHaveLength(MAX_TRACE_EVENTS);
    const big: HarnessEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'tool',
      name: 'x',
      status: 'done',
      detail: String(i),
      output: 'y'.repeat(6000),
    }));
    const t = buildTrace(big);
    expect(JSON.stringify(t).length).toBeLessThanOrEqual(400_000 + 2000);
    expect((t[0] as { output?: string }).output).toBeUndefined();
    expect((t[99] as { output?: string }).output).toHaveLength(6000);
  });

  it('stampEvent adds a timestamp only to trace events', () => {
    const a = stampEvent({ type: 'tool', name: 'x', status: 'start' }, 5) as { at?: number };
    const b = stampEvent({ type: 'text', text: 'x' }, 5) as { at?: number };
    expect(a.at).toBe(5);
    expect(b.at).toBeUndefined();
  });
});

describe('compactOldTraces', () => {
  it('drops input / output bodies of older messages but keeps names, status and timing', () => {
    const mk = () => ({
      trace: [
        {
          type: 'tool' as const,
          name: 'Bash',
          status: 'done' as const,
          id: '1',
          input: '{"command":"ls"}',
          output: 'x'.repeat(100),
          at: 5,
        },
      ],
    });
    const list = Array.from({ length: 25 }, mk);
    expect(compactOldTraces(list, 20)).toBe(true);
    expect(list[0]!.trace[0]).toEqual({
      type: 'tool',
      name: 'Bash',
      status: 'done',
      id: '1',
      at: 5,
    });
    expect(list[24]!.trace[0]!.output).toHaveLength(100);
    expect(compactOldTraces(list, 20)).toBe(false);
  });
});
