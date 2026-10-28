/**
 * Onboarding illustrations come from the character pack this build ships: the Vite plugin
 * (scripts/character/vite-plugin.mjs) serves / emits the pack's onboarding/*.webp at
 * `./character/onboarding/`. A Scheme B overlay swaps in character-pack:// URLs when the active
 * pack ships its own.
 */
export type OnboardingStep = 'welcome' | 'profile' | 'provider' | 'privacy';

const BUILTIN_BASE = './character/onboarding/';

export const BUILTIN_ONBOARDING_ART: Record<OnboardingStep, string> = {
  welcome: `${BUILTIN_BASE}welcome.webp`,
  profile: `${BUILTIN_BASE}profile.webp`,
  provider: `${BUILTIN_BASE}provider.webp`,
  privacy: `${BUILTIN_BASE}privacy.webp`,
};

export async function resolveOnboardingArt(): Promise<Record<OnboardingStep, string>> {
  const w = window as unknown as {
    electronAPI?: {
      characterPack?: {
        getActive: () => Promise<{
          source: string;
          onboarding: Record<OnboardingStep, string> | null;
        }>;
      };
    };
  };
  try {
    const snap = await w.electronAPI?.characterPack?.getActive();
    if (snap?.source !== 'builtin' && snap?.onboarding) {
      return { ...BUILTIN_ONBOARDING_ART, ...snap.onboarding };
    }
  } catch {
    /* browser / tests */
  }
  return { ...BUILTIN_ONBOARDING_ART };
}
