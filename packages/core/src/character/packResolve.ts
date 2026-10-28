/**
 * Resolve the active character pack. Order: userData/character-pack → resources/character-pack →
 * the built-in pack (the one this build ships: characters/nomi unless the build chose another one;
 * the host passes its directory to createCore, see CharacterPackService).
 * The official character is an ordinary pack and goes through the same validation as any overlay;
 * invalid candidates are skipped with a reason for logging.
 *
 * Validation is `validatePack` from @nomi-ai/character-contract (no hand-written checks here).
 * Overlays are validated leniently: structural errors (manifest, schema, the mode's main asset,
 * onboarding art) still reject the pack, but non-structural checks (asset size, fallback assets,
 * voice manifests — `NON_STRUCTURAL_ISSUES`) only warn, so packs that loaded on 2.0.5 still load.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { NormalizedPack, PackManifest } from '@nomi-ai/character-contract';
import { NON_STRUCTURAL_ISSUES } from '@nomi-ai/character-contract';
import { validatePackDirSync } from '@nomi-ai/character-contract/node';

export type PackSource = 'userData' | 'resources' | 'builtin';

export interface HitboxRegion {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Hitboxes in the shape the renderer consumes (ratios of the character box). */
export interface PackHitboxes {
  regions: Record<string, HitboxRegion>;
  bubbleAnchor?: { x: number; y: number };
}

export interface ResolvedPack {
  source: PackSource;
  /** null only when not even the built-in pack could be loaded */
  root: string | null;
  manifest: PackManifest | null;
  pack: NormalizedPack | null;
  hitboxes: PackHitboxes | null;
  reason?: string;
  /** Non-structural problems a lenient (overlay) load let through, for logging. */
  downgraded?: string[];
}

export interface ResolvePackPaths {
  userDataPack: string;
  resourcesPack: string;
  /** Built-in pack directory (see builtinPackDir); omitted → no built-in fallback */
  builtinPack?: string | null;
}

export interface SkippedPack {
  source: PackSource;
  root: string;
  reason: string;
}

export type LoadPackResult =
  | { ok: true; pack: NormalizedPack; downgraded: string[] }
  | { ok: false; reason: string; pack: null };

export interface LoadPackOptions {
  /** Downgrade non-structural checks to warnings (runtime overlays). */
  lenient?: boolean;
}

/** Validate a pack directory with the contract; the reason is the first error. */
export function loadPackAt(root: string, opts: LoadPackOptions = {}): LoadPackResult {
  const res = validatePackDirSync(root, { lenient: opts.lenient });
  if (res.ok && res.pack) {
    const downgraded = res.warnings
      .filter((w) => NON_STRUCTURAL_ISSUES.includes(w.code))
      .map((w) => `${w.file}: ${w.message}`);
    return { ok: true, pack: res.pack, downgraded };
  }
  const first = res.errors[0];
  const reason = first ? `${first.file}: ${first.message}` : 'invalid character pack';
  return { ok: false, reason, pack: null };
}

/** Error message for an invalid pack, or null when it validates. */
export function validatePackRoot(root: string, opts: LoadPackOptions = {}): string | null {
  const r = loadPackAt(root, opts);
  return r.ok ? null : r.reason;
}

export function hitboxesOf(pack: NormalizedPack): PackHitboxes | null {
  const { hitboxes, bubbleAnchor } = pack.layout;
  if (!hitboxes || Object.keys(hitboxes).length === 0) return null;
  return {
    regions: hitboxes as Record<string, HitboxRegion>,
    ...(bubbleAnchor ? { bubbleAnchor } : {}),
  };
}

function resolved(source: PackSource, root: string, pack: NormalizedPack): ResolvedPack {
  return { source, root, manifest: pack.manifest, pack, hitboxes: hitboxesOf(pack) };
}

/**
 * Resolve the active pack. First valid candidate wins; invalid candidates are skipped (caller
 * should log `skipped` reasons). Overlay directories without a manifest are not candidates
 * (the packaged resources/character-pack placeholder only holds a README).
 */
export function resolveCharacterPack(
  paths: ResolvePackPaths,
): ResolvedPack & { skipped: SkippedPack[] } {
  const skipped: SkippedPack[] = [];
  const overlays: Array<{ source: Exclude<PackSource, 'builtin'>; root: string }> = [
    { source: 'userData', root: paths.userDataPack },
    { source: 'resources', root: paths.resourcesPack },
  ];
  for (const c of overlays) {
    if (!existsSync(path.join(c.root, 'manifest.json'))) continue;
    const r = loadPackAt(c.root, { lenient: true });
    if (!r.ok) {
      skipped.push({ source: c.source, root: c.root, reason: r.reason });
      continue;
    }
    const downgraded = r.downgraded.length ? { downgraded: r.downgraded } : {};
    return { ...resolved(c.source, c.root, r.pack), ...downgraded, skipped };
  }
  const overlayReason = skipped.length ? 'overlay invalid — using built-in' : 'no overlay present';
  if (paths.builtinPack) {
    const r = loadPackAt(paths.builtinPack);
    if (r.ok) {
      return { ...resolved('builtin', paths.builtinPack, r.pack), reason: overlayReason, skipped };
    }
    skipped.push({ source: 'builtin', root: paths.builtinPack, reason: r.reason });
  }
  return {
    source: 'builtin',
    root: null,
    manifest: null,
    pack: null,
    hitboxes: null,
    reason: paths.builtinPack ? 'built-in pack invalid' : overlayReason,
    skipped,
  };
}

export interface BuiltinPackEnv {
  packaged: boolean;
  /** development run (renderer from the Vite dev server) */
  dev: boolean;
  resourcesPath: string | undefined;
  /** app.getAppPath(): packages/host-electron when unpacked */
  appPath: string;
  /**
   * The pack the build selected (CHARACTER_PACK, relative to the repository root), unpacked runs only.
   * Only hosts pass it (Electron reads its build-time environment); core never reads the env.
   */
  characterPack?: string;
}

/**
 * Candidate directories of the built-in pack, best first. The renderer build emits the selected
 * pack into renderer/dist/character, which ships as resources/renderer/character (packaged) or
 * dist/renderer/character (copy-renderer, unpacked). In development the pack is read straight
 * from the repository (CHARACTER_PACK or characters/nomi).
 */
export function builtinPackCandidates(env: BuiltinPackEnv): string[] {
  if (env.packaged) {
    return env.resourcesPath ? [path.join(env.resourcesPath, 'renderer', 'character')] : [];
  }
  const repo = path.resolve(env.appPath, '..', '..');
  const fromSource = env.characterPack?.trim()
    ? path.resolve(repo, env.characterPack.trim())
    : path.join(repo, 'characters', 'nomi');
  const fromBuild = path.join(env.appPath, 'dist', 'renderer', 'character');
  return env.dev ? [fromSource] : [fromBuild, fromSource];
}

/** First built-in candidate that exists (validation happens in resolveCharacterPack). */
export function builtinPackDir(env: BuiltinPackEnv): string | null {
  return builtinPackCandidates(env).find((p) => existsSync(path.join(p, 'manifest.json'))) ?? null;
}
