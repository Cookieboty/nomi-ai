import { brand } from '@nomi-ai/types';
import { Button, t } from '@nomi-ai/ui';
import React, { useEffect, useLayoutEffect, useRef } from 'react';

import { isImeComposing } from '../../utils/keyboard';
import type { BootScreenState } from '../BootScreen';

import { BrandLockup } from './BrandLockup';
import styles from './index.module.css';
import { introActive, startupBrandIntro, useBrandIntro } from './state';

const WRITE_MS = 1400;
const HOLD_MS = 450;
const DOCK_MS = 650;
const REVEAL_AT = DOCK_MS - 150;

/** 挂在启动页与 App 的共同父节点，切换加载页面时保持同一个品牌元素。 */
export const StartupBrandIntro: React.FC<{ bootState?: BootScreenState }> = ({ bootState }) => {
  const { phase, target, skipped, mode } = useBrandIntro();
  const active = introActive(phase);
  const docking = mode === 'onboarding' && (phase === 'docking' || phase === 'revealing');
  const floating = useRef<HTMLDivElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode !== 'app' || phase !== 'revealing') return;
    const id = window.setTimeout(startupBrandIntro.complete, 180);
    return () => window.clearTimeout(id);
  }, [mode, phase]);

  useLayoutEffect(() => {
    const el = floating.current;
    if (!active || docking || !el) return;
    const center = () => {
      const scale = Math.min(1, (window.innerWidth - 48) / el.offsetWidth);
      const snap = (value: number) =>
        Math.round(value * window.devicePixelRatio) / window.devicePixelRatio;
      const x = snap((window.innerWidth - el.offsetWidth * scale) / 2);
      const y = snap((window.innerHeight - el.offsetHeight * scale) / 2 - 12);
      el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    };
    center();
    window.addEventListener('resize', center);
    return () => window.removeEventListener('resize', center);
  }, [active, docking]);

  useEffect(() => {
    if (phase !== 'drawing') return;
    // 绘制完成后保留完整品牌片刻，再开始归位。
    const id = window.setTimeout(startupBrandIntro.drawn, WRITE_MS + HOLD_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  useLayoutEffect(() => {
    const el = floating.current;
    if (!docking || !target || !el) return;
    if (typeof el.animate !== 'function' || !target.getBoundingClientRect().width) {
      startupBrandIntro.complete();
      return;
    }
    let alive = true;
    let flight: Animation | undefined;
    const end = performance.now() + DOCK_MS;
    const dock = () => {
      const rect = target.getBoundingClientRect();
      const from = getComputedStyle(el).transform;
      // 窗口尺寸改变时从当前视觉位置继续，不跳回中央。
      el.style.transform = from;
      flight?.cancel();
      flight = el.animate(
        [
          { transform: from },
          {
            transform: `translate(${rect.left}px, ${rect.top}px) scale(${rect.width / el.offsetWidth})`,
          },
        ],
        {
          duration: Math.max(0, end - performance.now()),
          easing: 'cubic-bezier(0.65, 0, 0.2, 1)',
          fill: 'forwards',
        },
      );
      void flight.finished
        .then(() => {
          if (alive) startupBrandIntro.complete();
        })
        .catch(() => undefined);
    };
    dock();
    const revealTimer = window.setTimeout(startupBrandIntro.reveal, REVEAL_AT);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(dock);
    observer?.observe(target);
    window.addEventListener('resize', dock);
    return () => {
      alive = false;
      window.clearTimeout(revealTimer);
      observer?.disconnect();
      window.removeEventListener('resize', dock);
      flight?.cancel();
    };
  }, [docking, target]);

  useEffect(() => {
    if (!active) return;
    skipButton.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (
        isImeComposing(e) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)
      )
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      startupBrandIntro.skip();
    };
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = () => {
      if (media?.matches) startupBrandIntro.skip();
    };
    media?.addEventListener('change', onMotion);
    window.addEventListener('keydown', onKey, true);
    return () => {
      media?.removeEventListener('change', onMotion);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [active]);

  useEffect(() => {
    if (phase !== 'done' || !target) return;
    const heading = target.closest('[role="dialog"]')?.querySelector<HTMLElement>('#onb-title');
    heading?.focus({ preventScroll: true });
  }, [phase, target]);

  if (!active) return null;
  return (
    <div
      className={styles.root}
      data-phase={phase}
      data-mode={mode}
      data-testid="startup-brand-intro"
      // 揭开淡出时页面已经可用（before 阶段不会淡出）：不能再当模态，读屏要回到下面的对话页面
      role="dialog"
      aria-modal={phase === 'revealing' ? undefined : true}
      aria-hidden={phase === 'revealing' ? true : undefined}
      aria-label={t('ui.mascot-theme.startup-animation-label', brand.appName)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startupBrandIntro.skip();
      }}
    >
      <div className={styles.backdrop} />
      <div className={styles.drag} aria-hidden />
      <div ref={floating} className={styles.floating} aria-hidden>
        <BrandLockup animated skipped={skipped} />
      </div>
      {phase === 'waiting' && (
        <p className={styles.status} role="status" aria-live="polite">
          {bootState?.kind === 'migrating'
            ? t('ui.chat-settings.boot-importing-history', bootState.done, bootState.total)
            : t('ui.chat-settings.boot-loading-history')}
        </p>
      )}
      <Button
        ref={skipButton}
        variant="ghost"
        size="sm"
        className={styles.skip}
        onClick={startupBrandIntro.skip}
      >
        {t('ui.mascot-theme.startup-animation-skip')}
      </Button>
    </div>
  );
};
