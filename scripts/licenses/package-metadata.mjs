import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
function installedRoot(name) {
  // pnpm 9 reports virtual-store paths even with node-linker=hoisted. Resolve only
  // the installed module, then still verify its real package metadata and licence hash.
  let directory = path.dirname(require.resolve(name));
  while (directory !== path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    directory = path.dirname(directory);
  }
  throw new Error('Package metadata not found');
}

/** Reviewed published-package licence text, not a blanket exception for missing SPDX metadata. */
const REVIEWS = {
  khroma: {
    version: '2.1.0',
    license: 'MIT',
    file: 'license',
    sha256: '66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49',
  },
};

export function reviewedMetadataLicense(pkg, reported) {
  const review = REVIEWS[pkg.name];
  if (
    reported !== 'Unknown' ||
    !review ||
    !pkg.paths?.length ||
    !pkg.versions?.length ||
    pkg.versions.some((version) => version !== review.version)
  )
    return null;
  try {
    for (const reportedRoot of pkg.paths) {
      const root = fs.existsSync(reportedRoot) ? reportedRoot : installedRoot(pkg.name);
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      if (meta.name !== pkg.name || meta.version !== review.version) return null;
      const hash = createHash('sha256')
        .update(fs.readFileSync(path.join(root, review.file)))
        .digest('hex');
      if (hash !== review.sha256) return null;
    }
    return review.license;
  } catch {
    return null;
  }
}
