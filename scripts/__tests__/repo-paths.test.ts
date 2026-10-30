/**
 * 防回退：源码与测试里不用相对路径跨出所在的包（`../../../../characters`、`"..", "..", ".."`）。
 * 包挪了位置这种路径不会报错，只会悄悄指到别处（找不到文件就走了另一条分支），
 * 所以通往仓库根目录 / 别的包的路径一律用 `@nomi-ai/repo-paths` 的 repoPath（Go 用 paritytest.RepoPath）。
 *
 * 不管的：import / require / vi.mock 之类的模块路径（写错了编译或加载时直接报错）、
 * `*.config.*` 与 package.json / tsconfig（构建时直接报错）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

const root = repoRoot();

function tracked(...globs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...globs], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f && !/(^|\/)(node_modules|dist|coverage)\//.test(f))
    .filter((f) => fs.existsSync(path.join(root, f)));
}

/** 文件所属的包：往上最近的 package.json 所在目录；不在任何包里就是仓库根 */
function ownerOf(file: string): string {
  for (let d = path.dirname(path.join(root, file)); d !== root; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
  }
  return root;
}

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** 紧挨在字符串前面的是模块路径的写法 */
const MODULE_CONTEXT =
  /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\b(?:vi|jest)\.(?:mock|doMock|unmock|requireActual|importActual)\s*\(\s*)$/;

describe('relative paths stay inside their package', () => {
  it('TS / JS: no path literal climbs out of its package', () => {
    const bad: string[] = [];
    for (const f of tracked('*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.mts')) {
      if (/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(f)) continue;
      const own = ownerOf(f);
      if (own === root) continue;
      const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
      for (const m of src.matchAll(/(['"`])(\.\.\/[^'"`\n]*)\1/g)) {
        if (MODULE_CONTEXT.test(src.slice(Math.max(0, m.index - 40), m.index))) continue;
        const target = path.resolve(path.dirname(path.join(root, f)), m[2]!.split('?')[0]!);
        if (target !== own && !target.startsWith(own + path.sep)) bad.push(`${f}: ${m[2]}`);
      }
    }
    expect(bad, 'use repoPath() from @nomi-ai/repo-paths').toEqual([]);
  });

  it('Go: no three-level ".." climbs', () => {
    const bad: string[] = [];
    for (const f of tracked('apps/desktop-go/*.go')) {
      const src = stripComments(fs.readFileSync(path.join(root, f), 'utf8'));
      src.split('\n').forEach((line, i) => {
        if (/"(\.\.\/){3}|"\.\.",\s*"\.\.",\s*"\.\."/.test(line)) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad, 'use paritytest.RepoPath').toEqual([]);
  });
});
