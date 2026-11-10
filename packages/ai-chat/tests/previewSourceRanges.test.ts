// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import {
  sourceLineIndex,
  updatePreviewSourceRanges,
} from '../src/components/ResourcePreview/previewSourceRanges';

describe('preview source line indexing', () => {
  it('matches source offsets at LF/CRLF boundaries, including trailing newline and EOF', () => {
    for (const text of ['', 'one', 'one\n\ntwo\n', 'one\r\n\r\ntwo\r\n']) {
      const lineAt = sourceLineIndex(text);
      for (let offset = 0; offset <= text.length + 2; offset++)
        expect(lineAt(offset)).toBe(text.slice(0, offset).split('\n').length);
    }
  });
  it('maps later blocks through multiline edits without rescanning the source per block', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<p data-preview-source-start="0" data-preview-source-end="3"></p><p data-preview-source-start="7" data-preview-source-end="10"></p>';
    updatePreviewSourceRanges(root, 'a\r\nb\r\n\r\ntwo', [{ start: 0, end: 3, text: 'a\r\nb' }]);
    const blocks = root.querySelectorAll('p');
    expect(blocks[0]!.dataset.previewLineStart).toBe('1');
    expect(blocks[0]!.dataset.previewLineEnd).toBe('2');
    expect(blocks[1]!.dataset.previewLineStart).toBe('4');
    expect(blocks[1]!.dataset.previewLineEnd).toBe('4');
  });
});
