import { describe, expect, it } from 'vitest';

import type { WorkspaceTreeNode } from '../src/services/harnessClient';
import {
  atPathToken,
  filterAtPathOptions,
  flattenWorkspacePaths,
  formatAtPathInsert,
  replaceAtPathToken,
} from '../src/slash/atPathComplete';

describe('atPathToken', () => {
  it('finds @query under the caret', () => {
    expect(atPathToken('see @src/Ap', 11)).toEqual({ start: 4, end: 11, query: 'src/Ap' });
  });
  it('opens on mid-string @ (email-like)', () => {
    expect(atPathToken('a@b', 3)).toEqual({ start: 1, end: 3, query: 'b' });
  });
  it('returns null when caret is not inside an @ token', () => {
    expect(atPathToken('hello', 5)).toBeNull();
    expect(atPathToken('x @y z', 1)).toBeNull();
  });
});

describe('replaceAtPathToken', () => {
  it('replaces the token and places caret after the insert', () => {
    const r = replaceAtPathToken(
      'see @src/Ap please',
      { start: 4, end: 11, query: 'src/Ap' },
      '@src/App.tsx',
    );
    expect(r).toEqual({ text: 'see @src/App.tsx please', caret: 16 });
  });
});

const tree: WorkspaceTreeNode[] = [
  {
    kind: 'dir',
    name: 'src',
    path: 'src',
    children: [
      { kind: 'file', name: 'App.tsx', path: 'src/App.tsx' },
      { kind: 'file', name: 'main.ts', path: 'src/main.ts' },
    ],
  },
  { kind: 'file', name: 'README.md', path: 'README.md' },
];

describe('flattenWorkspacePaths', () => {
  it('lists files and dirs with relative paths', () => {
    const flat = flattenWorkspacePaths(tree);
    expect(flat).toEqual(
      expect.arrayContaining([
        { path: 'src', kind: 'dir', label: 'src' },
        { path: 'src/App.tsx', kind: 'file', label: 'App.tsx' },
        { path: 'README.md', kind: 'file', label: 'README.md' },
      ]),
    );
  });
});

describe('filterAtPathOptions', () => {
  it('prefers basename hits over path-only hits', () => {
    const all = flattenWorkspacePaths(tree);
    const hit = filterAtPathOptions(all, 'app');
    expect(hit[0]?.path).toBe('src/App.tsx');
  });
  it('matches path substrings case-insensitively', () => {
    const all = flattenWorkspacePaths(tree);
    expect(filterAtPathOptions(all, 'SRC/').some((o) => o.path === 'src/main.ts')).toBe(true);
  });
});

describe('formatAtPathInsert', () => {
  it('prefixes @ and adds trailing slash for dirs', () => {
    expect(formatAtPathInsert({ path: 'src/App.tsx', kind: 'file', label: 'App.tsx' })).toBe(
      '@src/App.tsx',
    );
    expect(formatAtPathInsert({ path: 'src', kind: 'dir', label: 'src' })).toBe('@src/');
  });
});
