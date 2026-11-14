/**
 * 引导的宿主：没走完引导（或别处要求再打开）时才显示。引导本体只有首次启动用得上，按需加载，不进对话窗首屏 chunk。
 */
import React, { useEffect, useState } from 'react';

import { lazyComponent } from '../lazyPanels';

import { onboardingClient } from './client';
import styles from './host.module.css';

const Onboarding = lazyComponent(
  () => import('./index').then((m) => m.Onboarding),
  <div className={styles.gate} data-testid="onboarding-gate" aria-hidden />,
);

/** 启动预热：仅在需要显示引导时由 main.tsx 调用，保证切换出 BootScreen 的第一帧即完整就绪 */
export const preloadOnboarding = (): Promise<unknown> => Onboarding.preload();

/** 挂在对话窗口根部：未完成引导时显示（状态待定期间用纯色幕布遮挡，避免闪现首页） */
export const OnboardingHost: React.FC = () => {
  const [initial] = useState(() => onboardingClient.peekInitial());
  const [state, setState] = useState<'pending' | 'open' | 'closed'>(() => {
    if (initial) return initial.done ? 'closed' : 'open';
    return onboardingClient.available() ? 'pending' : 'closed';
  });
  useEffect(() => {
    let alive = true;
    if (!initial) {
      void onboardingClient.get().then((s) => {
        if (alive) setState(s.done ? 'closed' : 'open');
      });
    }
    const off = onboardingClient.onShow(() => {
      onboardingClient.setPreparedDone(false);
      setState('open');
    });
    return () => {
      alive = false;
      off();
    };
  }, [initial]);
  if (state === 'closed') return null;
  if (state === 'pending')
    return <div className={styles.gate} data-testid="onboarding-gate" aria-hidden />;
  return (
    <Onboarding
      onDone={() => {
        onboardingClient.setPreparedDone(true);
        setState('closed');
      }}
    />
  );
};
