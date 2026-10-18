import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkWindow, initialAssets } from '../check-bundle-budget.mjs';

const HTML = `<!doctype html><html><head>
<script type="module" crossorigin src="./assets/index-a.js"></script>
<link rel="modulepreload" crossorigin href="./assets/icons-b.js">
<link rel="modulepreload" href="https://cdn.example.com/x.js">
<link rel="stylesheet" crossorigin href="./assets/index-c.css">
<link rel="icon" href="./favicon.png"></head><body></body></html>`;

describe('bundle budget check', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'budget-'));
    dirs.push(root);
    mkdirSync(join(root, 'dist/assets'), { recursive: true });
    writeFileSync(join(root, 'dist/index.html'), HTML);
    for (const [name, body] of Object.entries(files))
      writeFileSync(join(root, 'dist/assets', name), body);
    return root;
  }

  it('reads entry script, modulepreload and stylesheet; ignores remote URLs and icons', () => {
    expect(initialAssets(HTML)).toEqual({
      js: ['./assets/index-a.js', './assets/icons-b.js'],
      css: ['./assets/index-c.css'],
    });
  });

  it('passes inside budget and reports sizes', () => {
    const root = fixture({
      'index-a.js': 'x'.repeat(2048),
      'icons-b.js': 'y'.repeat(1024),
      'index-c.css': 'a{}',
    });
    const r = checkWindow(
      't',
      { dist: 'dist', initialJsRawKB: 4, initialJsGzipKB: 4, initialCssRawKB: 1 },
      root,
    );
    expect(r.problems).toEqual([]);
    expect(r.initialJs?.rawKB).toBe(3);
  });

  it('flags a window that is over budget', () => {
    const root = fixture({ 'index-a.js': 'x'.repeat(4096), 'icons-b.js': '', 'index-c.css': '' });
    const r = checkWindow('t', { dist: 'dist', initialJsRawKB: 1 }, root);
    expect(r.problems.join('\n')).toMatch(/initial JS \(raw\) 4 KB exceeds budget 1 KB/);
  });

  it('flags forbidden code in an initial chunk but not in a lazy chunk', () => {
    const root = fixture({
      'index-a.js': 'console.log("HEAVY_MARKER")',
      'icons-b.js': '',
      'index-c.css': '',
      'lazy-d.js': 'HEAVY_MARKER',
    });
    const r = checkWindow(
      't',
      { dist: 'dist', forbiddenInInitialJs: [{ marker: 'HEAVY_MARKER', why: 'must be lazy' }] },
      root,
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/index-a\.js.*must be lazy/);
  });

  it('skips a window with no build output', () => {
    const root = mkdtempSync(join(tmpdir(), 'budget-'));
    dirs.push(root);
    expect(checkWindow('t', { dist: 'dist' }, root).skipped).toBe(true);
  });
});
