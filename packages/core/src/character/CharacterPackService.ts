/**
/**
 * Active character pack service.
 * Resolves userData/character-pack → resources/character-pack → the built-in pack (the pack this
 * build ships; the official character is an ordinary pack too); exposes the IPC snapshot and the
 * character-pack:// protocol for overlays.
 *
 * No electron import: directories come from host ports; the host hands its protocol registrar
 * (Electron `protocol`) to `init`, so the scheme registration itself stays on the host side.
 */
import path from 'node:path';

import { CONTRACT } from '@nomi-ai/character-contract';
import type { HostPorts } from '@nomi-ai/host-ports';

import { characterPackAssetUrl, registerCharacterPackProtocol } from './packProtocol';
import {
  builtinPackDir,
  loadPackAt,
  resolveCharacterPack,
  type PackHitboxes,
  type PackSource,
  type ResolvedPack,
  type SkippedPack,
} from './packResolve';

export interface CharacterPackActiveSnapshot {
  source: PackSource;
  id: string | null;
  mode: string | null;
  displayName: { zh: string; en: string } | null;
  /** Non-null when an overlay is active — use with character-pack://pack/... */
  assetBaseUrl: string | null;
  onboarding: Record<'welcome' | 'profile' | 'provider' | 'privacy', string> | null;
  voiceBaseUrl: string | null;
  riveUrl: string | null;
  staticUrl: string | null;
  spriteManifestUrl: string | null;
  hitboxes: PackHitboxes | null;
  rive: { artboard: string; stateMachine: string } | null;
  /** Character copy per language (`locales/<lang>.json` → lines) */
  locales: Partial<Record<string, { lines?: Record<string, string> }>> | null;
  reason?: string;
}

/** Display name per language: persona.json (zh) and the en locale's persona override. */
function displayNameOf(pack: NonNullable<ResolvedPack['pack']>): { zh: string; en: string } {
  const m = pack.manifest;
  const legacy = typeof m.displayName === 'string' ? { zh: m.displayName } : (m.displayName ?? {});
  const zh = pack.persona?.displayName || legacy.zh || m.id;
  const en = pack.locales.en?.persona?.displayName || legacy.en || zh;
  return { zh, en };
}

function linesOf(pack: NonNullable<ResolvedPack['pack']>): CharacterPackActiveSnapshot['locales'] {
  const out: NonNullable<CharacterPackActiveSnapshot['locales']> = {};
  for (const [lang, data] of Object.entries(pack.locales)) {
    if (data?.lines) out[lang] = { lines: { ...data.lines } };
  }
  return out;
}

/** The host's custom-scheme registrar (Electron `protocol` satisfies it). */
export type CharacterPackProtocolHost = Parameters<typeof registerCharacterPackProtocol>[0];

export interface CharacterPackServiceDeps {
  /** userData / resources / appPath decide where overlays and the built-in pack are looked up */
  ports: Pick<HostPorts, 'paths' | 'app'>;
}

type PackLogger = { info: (m: string) => void; warn: (m: string) => void };

export class CharacterPackService {
  private readonly paths: HostPorts['paths'];
  private readonly appInfo: Pick<HostPorts['app'], 'isPackaged'>;

  constructor(deps: CharacterPackServiceDeps) {
    this.paths = deps.ports.paths;
    this.appInfo = deps.ports.app;
  }

  private resolved: ResolvedPack = {
    source: 'builtin',
    root: null,
    manifest: null,
    pack: null,
    hitboxes: null,
    reason: 'not yet resolved',
  };

  private builtinRoot: string | null = null;
  private builtinCache: { root: string; resolved: ResolvedPack | null } | null = null;
  private readonly listeners = new Set<(resolved: ResolvedPack) => void>();
  private protocolRegistered = false;

  /** Call once after the host is ready (paths resolved, protocol registrar usable). */
  init(protocol: CharacterPackProtocolHost, logger?: PackLogger): void {
    this.reload(logger);
    if (!this.protocolRegistered) {
      registerCharacterPackProtocol(protocol, () => this.resolved.root);
      this.protocolRegistered = true;
    }
  }

  /**
   * Re-resolve the active pack (userData → resources → built-in) and notify `onChange` listeners
   * (persona, …). Listeners re-read the pack and decide themselves whether anything changed.
   */
  reload(logger?: PackLogger): void {
    const userDataPack = path.join(this.paths.userData(), 'character-pack');
    const resourcesPack = path.join(
      this.paths.resources() || this.paths.appPath(),
      'character-pack',
    );
    const packaged = this.appInfo.isPackaged();
    const builtinPack = builtinPackDir({
      packaged,
      dev: !packaged && process.env.NODE_ENV === 'development',
      resourcesPath: this.paths.resources(),
      appPath: this.paths.appPath(),
      characterPack: process.env.CHARACTER_PACK,
    });
    if (!builtinPack) logger?.warn('character-pack: built-in pack not found');
    this.builtinRoot = builtinPack;
    this.apply(resolveCharacterPack({ userDataPack, resourcesPack, builtinPack }), logger);
  }

