/**
 * Onboarding illustrations come from the character pack this build ships: the Vite plugin
 * (scripts/character/vite-plugin.mjs) serves / emits the pack's onboarding/*.webp at
 * `./character/onboarding/`. A Scheme B overlay swaps in character-pack:// URLs when the active
 * pack ships its own.
 */
import { api, hasTransport, hostAssetUrl } from '../../services/api';

export type OnboardingStep = 'welcome' | 'profile' | 'provider' | 'privacy';

const BUILTIN_BASE = './character/onboarding/';

export const BUILTIN_ONBOARDING_ART: Record<OnboardingStep, string> = {
  welcome: `${BUILTIN_BASE}welcome.webp`,
  profile: `${BUILTIN_BASE}profile.webp`,
  provider: `${BUILTIN_BASE}provider.webp`,
  privacy: `${BUILTIN_BASE}privacy.webp`,
};

export async function resolveOnboardingArt(): Promise<Record<OnboardingStep, string>> {
  if (!hasTransport()) return { ...BUILTIN_ONBOARDING_ART };
  try {
    const snap = await api.character.getActivePack();
    if (snap.source !== 'builtin' && snap.onboarding) {
      const own = Object.fromEntries(
        Object.entries(snap.onboarding).map(([k, v]) => [k, v ? hostAssetUrl(v) : v]),
      );
      return { ...BUILTIN_ONBOARDING_ART, ...own };
    }
  } catch {
    /* browser / tests */
  }
  return { ...BUILTIN_ONBOARDING_ART };
}
