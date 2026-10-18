import { describe, expect, it } from 'vitest';

import { mergeAssistantText } from '../src/utils/textCursor';

describe('mergeAssistantText', () => {
  it('流式快照只延长，不另起一段', () => {
    const a = mergeAssistantText('', '先看', [], 'segment');
    const b = mergeAssistantText(a.text, '先看一下。', a.breaks, 'segment');
    expect(b).toEqual({ text: '先看一下。', breaks: [] });
  });

  it('后一段模型消息另起一段，已经写过的不再重复', () => {
    const a = mergeAssistantText('', '先看一下。', [], 'segment');
    const b = mergeAssistantText(a.text, '改好了。', a.breaks, 'segment');
    expect(b.text).toBe('先看一下。\n\n改好了。');
    expect(b.breaks).toEqual(['先看一下。'.length + 2]);
    const c = mergeAssistantText(b.text, '改好了。', b.breaks, 'final');
    expect(c).toEqual(b);
  });
});
