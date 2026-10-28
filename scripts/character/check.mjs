#!/usr/bin/env node
/**
 * character:check — validate a character pack against packages/character-contract/contract.json
 *
 * Usage:
 *   node scripts/character/check.mjs [packDir]
 *   pnpm character:check
 *   pnpm character:check -- examples/static-demo.pack
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadContract, packMode, readJson, readManifest, rel, resolvePackDir } from './lib.mjs';
import { EXAMPLES_NOMI as DEFAULT_PACK } from './paths.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const packDir = resolvePackDir(args[0] || DEFAULT_PACK);
const contract = loadContract();
const errors = [];
const warnings = [];

function need(cond, msg) {
  if (!cond) errors.push(msg);
}
function warn(cond, msg) {
  if (!cond) warnings.push(msg);
}

const manifest = readManifest(packDir);
const mode = packMode(manifest);
need(contract.modes.includes(mode), `unknown mode: ${mode}`);

const onboardingDir = join(packDir, manifest.assets?.onboarding || 'onboarding');
for (const f of contract.onboarding.files) {
  need(existsSync(join(onboardingDir, f)), `missing onboarding/${f}`);
}

if (mode === 'static') {
  const staticRel = manifest.assets?.static || 'static/character.webp';
  const staticPath = join(
    packDir,
    staticRel.endsWith('.webp') || staticRel.endsWith('.png')
      ? staticRel
      : join(staticRel, 'character.webp'),
  );
  const alt = join(packDir, 'static/character.webp');
  const png = join(packDir, 'static/character.png');
  need(
    existsSync(staticPath) || existsSync(alt) || existsSync(png),
    'static mode requires static/character.webp (or .png)',
  );
  // Skip riv / 43-action requirements for static.
} else {
  if (mode === 'rive' || manifest.assets?.rive) {
    const riveRel = manifest.assets?.rive || 'rive/character.riv';
    const rivePath = join(packDir, riveRel);
    need(existsSync(rivePath), `missing ${riveRel}`);
    if (existsSync(rivePath)) {
      const sz = statSync(rivePath).size;
      need(sz > 1000, `rive file too small (${sz} bytes)`);
    }
  }
  if (mode === 'sprite' || manifest.assets?.sprite) {
    const spriteDir = join(packDir, manifest.assets?.sprite || 'sprite');
    need(
      existsSync(join(spriteDir, 'manifest.json')),
      'sprite/manifest.json required when sprite present',
    );
    warn(existsSync(join(spriteDir, 'thumb.png')), 'sprite/thumb.png recommended');
    if (existsSync(join(spriteDir, 'manifest.json'))) {
      // Soft-check: action count documented; layered packs declare rig in sprite manifest.
      const declared = manifest.capabilities?.spriteActions;
      if (Array.isArray(declared) && declared.length > 0) {
        const missing = contract.sprite.actionIds.filter((id) => !declared.includes(id));
        warn(
          missing.length === 0,
          `sprite capabilities omit ${missing.length} contract actions (ok if intentional)`,
        );
      }
    }
  } else if (mode === 'rive') {
    warn(
      existsSync(join(packDir, 'sprite/manifest.json')),
      'sprite/ fallback strongly recommended for rive packs',
    );
  }
}

const voiceDir = join(packDir, manifest.assets?.voice || 'voice');
const zhDir = join(voiceDir, 'zh');
if (existsSync(zhDir)) {
  const manPath = join(zhDir, 'manifest.json');
  need(existsSync(manPath), 'voice/zh/manifest.json required when voice/zh present');
  if (existsSync(manPath)) {
    const man = readJson(manPath);
    const clips = man.clips || [];
    const have = new Set();
    for (const c of clips) {
      if (c.id) have.add(c.id);
      if (c.key) have.add(c.key);
    }
    const required = contract.voice.requiredClipIds || [];
    const missing = required.filter((id) => !have.has(id));
    if (man.idSchema && man.idSchema !== 'stable-v1') {
      warnings.push(`unexpected voice idSchema: ${man.idSchema}`);
    }
    // Official pack must be complete; custom packs warn.
    if (manifest.id === 'nomi') {
      need(
        missing.length === 0,
        `nomi voice missing ${missing.length} clips (e.g. ${missing.slice(0, 3).join(', ')})`,
      );
    } else {
      warn(
        missing.length === 0,
        `voice missing ${missing.length}/${required.length} contract clips`,
      );
    }
    for (const c of clips) {
      warn(existsSync(join(zhDir, c.file)), `voice file missing: ${c.file}`);
    }
  }
} else {
  warn(false, 'voice/zh not provided — prompt clips will fall back to TTS / silence');
}

warn(existsSync(join(packDir, 'copy/zh.json')), 'copy/zh.json recommended');
warn(existsSync(join(packDir, 'copy/en.json')), 'copy/en.json recommended');

if (manifest.rive?.artboard) {
  need(typeof manifest.rive.artboard === 'string', 'manifest.rive.artboard must be string');
}
if (manifest.rive?.stateMachine) {
  need(typeof manifest.rive.stateMachine === 'string', 'manifest.rive.stateMachine must be string');
}

console.info(`character:check ${rel(packDir)} mode=${mode} id=${manifest.id}`);
if (warnings.length) {
  for (const w of warnings) console.warn(`  warn: ${w}`);
}
if (errors.length) {
  for (const e of errors) console.error(`  error: ${e}`);
  console.error(`FAILED (${errors.length} errors, ${warnings.length} warnings)`);
  process.exit(1);
}
console.info(`OK (${warnings.length} warnings)`);
