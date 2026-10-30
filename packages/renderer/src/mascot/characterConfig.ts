/**
 * The character pack this build ships (`virtual:character-pack`, read from the selected pack by
 * scripts/character/vite-plugin.mjs — characters/nomi unless CHARACTER_PACK is set) plus the
 * Scheme B runtime overlay (character-pack:get-active). The built-in pack is served at
 * `./character/…`; an overlay serves its own files over character-pack://.
 *
 * Overlay load is async; UI must subscribe via `useCharacterPackReady` (or
 * `subscribeCharacterPackOverlay`) so mode / asset URLs re-render after resolve.
 */
import type { PackMapping } from '@nomi-ai/character-contract';
import { useSyncExternalStore } from 'react';
import bundledPack from 'virtual:character-pack';

import { api, hasTransport, hostAssetUrl } from '../services/api';

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

/** Character copy of one language (`locales/<lang>.json` of the pack). */
export interface CharacterLocaleLines {
  lines?: Record<string, string>;
}

export type CharacterPackSource = 'userData' | 'resources' | 'builtin';

export interface CharacterPackOverlay {
  source: CharacterPackSource;
  id: string | null;
  mode: string | null;
  /** Character full name per UI language (persona.json / locales/en.json persona) */
  displayName?: { zh: string; en: string } | null;
  /** Character short name per UI language; absent on older main processes */
  shortName?: { zh: string; en: string } | null;
  riveUrl: string | null;
  staticUrl: string | null;
  voiceBaseUrl: string | null;
  /** Null unless the overlay ships sprite/manifest.json. */
  spriteManifestUrl: string | null;
  hitboxes: PackHitboxes | null;
  rive: { artboard: string; stateMachine: string } | null;
  /** Character copy per language; absent on older main processes. */
  locales?: Partial<Record<string, CharacterLocaleLines>> | null;
  /** Semantic → resource mapping (mapping.json); null when the pack has none. */
  mapping?: PackMapping | null;
}

/** The pack bundled with this build. */
export const BUNDLED_PACK = bundledPack;

function bundledUrl(rel: string | null | undefined): string | null {
  return rel ? `${BUNDLED_PACK.base}${rel}` : null;
}

function bundledHitboxes(): PackHitboxes | null {
  const { hitboxes, bubbleAnchor } = BUNDLED_PACK.layout;
  if (!hitboxes) return null;
  return {
    regions: hitboxes as Record<string, HitboxRegion>,
    ...(bubbleAnchor ? { bubbleAnchor } : {}),
  };
}

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
  if (!hasTransport()) return Promise.resolve(null);
  return api.character.getActivePack().then(
    (snap): CharacterPackOverlay => withHostUrls(snap),
    () => null,
  );
}

/** 覆盖包的 `character-pack://` 地址换成本页能加载的地址（Go 宿主走资产网关；Electron 原样） */
function withHostUrls(snap: CharacterPackOverlay): CharacterPackOverlay {
  const u = (v: string | null): string | null => (v ? hostAssetUrl(v) : v);
  return {
    ...snap,
    riveUrl: u(snap.riveUrl),
    staticUrl: u(snap.staticUrl),
    voiceBaseUrl: u(snap.voiceBaseUrl),
    spriteManifestUrl: u(snap.spriteManifestUrl),
  };
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
  return overlay?.id || BUNDLED_PACK.id;
}

export function getCharacterMode(): CharacterPackMode {
  const m = (overlay?.mode || BUNDLED_PACK.mode || 'rive') as CharacterPackMode;
  return m === 'sprite' || m === 'static' || m === 'rive' ? m : 'rive';
}

/** Prompt clips are zh only (contract: zh is the one required voice locale). */
export function getPromptClipBase(): string {
  return overlay?.voiceBaseUrl || `${BUNDLED_PACK.base}${BUNDLED_PACK.assets.voiceDir}/zh/`;
}

/** Rive file + artboard / state machine; a pack that names neither gets the file's defaults. */
export function getRiveConfig(): { src: string; artboard?: string; stateMachine?: string } {
  const artboard = overlay?.rive?.artboard || BUNDLED_PACK.rive?.artboard || undefined;
  const stateMachine = overlay?.rive?.stateMachine || BUNDLED_PACK.rive?.stateMachine || undefined;
  return {
    src: overlay?.riveUrl || bundledUrl(BUNDLED_PACK.assets.rive) || '',
    artboard,
    stateMachine,
  };
}

export function getStaticSrc(): string {
  return overlay?.staticUrl || bundledUrl(BUNDLED_PACK.assets.static) || '';
}

/** Overlay sprite manifest when the pack ships one, otherwise the caller's built-in path. */
export function getSpriteManifestPath(fallback: string): string {
  return overlay?.spriteManifestUrl || fallback;
}

/** Active hitboxes: overlay → bundled pack → null (caller uses heuristic). */
export function getHitboxes(): PackHitboxes | null {
  return overlay ? overlay.hitboxes : bundledHitboxes();
}

/** Character copy of the active pack (overlay locales replace the bundled ones). */
export function getCharacterLocales(): Partial<Record<string, CharacterLocaleLines>> {
  return overlay ? (overlay.locales ?? {}) : BUNDLED_PACK.locales;
}

/**
 * True when prompt clips / character voice defaults apply to this model name.
 * model-list.json is generated from the bundled pack at build time, so a runtime overlay still
 * occupies the built-in model slot (BUNDLED_PACK.id) — accept both that name and the overlay id.
 */
export function isActivePackModel(modelName: string | null | undefined): boolean {
  const name = (modelName ?? '').toLowerCase();
  if (!name) return false;
  return name === getCharacterId().toLowerCase() || name === BUNDLED_PACK.id.toLowerCase();
}
