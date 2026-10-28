/**
 * Build-time character pack identity (written by `pnpm character:apply`) plus
 * Scheme B runtime overlay (character-pack:get-active). Official path keeps id
 * `nomi` so behavior matches pre-pack builds when no overlay is present.
 *
 * Overlay load is async; UI must subscribe via `useCharacterPackReady` (or
 * `subscribeCharacterPackOverlay`) so mode / asset URLs re-render after resolve.
 */
import { useSyncExternalStore } from 'react';

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
  /** Null unless the overlay ships sprite/manifest.json. */
  spriteManifestUrl: string | null;
  hitboxes: PackHitboxes | null;
  rive: { artboard: string; stateMachine: string } | null;
}

export const CHARACTER = generated as CharacterGenerated;

let overlay: CharacterPackOverlay | null = null;
let overlayLoaded = false;
let overlayPromise: Promise<void> | null = null;
/** Bumps on each overlay settle so useSyncExternalStore re-renders. */
let overlayEpoch = 0;
const overlayListeners = new Set<() => void>();

function notifyOverlayListeners(): void {
  overlayEpoch += 1;
  for (const fn of overlayListeners) fn();
}

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
      notifyOverlayListeners();
    });
  }
  return overlayPromise;
}

/** Subscribe to overlay readiness / snapshot changes (e.g. after ensure settles). */
export function subscribeCharacterPackOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  // Kick the load for subscribers that never call ensure themselves.
  void ensureCharacterPackOverlay();
  return () => {
    overlayListeners.delete(listener);
  };
}

export function isCharacterPackOverlayReady(): boolean {
  return overlayLoaded;
}

/** Test / HMR helper */
export function resetCharacterPackOverlayForTest(): void {
  overlay = null;
  overlayLoaded = false;
  overlayPromise = null;
  notifyOverlayListeners();
}

/**
 * React: true once Scheme B overlay IPC has settled (builtin or overlay).
 * Re-renders consumers so mode / riveUrl / staticUrl read after readiness.
 */
export function useCharacterPackReady(): boolean {
  const epoch = useSyncExternalStore(
    subscribeCharacterPackOverlay,
    () => (overlayLoaded ? overlayEpoch : -1),
    () => 0,
  );
  return epoch >= 0;
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

/** Overlay sprite manifest when the pack ships one, otherwise the caller's built-in path. */
export function getSpriteManifestPath(fallback: string): string {
  return overlay?.spriteManifestUrl || fallback;
}

/** Active hitboxes: overlay → generated → null (caller uses heuristic). */
export function getHitboxes(): PackHitboxes | null {
  return overlay?.hitboxes || CHARACTER.hitboxes || null;
}

/**
 * True when prompt clips / character voice defaults apply to this model name.
 * model-list.json is only rewritten at build time (character:apply), so a runtime overlay still
 * occupies the built-in model slot (CHARACTER.id) — accept both that name and the overlay id.
 */
export function isActivePackModel(modelName: string | null | undefined): boolean {
  const name = (modelName ?? '').toLowerCase();
  if (!name) return false;
  return name === getCharacterId().toLowerCase() || name === (CHARACTER.id || 'nomi').toLowerCase();
}
