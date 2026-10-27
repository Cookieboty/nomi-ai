/**
 * Build-time character pack identity (written by `pnpm character:apply`) plus
 * Scheme B runtime overlay (character-pack:get-active). Official path keeps id
 * `nomi` so behavior matches pre-pack builds when no overlay is present.
 */
import generated from './character.generated.json';

export type CharacterPackMode = 'rive' | 'sprite' | 'static';

export interface HitboxRegion {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PackHitboxes {
  regions: Record<string, HitboxRegion>;
  bubbleAnchor?: { x: number; y: number };
}

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
  /** Ratios of the character box; embedded by character:apply from layout/hitboxes.json */
  hitboxes?: PackHitboxes;
}

export type CharacterPackSource = 'userData' | 'resources' | 'builtin';

export interface CharacterPackOverlay {
  source: CharacterPackSource;
  id: string | null;
  mode: string | null;
  riveUrl: string | null;
  staticUrl: string | null;
  voiceBaseUrl: string | null;
  hitboxes: PackHitboxes | null;
  rive: { artboard: string; stateMachine: string } | null;
}

export const CHARACTER = generated as CharacterGenerated;

let overlay: CharacterPackOverlay | null = null;
let overlayLoaded = false;
let overlayPromise: Promise<void> | null = null;

function apiGetActive(): Promise<CharacterPackOverlay | null> {
  const w = window as unknown as {
    electronAPI?: { characterPack?: { getActive: () => Promise<CharacterPackOverlay> } };
  };
  const fn = w.electronAPI?.characterPack?.getActive;
  if (!fn) return Promise.resolve(null);
  return fn().catch(() => null);
}

/** Fetch Scheme B overlay once (no-op outside Electron). Safe to call repeatedly. */
export function ensureCharacterPackOverlay(): Promise<void> {
  if (overlayLoaded) return Promise.resolve();
  if (!overlayPromise) {
    overlayPromise = apiGetActive().then((snap) => {
      overlay = snap && snap.source !== 'builtin' ? snap : null;
      overlayLoaded = true;
    });
  }
  return overlayPromise;
}

/** Test / HMR helper */
export function resetCharacterPackOverlayForTest(): void {
  overlay = null;
  overlayLoaded = false;
  overlayPromise = null;
}

export function getOverlay(): CharacterPackOverlay | null {
  return overlay;
}

export function getCharacterId(): string {
  return overlay?.id || CHARACTER.id || 'nomi';
}

export function getCharacterMode(): CharacterPackMode {
  const m = (overlay?.mode || CHARACTER.mode || 'rive') as CharacterPackMode;
  return m === 'sprite' || m === 'static' || m === 'rive' ? m : 'rive';
}

export function getPromptClipBase(): string {
  return overlay?.voiceBaseUrl || CHARACTER.promptClipBase || './voice/nomi/zh/';
}

export function getRiveConfig(): { src: string; artboard: string; stateMachine: string } {
  const artboard = overlay?.rive?.artboard || CHARACTER.rive?.artboard || 'Nomi-full';
  const stateMachine = overlay?.rive?.stateMachine || CHARACTER.rive?.stateMachine || 'NomiFull';
  return {
    src: overlay?.riveUrl || CHARACTER.rive?.src || './assets/models/rive/nomi-complete.riv',
    artboard,
    stateMachine,
  };
}

export function getStaticSrc(): string {
  return overlay?.staticUrl || CHARACTER.staticSrc || './assets/models/static/character.webp';
}

/** Active hitboxes: overlay → generated → null (caller uses heuristic). */
export function getHitboxes(): PackHitboxes | null {
  return overlay?.hitboxes || CHARACTER.hitboxes || null;
}

/** True when prompt clips / character voice defaults apply to this model name. */
export function isActivePackModel(modelName: string | null | undefined): boolean {
  return (modelName ?? '').toLowerCase() === getCharacterId().toLowerCase();
}
