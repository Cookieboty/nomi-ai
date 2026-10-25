import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Trend CountOptions (#123)', () => {
  it('passes cancelInDenominator and includeRejected into series query', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/components/QualityPanel/Trend.tsx'),
      'utf8',
    );
    expect(src).toMatch(/cancelInDenominator:\s*true/);
    expect(src).toMatch(/includeRejected:\s*true/);
    expect(src).toMatch(/count:\s*CountOptions/);
  });
});
