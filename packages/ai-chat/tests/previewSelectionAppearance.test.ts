import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = (path: string) => readFileSync(resolve(__dirname, '../src/components', path), 'utf8');
const rule = (source: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
};

describe('document focus and informational selection appearance', () => {
  it('uses the text caret rather than a rectangular focus ring around editable document blocks', () => {
    const source = css('ResourcePreview/ResourcePreview.module.css');
    const block = '.documentBody .markdown [data-preview-edit-block]';
    expect(rule(source, block)).toContain('outline: none');
    expect(rule(source, `${block}:focus-visible`)).not.toMatch(/outline:\s*2px/);
    expect(source).toContain(
      ".panel button:not([role='combobox']):not(:global(.cd-btn)):focus-visible",
    );
    expect(source).toContain('.outlineSplitter:focus-visible');
  });

  it('gives the current chapter an accent background that overrides generic preview buttons', () => {
    const active = rule(
      css('ResourcePreview/ResourcePreview.module.css'),
      '.panel .outline > button[data-active]',
    );
    expect(active).toContain('background: var(--cd-color-accent-soft)');
    expect(active).toContain('color: var(--cd-color-accent-strong)');
  });

  it('keeps the file search caret without a blue focus rectangle', () => {
    const source = css('ResourcePreview/PreviewFilePicker.module.css');
    expect(rule(source, '.search input')).toContain('outline: none');
    expect(rule(source, '.search input:focus-visible')).not.toMatch(/outline:\s*2px/);
  });
});
