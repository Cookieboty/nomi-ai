import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { reviewedMetadataLicense } from '../licenses/package-metadata.mjs';

const real = repoPath('node_modules/khroma');
const pkg = { name: 'khroma', versions: ['2.1.0'], paths: [real] };

describe('reviewed published licence metadata', () => {
  it('permits only the exact MIT licence shipped with the reviewed version', () => {
    expect(reviewedMetadataLicense(pkg, 'Unknown')).toBe('MIT');
    expect(reviewedMetadataLicense({ ...pkg, versions: ['2.2.0'] }, 'Unknown')).toBeNull();
    expect(reviewedMetadataLicense({ ...pkg, name: 'other' }, 'Unknown')).toBeNull();
    expect(reviewedMetadataLicense(pkg, 'Proprietary')).toBeNull();
    expect(reviewedMetadataLicense({ ...pkg, paths: [] }, 'Unknown')).toBeNull();
  });
  it('rejects altered or missing licence files even when package metadata matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yxl-license-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'khroma', version: '2.1.0' }),
      );
      expect(reviewedMetadataLicense({ ...pkg, paths: [dir] }, 'Unknown')).toBeNull();
      fs.writeFileSync(path.join(dir, 'license'), 'unreviewed licence');
      expect(reviewedMetadataLicense({ ...pkg, paths: [dir] }, 'Unknown')).toBeNull();
      const license = fs.readFileSync(path.join(real, 'license'));
      expect(createHash('sha256').update(license).digest('hex')).toBe(
        '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49',
      );
      fs.writeFileSync(path.join(dir, 'license'), license);
      expect(reviewedMetadataLicense({ ...pkg, paths: [dir] }, 'Unknown')).toBe('MIT');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'khroma', version: '3.0.0' }),
      );
      expect(reviewedMetadataLicense({ ...pkg, paths: [dir] }, 'Unknown')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
