/**
 * Scheme B: resolve a single runtime character-pack overlay.
 * Order: userData/character-pack → resources/character-pack → built-in (null).
 * Invalid packs fall back to built-in and surface a reason for logging.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type PackSource = 'userData' | 'resources' | 'builtin';

export interface PackManifestLite {
  schema: number;
  id: string;
  displayName?: string | { zh?: string; en?: string };
  version?: string;
  assets?: {
    mode?: string;
    static?: string;
    rive?: string;
    sprite?: string;
    voice?: string;
    onboarding?: string;
    layout?: string;
  };
  mode?: string;
  rive?: { artboard?: string; stateMachine?: string };
  defaults?: Record<string, unknown>;
}

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

export interface ResolvedPack {
  source: PackSource;
  root: string | null;
  manifest: PackManifestLite | null;
  hitboxes: PackHitboxes | null;
  reason?: string;
}

export interface ResolvePackPaths {
  userDataPack: string;
  resourcesPack: string;
}

const ONBOARDING_FILES = ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp'] as const;

export function readManifestAt(root: string): PackManifestLite | null {
  const path = join(root, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackManifestLite;
  } catch {
    return null;
  }
}

/** Minimal validation for a runtime overlay pack. Returns error message or null if OK. */
export function validatePackRoot(root: string): string | null {
  if (!existsSync(root) || !statSync(root).isDirectory()) return 'missing pack directory';
  const m = readManifestAt(root);
  if (!m) return 'missing or invalid manifest.json';
  if (m.schema !== 1) return `unsupported pack schema: ${m.schema}`;
  if (!m.id || typeof m.id !== 'string') return 'manifest.id required';
  const mode = m.assets?.mode || m.mode || 'rive';
  if (!['rive', 'sprite', 'static'].includes(mode)) return `unknown mode: ${mode}`;

  const onboardingDir = join(root, m.assets?.onboarding || 'onboarding');
  for (const f of ONBOARDING_FILES) {
    if (!existsSync(join(onboardingDir, f))) return `missing onboarding/${f}`;
  }

  if (mode === 'static') {
    const candidates = [
      join(root, m.assets?.static || 'static/character.webp'),
      join(root, 'static/character.webp'),
      join(root, 'static/character.png'),
    ];
    if (!candidates.some((p) => existsSync(p))) return 'static mode missing static/character.webp';
  } else if (mode === 'rive') {
    const riveRel = m.assets?.rive || 'rive/character.riv';
    if (!existsSync(join(root, riveRel))) return `missing ${riveRel}`;
  } else if (mode === 'sprite') {
    const spriteDir = join(root, m.assets?.sprite || 'sprite');
    if (!existsSync(join(spriteDir, 'manifest.json'))) return 'sprite/manifest.json required';
  }
  return null;
}

export function loadHitboxes(root: string, manifest: PackManifestLite): PackHitboxes | null {
  const layoutRel = manifest.assets?.layout || 'layout';
  const path = join(root, layoutRel, 'hitboxes.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      regions?: Record<string, HitboxRegion>;
      bubbleAnchor?: { x: number; y: number };
      aliases?: Record<string, string>;
    };
    if (!raw.regions || typeof raw.regions !== 'object') return null;
    const regions: Record<string, HitboxRegion> = { ...raw.regions };
    // Normalize legacy skirt → hem if a pack still ships skirt
    if (regions.skirt && !regions.hem) {
      regions.hem = regions.skirt;
      delete regions.skirt;
    }
    return { regions, bubbleAnchor: raw.bubbleAnchor };
  } catch {
    return null;
  }
}

/**
 * Resolve the active overlay. First valid candidate wins; invalid candidates are skipped
 * (caller should log `skipped` reasons). When nothing validates → builtin.
 */
export function resolveCharacterPack(
  paths: ResolvePackPaths,
): ResolvedPack & { skipped: Array<{ source: PackSource; root: string; reason: string }> } {
  const skipped: Array<{ source: PackSource; root: string; reason: string }> = [];
  const candidates: Array<{ source: Exclude<PackSource, 'builtin'>; root: string }> = [
    { source: 'userData', root: paths.userDataPack },
    { source: 'resources', root: paths.resourcesPack },
  ];
  for (const c of candidates) {
    if (!existsSync(c.root)) continue;
    const err = validatePackRoot(c.root);
    if (err) {
      skipped.push({ source: c.source, root: c.root, reason: err });
      continue;
    }
    const manifest = readManifestAt(c.root)!;
    return {
      source: c.source,
      root: c.root,
      manifest,
      hitboxes: loadHitboxes(c.root, manifest),
      skipped,
    };
  }
  return {
    source: 'builtin',
    root: null,
    manifest: null,
    hitboxes: null,
    reason: skipped.length ? 'overlay invalid — using built-in' : 'no overlay present',
    skipped,
  };
}

export function packModeOf(m: PackManifestLite): string {
  return m.assets?.mode || m.mode || 'rive';
}
