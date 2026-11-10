// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { restoreDocumentAnchor } from '../src/components/ResourcePreview/documentAnchor';

afterEach(() => vi.restoreAllMocks());
describe('lazy Markdown reading position', () => {
  it('restores a source block offset when earlier deferred tables change height', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-preview-lazy-table><table><tbody><tr><td data-preview-line-start="3">earlier</td></tr></tbody></table></div><div data-preview-lazy-table><table><tbody><tr><td data-preview-line-start="50">reading</td></tr></tbody></table></div>';
    root.scrollTop = 1000;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    const block = root.querySelector<HTMLElement>('[data-preview-line-start="50"]')!;
    vi.spyOn(block, 'getBoundingClientRect').mockReturnValue({ top: 1500 } as DOMRect);
    const earlier = vi.spyOn(
      root.querySelector<HTMLElement>('[data-preview-line-start="3"]')!,
      'getBoundingClientRect',
    );
    expect(restoreDocumentAnchor(root, { line: 50, top: -40 })).toBe(true);
    expect(root.scrollTop).toBe(2440);
    expect(block.closest<HTMLElement>('[data-preview-lazy-table]')!.dataset.previewRevealed).toBe(
      'true',
    );
    expect(earlier).not.toHaveBeenCalled();
  });
  it('leaves offset restoration to the caller when the original source block no longer exists', () => {
    const root = document.createElement('div');
    root.scrollTop = 100;
    expect(restoreDocumentAnchor(root, { line: 50, top: 0 })).toBe(false);
    expect(restoreDocumentAnchor(root)).toBe(false);
    expect(root.scrollTop).toBe(100);
  });
});
