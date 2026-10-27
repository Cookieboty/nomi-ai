#!/usr/bin/env node
/**
 * character:init — export current tree assets into examples/nomi.pack (idempotent).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { copyFile, copyTree, loadContract, officialGenerated, rel, writeJson } from './lib.mjs';
import { EXAMPLES_NOMI, GENERATED, TARGETS } from './paths.mjs';

const pack = EXAMPLES_NOMI;
const contract = loadContract();

const manifest = {
  schema: 1,
  id: 'nomi',
  displayName: { zh: '诺米', en: 'Nomi' },
  version: '1.0.0',
  engines: { nomiPack: '>=1 <2' },
  assets: {
    mode: 'rive',
    rive: 'rive/character.riv',
    sprite: 'sprite/',
    voice: 'voice/',
    onboarding: 'onboarding/',
    copy: 'copy/',
    layout: 'layout/',
  },
  rive: {
    artboard: contract.rive.artboard,
    stateMachine: contract.rive.stateMachine,
  },
  defaults: {
    wakePhrase: { zh: '你好，诺米', en: 'Hi, Nomi' },
    primaryLocale: 'zh',
    voiceHint: 'nomi',
    voiceRate: 0.92,
    voicePitch: 1.1,
  },
  capabilities: {
    riveMotions: contract.rive.nativeMotions,
    spriteActions: contract.sprite.actionIds,
    voiceClipIds: contract.voice.requiredClipIds,
  },
};

writeJson(join(pack, 'manifest.json'), manifest);
copyFile(TARGETS.rive, join(pack, 'rive/character.riv'));
copyTree(TARGETS.spriteDir, join(pack, 'sprite'), { clean: true });
copyTree(TARGETS.voiceDir, join(pack, 'voice'), { clean: true });
for (const f of contract.onboarding.files) {
  copyFile(join(TARGETS.onboardingDir, f), join(pack, 'onboarding', f));
}

writeJson(join(pack, 'copy/zh.json'), {
  displayName: '诺米',
  wakePhrase: '你好，诺米',
  systemPromptIdentity: '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。',
});
writeJson(join(pack, 'copy/en.json'), {
  displayName: 'Nomi',
  wakePhrase: 'Hi, Nomi',
  systemPromptIdentity: 'You are Nomi, an AI companion living on the user desktop.',
});

const persona = join(pack, 'persona/system-prompt.md');
mkdirSync(dirname(persona), { recursive: true });
writeFileSync(persona, '你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。\n保持简短、有情感的回复。\n');

writeJson(join(pack, 'layout/hitboxes.json'), {
  note: 'ratios of character box; hem is the lower garment region',
  regions: {
    head: { top: 0.04, bottom: 0.28, left: 0.16, right: 0.84 },
    face: { top: 0.1, bottom: 0.32, left: 0.22, right: 0.78 },
    body: { top: 0.28, bottom: 0.6, left: 0.18, right: 0.82 },
    hand: { top: 0.45, bottom: 0.7, left: 0.05, right: 0.95 },
    hem: { top: 0.6, bottom: 1.0, left: 0.15, right: 0.85 },
  },
});

const generated = officialGenerated();
for (const dest of Object.values(GENERATED)) {
  writeJson(dest, generated);
}

console.info(`character:init → ${rel(pack)}`);
