/**
 * 对话里的图片：右键「加入素材库 / 复制 / 另存为」；已在库时显示角标，菜单变为「从素材库移除」。
 * 非桌面环境（无 aiIPC）时原样渲染子元素。
 */
import type { AssetSource } from '@nomi-ai/gateway/media';
import { Icon, t } from '@nomi-ai/ui';
import { BookmarkCheck } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import {
  invalidateLookup,
  mediaClient,
  mediaToast,
  useAssetInLibrary,
} from '../../services/mediaClient';

import styles from './Media.module.css';

export interface MediaImageMenuProps {
  src: string;
  source: AssetSource;
  /**
   * 入库 / 复制 / 另存用的原图。不传 = 就用 src；传 null = 原图已不可用（只有缩略图），禁用「加入素材库」。
   */
  original?: string | null;
  conversationId?: string;
  /** 另存为默认文件名 */
  fileName?: string;
  children: React.ReactNode;
}

export const MediaImageMenu: React.FC<MediaImageMenuProps> = ({
  src,
  source,
  original,
  conversationId,
  fileName,
  children,
}) => {
  const enabled = mediaClient.available() && !!src;
  const full = original === undefined ? src : original;
  const inLib = useAssetInLibrary(enabled && full ? full : undefined);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      setMenu(null);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    window.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!enabled) return <>{children}</>;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMenu(null);
    try {
      await fn();
      invalidateLookup();
      if (ok) mediaToast(ok);
    } catch (e) {
      mediaToast((e as Error).message || t('ui.media.action-failed'));
    }
  };

  return (
    <span
      className={styles.imgWrap}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      data-in-library={inLib ? 'true' : undefined}
    >
      {children}
      {inLib && (
        <span
          className={styles.badge}
          title={t('ui.media.in-library')}
          aria-label={t('ui.media.in-library')}
          data-testid="asset-badge"
        >
          <Icon icon={BookmarkCheck} size={12} />
        </span>
      )}
      {menu && (
        <div
          ref={ref}
          role="menu"
          className={styles.menu}
          style={{ left: menu.x, top: menu.y }}
          data-testid="image-context-menu"
        >
          {inLib ? (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() =>
                void run(
                  () => mediaClient.setInLibrary(inLib.id, false),
                  t('ui.media.removed-from-library'),
                )
              }
            >
              {t('ui.media.remove-from-library')}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              disabled={!full}
              title={full ? undefined : t('ui.media.original-unavailable')}
              data-testid="menu-add-to-library"
              onClick={() =>
                void run(
                  () => mediaClient.addAsset(full ?? src, source, conversationId),
                  t('ui.media.added-to-library'),
                )
              }
            >
              {t('ui.media.add-to-library')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => void run(() => mediaClient.copyImage(full ?? src), t('ui.media.copied'))}
          >
            {t('ui.knowledge-local.copy')}
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => void run(() => mediaClient.saveImage(full ?? src, fileName))}
          >
            {t('ui.media.save-as')}
          </button>
        </div>
      )}
    </span>
  );
};
