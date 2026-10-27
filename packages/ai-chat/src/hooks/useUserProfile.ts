import type { UserProfile } from '@nomi-ai/types';
import { useEffect, useState } from 'react';

import { onboardingClient } from '../components/Onboarding/client';

/**
 * 新手引导里选的职业与兴趣（主进程 onboarding.json），引导里改了会即时推送。
 * 还没取到时为 null；没有桌面桥时是空的 profile。
 */
export function useUserProfile(): UserProfile | null {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    let alive = true;
    // 推送比首次读取先到时，以推送为准
    let pushed = false;
    void onboardingClient.profile().then((p) => {
      if (alive && !pushed) setProfile(p);
    });
    const off = onboardingClient.onProfile((p) => {
      pushed = true;
      if (alive) setProfile(p);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return profile;
}
