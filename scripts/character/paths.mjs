#!/usr/bin/env node
/**
 * Shared paths for character-pack tooling (v1 overwrite-in-place targets).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '../..');

/** Official Nomi landing paths — packs overwrite these; do not rename in v1. */
export const TARGETS = {
  rive: join(ROOT, 'packages/renderer/public/assets/models/rive/nomi-complete.riv'),
  spriteDir: join(ROOT, 'packages/renderer/public/assets/models/sprite/nomi'),
  voiceDir: join(ROOT, 'packages/renderer/public/voice/nomi'),
  onboardingDir: join(ROOT, 'packages/ai-chat/src/components/Onboarding/art'),
  modelList: join(ROOT, 'packages/renderer/public/assets/models/model-list.json'),
};

export const GENERATED = {
  renderer: join(ROOT, 'packages/renderer/src/mascot/character.generated.json'),
  mascotBundle: join(ROOT, 'packages/bundle-ig-mascot/src/character.generated.json'),
};

export const CONTRACT_JSON = join(ROOT, 'docs/character-pack/contract.json');
export const EXAMPLES_NOMI = join(ROOT, 'examples/nomi.pack');
export const EXAMPLES_STATIC = join(ROOT, 'examples/static-demo.pack');

/** Brand-lock sprite dir (overridable for forks). */
export function brandLockModelDir() {
  return (
    process.env.CHARACTER_PACK_SPRITE_DIR || process.env.BRAND_LOCK_MODEL_DIR || TARGETS.spriteDir
  );
}

export function skipBrandLock() {
  return process.env.CHARACTER_PACK_SKIP_BRAND_LOCK === '1';
}
