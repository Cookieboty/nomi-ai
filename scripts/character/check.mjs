#!/usr/bin/env node
/**
 * character:check — validate a character pack with validatePackDir (@nomi-ai/character-contract).
 *
 * Usage:
 *   pnpm character:check                       # characters/nomi (official; voice must be complete)
 *   pnpm character:check -- characters/test-dummy
 *   node scripts/character/check.mjs examples/static-demo.pack
 */
import { loadContract } from './contract.mjs';
import { formatIssues, isOfficialPack } from './pack.mjs';
import { DEFAULT_PACK_DIR, rel, resolvePackDir } from './paths.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');

try {
  const packDir = args[0] ? resolvePackDir(args[0]) : DEFAULT_PACK_DIR;
  const { validatePackDir } = await loadContract();
  const result = await validatePackDir(packDir, { requireCompleteVoice: isOfficialPack(packDir) });
  const m = result.pack?.manifest;
  console.info(
    `character:check ${rel(packDir)} mode=${result.pack?.mode ?? '?'} id=${m?.id ?? '?'}`,
  );
  const issues = formatIssues(result);
  if (issues) console.warn(issues);
  if (!result.ok) {
    console.error(`FAILED (${result.errors.length} errors, ${result.warnings.length} warnings)`);
    process.exit(1);
  }
  console.info(`OK (${result.warnings.length} warnings)`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
