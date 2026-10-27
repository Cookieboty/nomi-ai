#!/usr/bin/env node
/**
 * character:apply — build-time character pack applicator (Scheme A).
 *
 *   CHARACTER_PACK=/path/to/pack pnpm character:apply
 *   pnpm character:apply   # ensure official nomi generated config (idempotent; no asset churn)
 *
 * v1 overwrites landing paths in place. Scheme B (runtime userData) is deferred.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  copyFile,
  copyTree,
  generatedFromManifest,
  officialGenerated,
  packMode,
  readJson,
  readManifest,
  rel,
  resolvePackDir,
  writeJson,
} from './lib.mjs';
import { GENERATED, TARGETS } from './paths.mjs';

function writeGenerated(data) {
  for (const dest of Object.values(GENERATED)) {
    writeJson(dest, data);
    console.info(`wrote ${rel(dest)}`);
  }
}

function syncModelList(generated) {
  if (!existsSync(TARGETS.modelList)) return;
  const list = readJson(TARGETS.modelList);
  const models = Array.isArray(list.models) ? list.models : [];
  const primary = models[0] || {};
  // Official Nomi: keep model-list identical (voiceHint stays xiaoxiao as shipped).
  if (generated.id === 'nomi' && primary.name === 'nomi') {
    console.info(`model-list unchanged (official nomi)`);
    return;
  }
  const next = {
    ...list,
    models: [
      {
        ...primary,
        name: generated.id,
        displayName:
          generated.displayName?.en && generated.displayName?.zh
            ? `${generated.displayName.en}·${generated.displayName.zh}`
            : primary.displayName || generated.id,
        path: generated.spriteManifestPath || primary.path,
        description:
          primary.description || `${generated.displayName?.en || generated.id}（角色包）`,
        tags: primary.tags || ['default', 'sprite', '2d'],
        config: {
          ...(primary.config || {}),
          voice: {
            ...(primary.config?.voice || {}),
            ...(generated.voice || {}),
          },
        },
      },
    ],
  };
  writeJson(TARGETS.modelList, next);
  console.info(`updated ${rel(TARGETS.modelList)}`);
}

function applyStaticAsset(packDir, manifest) {
  const candidates = [
    join(packDir, manifest.assets?.static || 'static/character.webp'),
    join(packDir, 'static/character.webp'),
    join(packDir, 'static/character.png'),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) throw new Error('static mode pack missing static/character.webp');
  const publicStatic = join(TARGETS.spriteDir, '..', '..', 'static');
  const destName = src.endsWith('.png') ? 'character.png' : 'character.webp';
  const dest = join(publicStatic, destName);
  copyFile(src, dest);
  for (const extra of ['character@2x.webp', 'blink.webp']) {
    const p = join(packDir, 'static', extra);
    if (existsSync(p)) copyFile(p, join(publicStatic, extra));
  }
  console.info(`static → ${rel(dest)}`);
}

function applyPack(packDir) {
  const manifest = readManifest(packDir);
  const mode = packMode(manifest);
  console.info(`character:apply ${rel(packDir)} id=${manifest.id} mode=${mode}`);

  if (mode === 'static') {
    applyStaticAsset(packDir, manifest);
  } else {
    const riveRel = manifest.assets?.rive || 'rive/character.riv';
    const riveSrc = join(packDir, riveRel);
    if (existsSync(riveSrc)) {
      copyFile(riveSrc, TARGETS.rive);
      console.info(`rive → ${rel(TARGETS.rive)}`);
    } else if (mode === 'rive') {
      throw new Error(`missing ${riveRel}`);
    }

    const spriteSrc = join(packDir, manifest.assets?.sprite || 'sprite');
    if (existsSync(join(spriteSrc, 'manifest.json'))) {
      copyTree(spriteSrc, TARGETS.spriteDir, { clean: false });
      console.info(`sprite → ${rel(TARGETS.spriteDir)}`);
    }
  }

  const voiceSrc = join(packDir, manifest.assets?.voice || 'voice');
  if (existsSync(voiceSrc)) {
    copyTree(voiceSrc, TARGETS.voiceDir, { clean: false });
    console.info(`voice → ${rel(TARGETS.voiceDir)}`);
  }

  const onboardingSrc = join(packDir, manifest.assets?.onboarding || 'onboarding');
  if (existsSync(onboardingSrc)) {
    for (const f of ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp']) {
      const src = join(onboardingSrc, f);
      if (existsSync(src)) copyFile(src, join(TARGETS.onboardingDir, f));
    }
    console.info(`onboarding → ${rel(TARGETS.onboardingDir)}`);
  }

  let generated = generatedFromManifest(manifest, packDir);
  if (mode === 'static') {
    generated.staticSrc = './assets/models/static/character.webp';
  }
  // Keep official nomi generated config bit-stable with character:init / no-op apply.
  if (manifest.id === 'nomi' && mode === 'rive') {
    generated = officialGenerated();
  }
  writeGenerated(generated);
  syncModelList(generated);
}

function ensureOfficial() {
  const expected = officialGenerated();
  let same;
  try {
    const cur = JSON.parse(readFileSync(GENERATED.renderer, 'utf8'));
    same = JSON.stringify(cur) === JSON.stringify(expected);
  } catch {
    same = false;
  }
  if (same) {
    console.info('character:apply (no CHARACTER_PACK): already official nomi — no-op');
    return;
  }
  writeGenerated(expected);
  console.info('character:apply (no CHARACTER_PACK): restored official nomi generated config');
}

const packEnv = process.env.CHARACTER_PACK?.trim();
try {
  if (!packEnv) {
    ensureOfficial();
  } else {
    applyPack(resolvePackDir(packEnv));
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
