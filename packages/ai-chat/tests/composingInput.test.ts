import { describe, expect, it } from 'vitest';

import { isCompositionInput } from '../src/components/MessageInput/composing';

/** 造一个只带关心的字段的 InputEvent（happy-dom 的 Event 没有 inputType / isComposing） */
const input = (fields: { isComposing?: boolean; inputType?: string }): InputEvent =>
  fields as unknown as InputEvent;

describe('isCompositionInput', () => {
  it('treats inputType insertCompositionText as composing on its own', () => {
    // WebView2 出现过的情形：组字中的 input 没带 isComposing，只看它就会吞字
    expect(
      isCompositionInput(input({ isComposing: false, inputType: 'insertCompositionText' }), false),
    ).toBe(true);
    expect(isCompositionInput(input({ inputType: 'insertCompositionText' }), false)).toBe(true);
  });

  it('treats isComposing alone as composing', () => {
    expect(isCompositionInput(input({ isComposing: true, inputType: 'insertText' }), false)).toBe(
      true,
    );
  });

  it('lets a plain insertText end a stuck composition', () => {
    expect(isCompositionInput(input({ isComposing: false, inputType: 'insertText' }), true)).toBe(
      false,
    );
    expect(
      isCompositionInput(input({ isComposing: false, inputType: 'deleteContentBackward' }), true),
    ).toBe(false);
  });

  it('falls back to the compositionstart flag only when the event says nothing', () => {
    expect(isCompositionInput(input({}), true)).toBe(true);
    expect(isCompositionInput(input({}), false)).toBe(false);
  });
});
