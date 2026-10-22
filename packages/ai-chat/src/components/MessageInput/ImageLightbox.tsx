/**
 * 附件图片放大查看：挂到 body 上的全屏遮罩，显示原图；点遮罩、关闭按钮或按 Esc 关闭，关闭后焦点回到缩略图。
 */
import { Icon, t } from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ImageAttachment } from '../../services/screenClient';

import styles from './ImageLightbox.module.css';

export const ImageLightbox: React.FC<{ image: ImageAttachment; onClose: () => void }> = ({
  image,
  onClose,
}) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      back?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('查看图片')}
      data-testid="attach-lightbox"
      onClick={onClose}
    >
      <img
        src={`data:${image.mime};base64,${image.data}`}
        alt={t('附件图片')}
        className={styles.image}
        onClick={(e) => e.stopPropagation()}
      />
      <button
        ref={closeRef}
        type="button"
        className={styles.close}
        aria-label={t('关闭')}
        onClick={onClose}
      >
        <Icon icon={X} size={16} />
      </button>
    </div>,
    document.body,
  );
};
