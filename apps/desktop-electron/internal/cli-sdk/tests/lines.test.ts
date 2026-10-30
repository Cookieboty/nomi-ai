import { describe, expect, it } from 'vitest';

import { LineSplitter } from '../src/lines';

describe('LineSplitter', () => {
  it('yields the same lines for any chunking, CRLF split across chunks included', () => {
    const text = '{"a":1}\r\n{"b":2}\n\n{"c":3}\r\ntail';
    for (let size = 1; size <= text.length; size++) {
      const s = new LineSplitter();
      const lines: string[] = [];
      for (let i = 0; i < text.length; i += size) lines.push(...s.push(text.slice(i, i + size)));
      expect(lines).toEqual(['{"a":1}', '{"b":2}', '', '{"c":3}']);
      expect(s.take()).toBe('tail');
    }
  });
});
