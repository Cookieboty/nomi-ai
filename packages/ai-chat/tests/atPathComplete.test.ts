import { describe, expect, it } from 'vitest';

import type { WorkspaceTreeNode } from '../src/services/harnessClient';
import {
  atPathToken,
  filterAtPathOptions,
  flattenWorkspacePaths,
  formatAtPathInsert,
  mentionPathsToOptions,
  mergeAtPathOptions,
  replaceAtPathToken,
} from '../src/slash/atPathComplete';

describe('atPathToken', () => {
  it('finds @query under the caret', () => {
    expect(atPathToken('see @src/Ap', 11)).toEqual({ start: 4, end: 11, query: 'src/Ap' });
  });
  it('ignores mid-word @ (email-like)', () => {
    expect(atPathToken('a@b', 3)).toBeNull();
    expect(atPathToken('mail me@host.com', 16)).toBeNull();
  });
  it('opens on @ at the start or after whitespace', () => {
    expect(atPathToken('@b', 2)).toEqual({ start: 0, end: 2, query: 'b' });
    expect(atPathToken('x\n@b', 4)).toEqual({ start: 2, end: 4, query: 'b' });
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

describe('multi-folder projects', () => {
  it('other folders insert absolute paths and show “folder/rel”; filtering matches the shown path', () => {
    const nodes = [
      { kind: 'file', name: 'main.go', path: 'cmd/main.go' },
    ] as unknown as WorkspaceTreeNode[];
    const opts = flattenWorkspacePaths(nodes, { root: '/w/api/', name: 'api' });
    expect(opts).toEqual([
      { path: '/w/api/cmd/main.go', kind: 'file', label: 'main.go', display: 'api/cmd/main.go' },
    ]);
    expect(filterAtPathOptions(opts, 'api/cmd')).toHaveLength(1);
    expect(formatAtPathInsert(opts[0]!)).toBe('@/w/api/cmd/main.go');
  });
});

describe('mentionPathsToOptions', () => {
  it('uses the same multi-root insert and display paths as flattenWorkspacePaths', () => {
    const cwd = mentionPathsToOptions([
      { path: 'node_modules', kind: 'dir', name: 'node_modules' },
      { path: 'node_modules/pkg/index.js', kind: 'file', name: 'index.js' },
    ]);
    expect(cwd).toEqual([
      { path: 'node_modules', kind: 'dir', label: 'node_modules' },
      { path: 'node_modules/pkg/index.js', kind: 'file', label: 'index.js' },
    ]);
    const other = mentionPathsToOptions(
      [{ path: 'node_modules/pkg/index.js', kind: 'file', name: 'index.js' }],
      { root: '/w/api/', name: 'api' },
    );
    expect(other).toEqual([
      {
        path: '/w/api/node_modules/pkg/index.js',
        kind: 'file',
        label: 'index.js',
        display: 'api/node_modules/pkg/index.js',
      },
    ]);
    expect(formatAtPathInsert(other[0]!)).toBe('@/w/api/node_modules/pkg/index.js');
  });
});

describe('mergeAtPathOptions', () => {
  it('dedupes by insert path, prefers basename hits, and caps at 50', () => {
    const flat = flattenWorkspacePaths(tree);
    const tops: ReturnType<typeof mentionPathsToOptions> = [
      { path: 'node_modules', kind: 'dir', label: 'node_modules' },
      { path: 'src/App.tsx', kind: 'file', label: 'App.tsx' },
    ];
    const hits = mentionPathsToOptions([
      { path: 'node_modules/pkg/index.js', kind: 'file', name: 'index.js' },
    ]);
    const merged = mergeAtPathOptions([flat, tops, hits], 'app');
    expect(merged.filter((o) => o.path === 'src/App.tsx')).toHaveLength(1);
    expect(merged[0]?.path).toBe('src/App.tsx');
    expect(mergeAtPathOptions([tops, hits], '').some((o) => o.path === 'node_modules')).toBe(true);

    const many = Array.from({ length: 80 }, (_, i) => ({
      path: `f${String(i).padStart(3, '0')}.ts`,
      kind: 'file' as const,
      label: `f${String(i).padStart(3, '0')}.ts`,
    }));
    expect(mergeAtPathOptions([many], 'f', 50)).toHaveLength(50);
  });
});
