import { describe, expect, it } from 'vitest';

import { shortenPath, workspaceRelPath } from '../src/utils/workspacePath';

describe('workspaceRelPath', () => {
  it('strips cwd prefix', () => {
    expect(workspaceRelPath('/work/app', '/work/app/src/a.ts')).toBe('src/a.ts');
    expect(workspaceRelPath('/work/app/', '/work/app/src/a.ts')).toBe('src/a.ts');
  });

  it('leaves relative and outside absolute', () => {
    expect(workspaceRelPath('/work/app', 'src/a.ts')).toBe('src/a.ts');
    expect(workspaceRelPath('/work/app', '/other/a.ts')).toBe('/other/a.ts');
  });
});

describe('shortenPath', () => {
  it('keeps short paths', () => {
    expect(shortenPath('/a/b')).toBe('/a/b');
  });
});
