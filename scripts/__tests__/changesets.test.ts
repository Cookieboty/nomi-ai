import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import parse from '@changesets/parse';
import { describe, expect, it } from 'vitest';

// Regression: `pnpm changeset status` refuses unparsable frontmatter (unquoted `@scope/pkg`)
// and changesets that mix packages from config.json `ignore` with releasable ones.
const dir = join(__dirname, '../../.changeset');
const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as { ignore: string[] };
const ignored = new Set(config.ignore);
const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');

/**
 * 归档上限：待发布的 changeset 由发版步骤消费（见 docs/RELEASE.md）。
 * 这里只拦「没人消费、无限增长」；消费过一批就把它调小。
 * 2.3.16 之前已经累积了 1000+ 条（发版一直在手写 docs/releases/*.md，没跑过消费）。
 */
const MAX_PENDING_CHANGESETS = 1100;

describe('.changeset entries', () => {
  it('has changesets to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // 一条用例过一遍全部文件，而不是 each(files) 每条一个用例：1000+ 条参数化用例
  // 让这个文件（而不是它检查的规则）成了根测试的体量，失败时也只是一堆同名用例。
  it('all parse, and none mix ignored / releasable packages', () => {
    const problems: string[] = [];
    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf8');
      try {
        const { releases } = parse(raw);
        const names = releases.map((r) => r.name);
        const ign = names.filter((n) => ignored.has(n));
        const rel = names.filter((n) => !ignored.has(n));
        if (ign.length > 0 && rel.length > 0) {
          problems.push(
            `${file}: mixes ignored (${ign.join(', ')}) with releasable (${rel.join(', ')})`,
          );
        }
      } catch (err) {
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('stays under the pending backlog cap', () => {
    expect(files.length).toBeLessThanOrEqual(MAX_PENDING_CHANGESETS);
  });
});
