// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  splitReferenceDraft,
  useReferenceDraft,
} from '../src/components/MessageInput/useReferenceDraft';

afterEach(cleanup);
const ref = '[file.md:3-8](/work/file.md:3-8)';
const setup = (value = '') =>
  renderHook(() => {
    const [text, setText] = useState(value);
    return useReferenceDraft(text, setText);
  });
describe('rendered composer file references', () => {
  it('renders short labels for old absolute-path references and preserves the source destination', () => {
    const draft = splitReferenceDraft(
      '[/work/目录/file.md#L3-L8](/work/%E7%9B%AE%E5%BD%95/file.md#L3-L8)\n\nQuestion',
    );
    expect(draft.text).toBe('Question');
    expect(draft.references).toEqual([
      {
        href: '/work/%E7%9B%AE%E5%BD%95/file.md:3-8',
        label: 'file.md:3-8',
        markdown: '[file.md:3-8](/work/%E7%9B%AE%E5%BD%95/file.md:3-8)',
      },
    ]);
  });
  it('extracts consecutive references without exposing Markdown in the text editor', () => {
    const draft = splitReferenceDraft(`${ref}\n[second.md:9-10](/work/second.md:9-10)\n\nQuestion`);
    expect(draft.text).toBe('Question');
    expect(draft.references).toHaveLength(2);
  });
  it('appends references without replacing prose, deduplicates repeats and sends the serialized link', () => {
    const { result } = setup('Question');
    act(() => result.current.append(`${ref}\n\n`));
    act(() => result.current.append(`${ref}\n\n`));
    expect(result.current.text).toBe('Question');
    expect(result.current.references).toHaveLength(1);
    act(() => result.current.setText((current) => `${current}?`));
    expect(result.current.serialized).toBe(`${ref}\n\nQuestion?`);
    act(() => result.current.remove('/work/file.md:3-8'));
    expect(result.current.text).toBe('Question?');
    expect(result.current.references).toHaveLength(0);
  });
  it('keeps prose editing offsets independent from links, including clearing prose with a retained reference', () => {
    const { result } = setup(`${ref}\n\nQuestion`);
    act(() => result.current.setText(''));
    expect(result.current.text).toBe('');
    expect(result.current.serialized.trim()).toBe(ref);
  });
  it('keeps file-link examples inside fenced code editable as literal text', () => {
    const text = `\`\`\`markdown\n${ref}\n\`\`\``;
    expect(splitReferenceDraft(text)).toEqual({ text, references: [] });
  });
  it('leaves web links and relative links as ordinary editable Markdown', () => {
    const value = '[Web](https://example.com)\n[Relative](file.md:3-8)\nNo file reference';
    expect(splitReferenceDraft(value)).toEqual({ text: value, references: [] });
  });
});
