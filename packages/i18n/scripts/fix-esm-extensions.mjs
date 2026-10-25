/**
 * tsc ESM emit keeps extensionless relative imports; NodeNext consumers need .js.
 * Rewrite `from './x'` → `from './x.js'` in dist/ (leave .json and already-suffixed alone).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.js')) fix(p);
  }
}

function fix(file) {
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/from\s+(['"])(\.[^'"]+)\1/g, (full, q, spec) => {
    if (/\.(js|json|mjs|cjs|css)$/.test(spec)) return full;
    return `from ${q}${spec}.js${q}`;
  });
  if (next !== text) fs.writeFileSync(file, next);
}

walk(dist);
