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
/**
 * The official pack's low-resource static art (the desktop character's default `svg` renderer).
 * It is the SVG rig's mother image, so it lives with the Rive sources rather than in the pack;
 * only builds of the official pack ship it (vite-plugin.mjs `staticArtModule`).
 */
export const DEFAULT_PACK_STATIC_ART = join(
  ROOT,
  'rive/nomi-complete/reference/svg-rig/nomi-fullbody-mother.svg',
);
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

export function rel(path) {
  return relative(ROOT, path).split('\\').join('/') || '.';
}
