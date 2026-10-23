import { describe, expect, it } from 'vitest';

import {
  isNotGitRepoError,
  parseGitStatus,
  parseStatusLine,
  splitUnifiedDiff,
  unquoteGitPath,
} from '../src/utils/gitStatusParse';

describe('parseStatusLine', () => {
  it('parses modified / staged / untracked', () => {
    expect(parseStatusLine(' M src/a.ts')).toMatchObject({
      path: 'src/a.ts',
      letter: 'M',
      unstaged: true,
      staged: false,
    });
    expect(parseStatusLine('M  src/b.ts')).toMatchObject({
      path: 'src/b.ts',
      letter: 'M',
      staged: true,
    });
    expect(parseStatusLine('?? new.txt')).toMatchObject({
      path: 'new.txt',
      letter: '?',
      untracked: true,
    });
  });

  it('parses rename arrow path', () => {
    const e = parseStatusLine('R  old.ts -> new.ts');
    expect(e?.path).toBe('new.ts');
    expect(e?.letter).toBe('R');
  });
});

describe('parseGitStatus', () => {
  it('dedupes and sorts', () => {
    const list = parseGitStatus(' M b.ts\n?? a.ts\n M b.ts\n');
    expect(list.map((x) => x.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('splitUnifiedDiff', () => {
  it('splits files and counts +/-', () => {
    const raw = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -1 +1,2 @@
 same
+add
`;
    const parts = splitUnifiedDiff(raw);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.file).toBe('x.ts');
    expect(parts[0]!.added).toBe(1);
    expect(parts[0]!.removed).toBe(1);
    expect(parts[1]!.file).toBe('y.ts');
    expect(parts[1]!.added).toBe(1);
  });
});

describe('isNotGitRepoError', () => {
  it('detects common messages', () => {
    expect(isNotGitRepoError('fatal: not a git repository')).toBe(true);
    expect(isNotGitRepoError('当前目录不是 git 仓库')).toBe(true);
    expect(isNotGitRepoError('permission denied')).toBe(false);
  });
});

describe('quoted paths', () => {
  it('unquotes paths git wraps in quotes (spaces, escapes, octal utf-8)', () => {
    expect(parseGitStatus('A  "a b.txt"')[0]!.path).toBe('a b.txt');
    expect(parseGitStatus('R  "old name.ts" -> "new name.ts"')[0]!.path).toBe('new name.ts');
    expect(unquoteGitPath('"q\\"x\\\\y\\tz"')).toBe('q"x\\y\tz');
    expect(unquoteGitPath('"\\344\\270\\255.txt"')).toBe('中.txt');
    expect(unquoteGitPath('plain.txt')).toBe('plain.txt');
  });
});
