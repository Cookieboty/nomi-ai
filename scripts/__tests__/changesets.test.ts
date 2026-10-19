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

describe('.changeset entries', () => {
  it('has changesets to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s parses and does not mix ignored / releasable packages', (file) => {
    const raw = readFileSync(join(dir, file), 'utf8');
    const { releases } = parse(raw);
    const names = releases.map((r) => r.name);
    const ign = names.filter((n) => ignored.has(n));
    const rel = names.filter((n) => !ignored.has(n));
    expect({ file, mixed: ign.length > 0 && rel.length > 0 }).toEqual({ file, mixed: false });
  });
});
