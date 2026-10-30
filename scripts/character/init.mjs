#!/usr/bin/env node
/**
 * character:init — scaffold a new character pack from the characters/test-dummy template.
 *
 *   pnpm character:init -- ../my-character.pack my-character
 *
 * The new pack is a static-mode pack with placeholder art; replace the images, persona.json and
 * locales/*.json, then run `pnpm character:check -- <dir>`.
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { ROOT, TEST_DUMMY_PACK_DIR, rel } from './paths.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
if (!args[0]) {
  console.error('usage: pnpm character:init -- <target-dir> [id]');
  process.exit(1);
}
const target = resolve(ROOT, args[0]);
const id = (args[1] ?? basename(target).replace(/\.pack$/, ''))
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '-');
if (existsSync(target)) {
  console.error(`target already exists: ${target}`);
  process.exit(1);
}

cpSync(TEST_DUMMY_PACK_DIR, target, { recursive: true });
rmSync(join(target, 'README.md'), { force: true });
const manifestPath = join(target, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.id = id;
manifest.version = '0.1.0';
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.info(`character:init → ${rel(target)} (id=${id}); edit persona.json, locales/ and art`);
