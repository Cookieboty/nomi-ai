import { useEffect, useRef } from 'react';

import { useWaifuMessage } from './useWaifuMessage';

import { IDLE_TIPS, MESSAGES, MOUSEOVER_TIPS, greetingFor } from '@/mascot/tips';

const IDLE_AFTER_MS = 45_000;
/**
 * The startup greeting is a filler line: it sits below AI replies / reminders (priority 9), so a
 * reply that lands before the 1.2 s greeting delay is not replaced by it (E12).
 */
export const GREETING_PRIORITY = 8;
export const GREETING_DELAY_MS = 1200;

/** 注册看板娘的提示文案：问候、悬停提示、空闲提醒、复制/回到前台。 */
export function useMascotTips(): void {
  const { showMessage } = useWaifuMessage();
  const showRef = useRef(showMessage);
  // 渲染期不写 ref：通过 effect 同步最新 showMessage，供 window 事件回调读取
  useEffect(() => {
    showRef.current = showMessage;
  }, [showMessage]);

  useEffect(() => {
    const say = (t: string | string[], timeout = 4000, priority = 8, clip?: string | null) =>
      showRef.current(t, timeout, priority, false, clip === undefined ? {} : { clip });

    const greet = setTimeout(
      () => say(greetingFor(new Date().getHours()), 6000, GREETING_PRIORITY),
      GREETING_DELAY_MS,
    );

    let lastSelector: string | null = null;
    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return;
      const rule = MOUSEOVER_TIPS.find((r) => target.closest(r.selector));
      if (!rule) {
        lastSelector = null;
        return;
      }
      if (rule.selector === lastSelector) return;
      lastSelector = rule.selector;
      say(rule.text);
    };

    let lastActive = Date.now();
    const onActive = () => {
      lastActive = Date.now();
    };
    const idle = setInterval(() => {
      if (Date.now() - lastActive > IDLE_AFTER_MS) {
        say(IDLE_TIPS, 6000, 5);
        lastActive = Date.now();
      }
    }, 5000);

    const onSay = (e: Event) => {
      const d = (
        e as CustomEvent<{ text?: string; ms?: number; priority?: number; clip?: string | null }>
      ).detail;
      if (d?.text) say(d.text, d.ms ?? 4000, d.priority ?? 9, d.clip);
    };
    const onVisible = () => {
      if (!document.hidden) say(MESSAGES.visibility, 4000, 9);
    };

    window.addEventListener('mouseover', onOver);
    window.addEventListener('mousemove', onActive);
    window.addEventListener('keydown', onActive);
    window.addEventListener('mascot:say', onSay);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(greet);
      clearInterval(idle);
      window.removeEventListener('mouseover', onOver);
      window.removeEventListener('mousemove', onActive);
      window.removeEventListener('keydown', onActive);
      window.removeEventListener('mascot:say', onSay);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
