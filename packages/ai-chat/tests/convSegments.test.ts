import { describe, expect, it } from 'vitest';

import type { HarnessTraceEvent } from '../src/services/harnessClient';
import { segmentBody } from '../src/utils/convSegments';
import { reduceTrace } from '../src/utils/toolTrace';

const first = '先看一下。';
const text = `${first}\n\n改好了。`;
const at = first.length;

describe('segmentBody', () => {
  it('工具插在两段文字之间，思考跟在它发生的位置', () => {
    const trace: HarnessTraceEvent[] = [
      { type: 'thinking', text: '想', textAt: at },
      {
        type: 'tool',
        name: 'read_file',
        status: 'start',
        id: 'a',
        input: '{"path":"a.ts"}',
        textAt: at,
      },
      { type: 'tool', name: 'read_file', status: 'done', id: 'a', output: 'x' },
    ];
    const segs = segmentBody(text, reduceTrace(trace), false, 10, [at + 2]);
    expect(segs.map((s) => s.type)).toEqual(['text', 'activity', 'text']);
    expect(segs[0]).toMatchObject({ text: first });
    expect(segs[2]).toMatchObject({ text: '改好了。' });
    const items = segs[1]!.type === 'activity' ? segs[1].items : [];
    expect(items.map((i) => i.type)).toEqual(['thinking', 'call']);
  });

  it('没有位置信息的旧消息仍是工具在前', () => {
    const trace: HarnessTraceEvent[] = [
      { type: 'tool', name: 'read_file', status: 'start', id: 'a' },
      { type: 'tool', name: 'read_file', status: 'done', id: 'a', output: 'x' },
    ];
    const segs = segmentBody('结论', reduceTrace(trace));
    expect(segs.map((s) => s.type)).toEqual(['activity', 'text']);
  });

  it('没有工具的两段消息也分开', () => {
    const segs = segmentBody(text, [], false, undefined, [at + 2]);
    expect(segs).toEqual([
      { type: 'text', text: first },
      { type: 'text', text: '改好了。' },
    ]);
  });
});
