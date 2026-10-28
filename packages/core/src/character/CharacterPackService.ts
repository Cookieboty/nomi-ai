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

import { CONTRACT, PRIMARY_CHARACTER_LOCALE, type PackMapping } from '@nomi-ai/character-contract';
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
  /** Character copy per language (`locales/<lang>.json` → lines, wakePhrase) */
  locales: Partial<Record<string, { lines?: Record<string, string>; wakePhrase?: string }>> | null;
  /**
   * 语义 → 资源（mapping.json，§10.5）；包没有 mapping.json 时为 null（运行时用引擎默认映射）。
   * 内置包也填，渲染进程以构建时打进去的那份为准。
   */
  mapping: PackMapping | null;
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
    const entry: NonNullable<(typeof out)[string]> = {};
    if (data?.lines) entry.lines = { ...data.lines };
    if (data?.wakePhrase) entry.wakePhrase = data.wakePhrase;
    if (entry.lines || entry.wakePhrase) out[lang] = entry;
  }
  return out;
}

/** The host's custom-scheme registrar (Electron `protocol` satisfies it). */
export type CharacterPackProtocolHost = Parameters<typeof registerCharacterPackProtocol>[0];

export interface CharacterPackServiceDeps {
  /** userData / resources / appPath decide where overlays and the built-in pack are looked up */
  ports: Pick<HostPorts, 'paths' | 'app'>;
  /**
   * The built-in pack directory, chosen by the host (Electron: the bundled pack; headless hosts and
   * e2e: a pack from the repository). `null` = no built-in pack (neutral persona). Omitted: the
   * default layout under `ports.paths` (packaged `resources/renderer/character`, unpacked
   * `<appPath>/dist/renderer/character` or `characters/nomi`). Never read from the process
   * environment, so cores in one process can use different built-in packs.
   */
  builtinPackDir?: string | null;
}

type PackLogger = { info: (m: string) => void; warn: (m: string) => void };

export class CharacterPackService {
  private readonly paths: HostPorts['paths'];
  private readonly appInfo: Pick<HostPorts['app'], 'isPackaged'>;
  private readonly builtinOverride: string | null | undefined;

  constructor(deps: CharacterPackServiceDeps) {
    this.paths = deps.ports.paths;
    this.appInfo = deps.ports.app;
    this.builtinOverride = deps.builtinPackDir;
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
    const builtinPack =
      this.builtinOverride !== undefined ? this.builtinOverride : this.defaultBuiltinPack();
    if (!builtinPack) logger?.warn('character-pack: built-in pack not found');
    this.builtinRoot = builtinPack;
    this.apply(resolveCharacterPack({ userDataPack, resourcesPack, builtinPack }), logger);
  }

  /** The built-in pack of the default layout (the host did not choose one) */
  private defaultBuiltinPack(): string | null {
    const packaged = this.appInfo.isPackaged();
    return builtinPackDir({
      packaged,
      dev: !packaged && process.env.NODE_ENV === 'development',
      resourcesPath: this.paths.resources(),
      appPath: this.paths.appPath(),
    });
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
   * Wake phrase of the active character (primary locale — wake detection runs on the zh model):
   * the active pack, else the built-in pack. Used when the user has not set one (§10.1).
   */
  wakePhrase(): string | undefined {
    for (const r of [this.resolved, this.getBuiltin()]) {
      const phrase = r?.pack?.locales[PRIMARY_CHARACTER_LOCALE]?.wakePhrase?.trim();
      if (phrase) return phrase;
    }
    return undefined;
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
      mapping: null,
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
      mapping: pack.mapping,
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
