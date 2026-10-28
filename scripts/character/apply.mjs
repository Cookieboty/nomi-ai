#!/usr/bin/env node
/**
 * character:apply — preflight for the pack a build will ship.
 *
 *   CHARACTER_PACK=/path/to/pack pnpm character:apply && CHARACTER_PACK=/path/to/pack pnpm build
 *   pnpm character:apply   # characters/nomi
 *
 * Nothing is copied or overwritten: the renderer / ai-chat builds read the selected pack directly
 * (scripts/character/vite-plugin.mjs) and the main process resolves it at runtime
 * (userData → resources → built-in). This script validates the pack and prints what will ship.
 */
import { loadPack } from './pack.mjs';
import { rel, selectedPackDir } from './paths.mjs';

try {
  const { pack, result } = await loadPack(selectedPackDir());
  const name = pack.persona?.displayName ?? pack.manifest.id;
  console.info(
    `character:apply ${rel(selectedPackDir())} id=${pack.manifest.id} mode=${pack.mode} name=${name}`,
  );
  for (const w of result.warnings) console.warn(`  warn: ${w.file}: ${w.message}`);
  console.info('OK — the next build ships this pack (set the same CHARACTER_PACK for pnpm build)');
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
