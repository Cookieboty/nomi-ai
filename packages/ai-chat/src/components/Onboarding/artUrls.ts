/**
 * Onboarding illustrations: bundled Vite imports by default; Scheme B overlay
 * swaps in character-pack:// URLs when an active pack ships onboarding/*.webp.
 */
import privacyArt from './art/privacy.webp';
import profileArt from './art/profile.webp';
import providerArt from './art/provider.webp';
import welcomeArt from './art/welcome.webp';

export type OnboardingStep = 'welcome' | 'profile' | 'provider' | 'privacy';

export const BUILTIN_ONBOARDING_ART: Record<OnboardingStep, string> = {
  welcome: welcomeArt,
  profile: profileArt,
  provider: providerArt,
  privacy: privacyArt,
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
