import { foldAssistantEvent, mergeAssistantText } from '../../../src/cli/textCursor';

describe('textCursor', () => {
  it('后一段另起一段，最终回复若已包含则不重复', () => {
    const a = mergeAssistantText('', '先看一下。', [], 'segment');
    const b = mergeAssistantText(a.text, '改好了。', a.breaks, 'segment');
    expect(b.breaks).toEqual(['先看一下。'.length + 2]);
    expect(mergeAssistantText(b.text, '改好了。', b.breaks, 'final').text).toBe(b.text);
  });

  it('工具记下当时的正文字符位置', () => {
    const first = foldAssistantEvent('', [], { type: 'text', text: '先看一下。' });
    const tool = foldAssistantEvent(first.text, first.breaks, {
      type: 'tool',
      name: 'Read',
      status: 'start',
    });
    expect(tool.ev).toMatchObject({ textAt: '先看一下。'.length });
    expect(tool.text).toBe(first.text);
  });
});
