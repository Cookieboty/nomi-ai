import { t } from '@nomi-ai/ui';
import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './ContextMenu.module.css';

import { scalePercent, scaleStore, useMascotScale } from '@/mascot/scaleStore';

const MENU_W = 168;

/**
 * 看板娘右键菜单：放大 / 缩小 / 重置大小（Ctrl/⌘+滚轮与设置页滑块是另外两个入口）。
 * 只在角色画布上右键时出现（工具栏按钮有自己的右键行为）；带 data-mascot-ui，
 * 点击穿透命中测试（elementFromPoint / Linux setShape）会把菜单算上。
 */
export const MascotContextMenu: React.FC = () => {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const s = useMascotScale();
  const close = useCallback(() => setPos(null), []);

  useEffect(() => {
    if (!window.electronAPI?.mascotWindow?.scaleGet) return undefined;
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || !el.closest('#mascot-canvas') || el.closest('[data-mascot-ui]')) return;
      e.preventDefault();
      setPos({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
  }, []);

  useEffect(() => {
    if (!pos) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    // 点放大 / 缩小后窗口随之改变大小：菜单留在原处（必要时重新夹进窗口），可以连续点
    const onResize = () => setPos((p) => (p ? { ...p } : p));
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', onResize);
    };
  }, [pos, close]);

  // 贴边时翻到光标另一侧，保证整个菜单都在窗口内
  useLayoutEffect(() => {
    const el = ref.current;
    if (!pos || !el) return;
    const w = Math.max(el.offsetWidth, MENU_W);
    const h = el.offsetHeight;
    const x = Math.max(4, Math.min(window.innerWidth - w - 4, pos.x));
    const y = Math.max(4, Math.min(window.innerHeight - h - 4, pos.y));
    if (x !== pos.x || y !== pos.y) setPos({ x, y });
  }, [pos]);

  if (!pos || !s) return null;
  const atMin = s.scale <= s.min + 1e-6;
  const atMax = s.scale >= s.max - 1e-6;
  const atDefault = Math.abs(s.scale - s.default) < 1e-6;
  return (
    <div
      ref={ref}
      className={styles.menu}
      role="menu"
      aria-label={t('看板娘大小')}
      data-mascot-ui=""
      data-testid="mascot-context-menu"
      style={{ left: pos.x, top: pos.y, width: MENU_W }}
    >
      <div className={styles.title} data-testid="ctx-scale-value">
        {t('大小')} {scalePercent(s.scale)}%
      </div>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        data-testid="ctx-zoom-in"
        disabled={atMax}
        onClick={() => scaleStore.step(1)}
      >
        <ZoomIn size={16} strokeWidth={1.75} aria-hidden />
        <span>{t('放大')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        data-testid="ctx-zoom-out"
        disabled={atMin}
        onClick={() => scaleStore.step(-1)}
      >
        <ZoomOut size={16} strokeWidth={1.75} aria-hidden />
        <span>{t('缩小')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        data-testid="ctx-zoom-reset"
        disabled={atDefault}
        onClick={() => {
          scaleStore.reset();
          close();
        }}
      >
        <RotateCcw size={16} strokeWidth={1.75} aria-hidden />
        <span>{t('重置大小')}</span>
      </button>
    </div>
  );
};

export default MascotContextMenu;