  /** Called after every (re-)resolution of the active pack. Returns unsubscribe. */
  onChange(fn: (resolved: ResolvedPack) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Swap in a resolution result (used by `reload`; tests pass a result directly). */
  apply(result: ResolvedPack & { skipped?: SkippedPack[] }, logger?: PackLogger): void {
    for (const s of result.skipped ?? []) {
      logger?.warn(`character-pack skipped (${s.source}): ${s.reason} @ ${s.root}`);
    }
    for (const d of result.downgraded ?? []) {
      logger?.warn(`character-pack ${result.source}: ${d} (accepted, check the pack)`);
    }
    const { skipped: _s, ...resolved } = result;
    this.resolved = resolved;
    if (resolved.source === 'builtin' && resolved.root) this.builtinRoot = resolved.root;
    if (resolved.source === 'builtin') {
      logger?.info(
        `character-pack: built-in id=${resolved.manifest?.id ?? '-'} (${resolved.reason || 'no overlay'})`,
      );
    } else {
      logger?.info(
        `character-pack: overlay source=${resolved.source} id=${resolved.manifest?.id} @ ${resolved.root}`,
      );
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(resolved);
      } catch (e) {
        logger?.warn(`character-pack change listener failed: ${String(e)}`);
      }
    }
  }

  getRoot(): string | null {
    return this.resolved.root;
  }

  getResolved(): ResolvedPack {
    return this.resolved;
  }

  /**
   * The built-in pack (what this build ships), even while an overlay is active — the persona
   * falls back to it when an overlay has none. null when the built-in pack is missing / invalid.
   */
  getBuiltin(): ResolvedPack | null {
    if (this.resolved.source === 'builtin') return this.resolved.root ? this.resolved : null;
    const root = this.builtinRoot;
    if (!root) return null;
    if (this.builtinCache?.root !== root) {
      const r = loadPackAt(root);
      this.builtinCache = {
        root,
        resolved: r.ok
          ? { source: 'builtin', root, manifest: r.pack.manifest, pack: r.pack, hitboxes: null }
          : null,
      };
    }
    return this.builtinCache.resolved;
  }

  /**
   * Snapshot for the views. For the built-in pack only identity and copy are filled: the views
   * ship the same pack in their own bundle (served at ./character/), so asset URLs stay null.
   */
  getActive(): CharacterPackActiveSnapshot {
    const r = this.resolved;
    const empty: CharacterPackActiveSnapshot = {
      source: 'builtin',
      id: null,
      mode: null,
      displayName: null,
      assetBaseUrl: null,
      onboarding: null,
      voiceBaseUrl: null,
      riveUrl: null,
      staticUrl: null,
      spriteManifestUrl: null,
      hitboxes: null,
      rive: null,
      locales: null,
      reason: r.reason,
    };
    if (!r.root || !r.pack) return empty;
    const pack = r.pack;
    const identity = {
      id: pack.manifest.id,
      mode: pack.mode,
      displayName: displayNameOf(pack),
      hitboxes: r.hitboxes,
      locales: linesOf(pack),
    };
    if (r.source === 'builtin') return { ...empty, ...identity };
    const onboardingDir = `${pack.assets.onboardingDir}/`;
    const url = (rel: string | null) => (rel ? characterPackAssetUrl(rel) : null);
    return {
      source: r.source,
      ...identity,
      assetBaseUrl: characterPackAssetUrl(''),
      onboarding: {
        welcome: characterPackAssetUrl(`${onboardingDir}welcome.webp`),
        profile: characterPackAssetUrl(`${onboardingDir}profile.webp`),
        provider: characterPackAssetUrl(`${onboardingDir}provider.webp`),
        privacy: characterPackAssetUrl(`${onboardingDir}privacy.webp`),
      },
      // Prompt clips only play on zh-CN (contract: zh is the one required locale). Kept even when the
      // pack ships no voice — a 404 manifest falls through to realtime TTS instead of the built-in clips.
      voiceBaseUrl: characterPackAssetUrl(`${pack.assets.voiceDir}/zh/`),
      riveUrl: pack.mode === 'rive' ? url(pack.assets.rive) : null,
      staticUrl: pack.mode === 'static' ? url(pack.assets.static) : null,
      spriteManifestUrl: url(pack.assets.spriteManifest),
      rive:
        pack.mode === 'rive'
          ? {
              artboard: pack.manifest.rive?.artboard || CONTRACT.rive.artboard,
              stateMachine: pack.manifest.rive?.stateMachine || CONTRACT.rive.stateMachine,
            }
          : null,
      reason: undefined,
    };
  }
}
