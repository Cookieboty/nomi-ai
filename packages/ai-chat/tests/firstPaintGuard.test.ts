import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 首屏体积守卫：语法高亮器（lowlight / highlight.js，约 180KB）只能经动态 import 进入，
 * 不得被任何会进入对话窗入口 chunk 的源码静态引入，否则它又会回到首屏 JS 里。
 */
const SRC = resolve(import.meta.dirname, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('first-paint bundle guard', () => {
  const files = walk(SRC);
  const HEAVY =
    /(?:from\s+|import\s+)['"](?:lowlight|highlight\.js|rehype-highlight)(?:\/[^'"]*)?['"]/;

  it('no source statically imports the syntax highlighter', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // 允许 `import type { … } from 'lowlight'`（编译后擦除）与动态 import()
      return src
        .split('\n')
        .some(
          (line) =>
            HEAVY.test(line) &&
            !/^\s*import\s+type\b/.test(line) &&
            !/^\s*(?:\/\/|\*|\/\*)/.test(line) &&
            !/import\(/.test(line),
        );
    });
    expect(offenders).toEqual([]);
  });

  it('the highlighter is loaded through a dynamic import()', () => {
    const src = readFileSync(join(SRC, 'components/Conversation/markdownHighlight.ts'), 'utf8');
    expect(src).toMatch(/import\(\s*['"]lowlight['"]\s*\)/);
  });
});
