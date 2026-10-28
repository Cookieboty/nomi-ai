#!/usr/bin/env node
/**
 * Shared paths for character-pack tooling.
 *
 * The official character is an ordinary pack (characters/nomi). Builds read the selected pack
 * directly — `CHARACTER_PACK=<dir>` or the default — and never overwrite files in the tree.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '../..');

/** Top-level directory holding the in-repo packs (not workspace packages). */
export const CHARACTERS_DIR = join(ROOT, 'characters');
export const DEFAULT_PACK_ID = 'nomi';
export const DEFAULT_PACK_DIR = join(CHARACTERS_DIR, DEFAULT_PACK_ID);
export const TEST_DUMMY_PACK_DIR = join(CHARACTERS_DIR, 'test-dummy');
export const EXAMPLES_STATIC = join(ROOT, 'examples/static-demo.pack');

/** Contract data: @nomi-ai/character-contract is the only source. */
export const CONTRACT_JSON = join(ROOT, 'packages/character-contract/contract.json');
export const VOICE_IDS_JSON = join(ROOT, 'packages/character-contract/voice-ids.json');

/** Resolve a pack directory argument (relative to the repo root); throws when it is not a dir. */
export function resolvePackDir(input) {
  const p = resolve(ROOT, input);
  if (!existsSync(p)) throw new Error(`character pack not found: ${p}`);
  if (!statSync(p).isDirectory()) throw new Error(`character pack must be a directory: ${p}`);
  return p;
}

/** The pack a build ships: `CHARACTER_PACK` when set, otherwise characters/nomi. */
export function selectedPackDir(env = process.env) {
  const fromEnv = env.CHARACTER_PACK?.trim();
  return fromEnv ? resolvePackDir(fromEnv) : DEFAULT_PACK_DIR;
}

/** Brand-lock sprite dir: the official pack's sprite (overridable for forks). */
export function brandLockModelDir(env = process.env) {
  return resolve(
    env.CHARACTER_PACK_SPRITE_DIR || env.BRAND_LOCK_MODEL_DIR || join(DEFAULT_PACK_DIR, 'sprite'),
  );
}

export function skipBrandLock(env = process.env) {
  return env.CHARACTER_PACK_SKIP_BRAND_LOCK === '1';
}

export function rel(path) {
  return relative(ROOT, path).split('\\').join('/') || '.';
}
