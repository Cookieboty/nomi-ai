/**
 * Build-time character pack identity (written by `pnpm character:apply`).
 * Official path keeps id `nomi` so behavior matches pre-pack builds.
 */
import generated from './character.generated.json';

export type CharacterPackMode = 'rive' | 'sprite' | 'static';

export interface CharacterGenerated {
  schema: 1;
  id: string;
  displayName: { zh: string; en: string };
  mode: CharacterPackMode;
  voice?: { voiceHint?: string; rate?: number; pitch?: number };
  rive?: { src: string; artboard: string; stateMachine: string };
  promptClipBase?: string;
  systemPromptIdentity?: string;
  wakePhrase?: { zh?: string; en?: string };
  spriteManifestPath?: string;
  staticSrc?: string;
}

export const CHARACTER = generated as CharacterGenerated;

export function getCharacterId(): string {
  return CHARACTER.id || 'nomi';
}

export function getCharacterMode(): CharacterPackMode {
  return CHARACTER.mode || 'rive';
}

export function getPromptClipBase(): string {
  return CHARACTER.promptClipBase || './voice/nomi/zh/';
}

export function getRiveConfig(): { src: string; artboard: string; stateMachine: string } {
  return {
    src: CHARACTER.rive?.src || './assets/models/rive/nomi-complete.riv',
    artboard: CHARACTER.rive?.artboard || 'Nomi-full',
    stateMachine: CHARACTER.rive?.stateMachine || 'NomiFull',
  };
}

export function getStaticSrc(): string {
  return CHARACTER.staticSrc || './assets/models/static/character.webp';
}

/** True when prompt clips / character voice defaults apply to this model name. */
export function isActivePackModel(modelName: string | null | undefined): boolean {
  return (modelName ?? '').toLowerCase() === getCharacterId().toLowerCase();
}
