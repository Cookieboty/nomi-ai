/**
 * Scheme B runtime overlay service.
 * Resolves userData/character-pack → resources/character-pack → built-in;
 * exposes IPC snapshot + character-pack:// protocol.
 */
import path from 'node:path';

import { app, protocol } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

import {
  characterPackAssetUrl,
  normalizePackRelPath,
  registerCharacterPackProtocol,
} from './packProtocol';
import {
  packModeOf,
  resolveCharacterPack,
  resolveSpriteManifestRel,
  resolveStaticRel,
  type PackHitboxes,
  type PackSource,
  type ResolvedPack,
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
  reason?: string;
}

function displayNameOf(m: NonNullable<ResolvedPack['manifest']>): { zh: string; en: string } {
  const dn = m.displayName;
  if (!dn) return { zh: m.id, en: m.id };
  if (typeof dn === 'string') return { zh: dn, en: dn };
  return { zh: dn.zh || m.id, en: dn.en || dn.zh || m.id };
}

export class CharacterPackService {
  private resolved: ResolvedPack = {
    source: 'builtin',
    root: null,
    manifest: null,
    hitboxes: null,
    reason: 'not yet resolved',
  };

  /** Call once after app.whenReady (needs app.getPath). */
  init(logger?: { info: (m: string) => void; warn: (m: string) => void }): void {
    const userDataPack = path.join(app.getPath('userData'), 'character-pack');
    const resourcesPack = path.join(process.resourcesPath || app.getAppPath(), 'character-pack');
    const result = resolveCharacterPack({ userDataPack, resourcesPack });
    for (const s of result.skipped) {
      logger?.warn(`character-pack overlay skipped (${s.source}): ${s.reason} @ ${s.root}`);
    }
    const { skipped: _s, ...resolved } = result;
    this.resolved = resolved;
    if (resolved.source === 'builtin') {
      logger?.info(`character-pack: built-in (${resolved.reason || 'no overlay'})`);
    } else {
      logger?.info(
        `character-pack: overlay source=${resolved.source} id=${resolved.manifest?.id} @ ${resolved.root}`,
      );
    }
    registerCharacterPackProtocol(protocol, () => this.resolved.root);
  }

  getRoot(): string | null {
    return this.resolved.root;
  }

  getResolved(): ResolvedPack {
    return this.resolved;
  }

  getActive(): CharacterPackActiveSnapshot {
    const r = this.resolved;
    if (r.source === 'builtin' || !r.root || !r.manifest) {
      return {
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
        reason: r.reason,
      };
    }
    const mode = packModeOf(r.manifest);
    const onboardingDir = `${normalizePackRelPath(r.manifest.assets?.onboarding || 'onboarding') || 'onboarding'}/`;
    const voiceDir = `${normalizePackRelPath(r.manifest.assets?.voice || 'voice') || 'voice'}/`;
    const riveRel =
      normalizePackRelPath(r.manifest.assets?.rive || 'rive/character.riv') || 'rive/character.riv';
    const staticRel = resolveStaticRel(r.root, r.manifest);
    const spriteManifestRel = resolveSpriteManifestRel(r.root, r.manifest);
    return {
      source: r.source,
      id: r.manifest.id,
      mode,
      displayName: displayNameOf(r.manifest),
      assetBaseUrl: characterPackAssetUrl(''),
      onboarding: {
        welcome: characterPackAssetUrl(`${onboardingDir}welcome.webp`),
        profile: characterPackAssetUrl(`${onboardingDir}profile.webp`),
        provider: characterPackAssetUrl(`${onboardingDir}provider.webp`),
        privacy: characterPackAssetUrl(`${onboardingDir}privacy.webp`),
      },
      // Prompt clips only play on zh-CN (contract: zh is the one required locale). Kept even when the
      // pack ships no voice — a 404 manifest falls through to realtime TTS instead of Nomi's clips.
      voiceBaseUrl: characterPackAssetUrl(`${voiceDir}zh/`),
      riveUrl: mode === 'rive' ? characterPackAssetUrl(riveRel) : null,
      staticUrl: mode === 'static' && staticRel ? characterPackAssetUrl(staticRel) : null,
      spriteManifestUrl: spriteManifestRel ? characterPackAssetUrl(spriteManifestRel) : null,
      hitboxes: r.hitboxes,
      rive: {
        artboard: r.manifest.rive?.artboard || 'Nomi-full',
        stateMachine: r.manifest.rive?.stateMachine || 'NomiFull',
      },
      reason: undefined,
    };
  }

  registerIpc(): void {
    guardedHandle('character-pack:get-active', () => this.getActive(), {
      owner: 'CharacterPackService',
      wrapErrors: false,
    });
  }
}

let singleton: CharacterPackService | null = null;

export function getCharacterPackService(): CharacterPackService {
  if (!singleton) singleton = new CharacterPackService();
  return singleton;
}

/** Test helper */
export function resetCharacterPackServiceForTest(): void {
  singleton = null;
}
