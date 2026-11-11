// @vitest-environment happy-dom
/** Diff 继承代码块的语法高亮：按扩展名选语言、旧新两侧整体高亮后按行拆回 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  diffLanguage,
  highlightDiffLines,
  splitHastLines,
} from '../src/components/Conversation/diffHighlight';
import { DiffView } from '../src/components/Conversation/DiffView';
import { loadHighlighter } from '../src/components/Conversation/markdownHighlight';
import type { DiffLine } from '../src/utils/lineDiff';

afterEach(cleanup);

describe('diffLanguage', () => {
  it('maps extensions and special filenames', () => {
    expect(diffLanguage('src/a.ts')).toBe('ts');
    expect(diffLanguage('C:\\x\\App.vue')).toBe('xml');
    expect(diffLanguage('Makefile')).toBe('makefile');
    expect(diffLanguage('.env.local')).toBe('bash');
    expect(diffLanguage('README')).toBeUndefined();
    expect(diffLanguage(undefined)).toBeUndefined();
  });
});

describe('splitHastLines', () => {
  it('splits spans that cross newlines into one copy per line', () => {
    const rows = splitHastLines([
      { type: 'text', value: 'a ' },
      {
        type: 'element',
        tagName: 'span',
        properties: { className: ['hljs-comment'] },
        children: [{ type: 'text', value: '/* x\ny */' }],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1]![0]).toMatchObject({ properties: { className: ['hljs-comment'] } });
  });
});

describe('highlightDiffLines', () => {
  const lines: DiffLine[] = [
    { type: 'hunk', text: '@@ -1,3 +1,3 @@' },
    { type: 'ctx', text: '/* start', oldNo: 1, newNo: 1 },
    { type: 'del', text: '   old */ const a = 1;', oldNo: 2 },
    { type: 'add', text: '   new */ const a = 2;', newNo: 2 },
  ];

  it('returns null for unknown languages', async () => {
    await loadHighlighter();
    expect(highlightDiffLines('a.unknownext', lines)).toBeNull();
    expect(highlightDiffLines('README', lines)).toBeNull();
  });

  it('highlights each side as continuous text', async () => {
    await loadHighlighter();
    const map = highlightDiffLines('a.ts', lines)!;
    expect(map.has(lines[0]!)).toBe(false);
    for (const l of lines.slice(1)) expect(map.get(l)?.length).toBeGreaterThan(0);
    // 块注释跨行：删除行与新增行的开头都还在注释里
    expect(map.get(lines[2]!)![0]).toMatchObject({ properties: { className: ['hljs-comment'] } });
    expect(map.get(lines[3]!)![0]).toMatchObject({ properties: { className: ['hljs-comment'] } });
  });

  it('renders hljs spans in DiffView', async () => {
    render(<DiffView diff={{ file: 'a.ts', diff: { lines, added: 1, removed: 1 } }} />);
    await waitFor(() =>
      expect(screen.getByTestId('tool-diff').querySelector('.hljs-keyword')).not.toBeNull(),
    );
    expect(screen.getByTestId('tool-diff').textContent).toContain('new */ const a = 2;');
  });
});
