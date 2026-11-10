/**
 * 引导的宿主：没走完引导（或别处要求再打开）时才显示。引导本体只有首次启动用得上，按需加载，不进对话窗首屏 chunk。
 */
import React, { useEffect, useState } from 'react';

import { lazyComponent } from '../lazyPanels';

import { onboardingClient } from './client';

const Onboarding = lazyComponent(() => import('./index').then((m) => m.Onboarding));

/** 挂在对话窗口根部：未完成引导时显示；设置里「重新打开」也走这里 */
export const OnboardingHost: React.FC = () => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    void onboardingClient.get().then((s) => alive && setOpen(!s.done));
    const off = onboardingClient.onShow(() => setOpen(true));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!open) return null;
  return <Onboarding onDone={() => setOpen(false)} />;
};
