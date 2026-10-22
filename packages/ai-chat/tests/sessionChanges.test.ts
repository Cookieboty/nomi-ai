import { describe, expect, it } from 'vitest';

import type { ConvMessage } from '../src/types/conversation';
import { aggregateSessionChanges, summarizeChanges } from '../src/utils/sessionChanges';

describe('aggregateSessionChanges', () => {
  it('collects edit diffs from assistant traces', () => {
    const messages: ConvMessage[] = [
      { id: 'u1', role: 'user', text: 'edit', at: 1 },
      {
        id: 'a1',
        role: 'assistant',
        text: 'done',
        at: 2,
        trace: [
          {
            type: 'tool',
            name: 'Edit',
            status: 'done',
            input: JSON.stringify({
              file_path: 'src/a.ts',
              old_string: 'foo\n',
              new_string: 'bar\n',
            }),
          },
        ],
      },
    ];
    const changes = aggregateSessionChanges(messages);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]!.file).toContain('a.ts');
    expect(changes[0]!.added + changes[0]!.removed).toBeGreaterThan(0);
    expect(changes[0]!.letter).toMatch(/[MAD?]/);
    expect(changes[0]!.messageId).toBe('a1');
  });

  it('later write wins same path; summarize totals', () => {
    const messages: ConvMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        text: '',
        at: 1,
        trace: [
          {
            type: 'tool',
            name: 'Write',
            status: 'done',
            input: JSON.stringify({ file_path: 'f.txt', content: 'one' }),
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        text: '',
        at: 2,
        trace: [
          {
            type: 'tool',
            name: 'Write',
            status: 'done',
            input: JSON.stringify({ file_path: 'f.txt', content: 'two\nlines' }),
          },
        ],
      },
    ];
    const changes = aggregateSessionChanges(messages);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.messageId).toBe('a2');
    const s = summarizeChanges(changes);
    expect(s.files).toBe(1);
  });
});
