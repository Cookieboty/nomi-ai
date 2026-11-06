/**
 * 侧栏收起时：鼠标移到导航栏的「对话」或端点上，会话面板以浮层弹出，可以直接选；
 * 移出侧栏（导航栏 + 浮层）稍等一下再收起，免得斜着划过去时闪掉。Esc 收起，选了会话也收起。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const HIDE_DELAY = 250;

export function useFloatingPanel(collapsed: boolean) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const cancelHide = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);
  const show = useCallback(() => {
    cancelHide();
    setOpen(true);
  }, [cancelHide]);
  const hide = useCallback(() => {
    cancelHide();
    setOpen(false);
  }, [cancelHide]);
  const scheduleHide = useCallback(() => {
    cancelHide();
    timer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY);
  }, [cancelHide]);

  const floating = collapsed && open;
  useEffect(() => {
    if (!floating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floating, hide]);
  useEffect(() => cancelHide, [cancelHide]);

  return { floating, show, hide, scheduleHide, cancelHide };
}
