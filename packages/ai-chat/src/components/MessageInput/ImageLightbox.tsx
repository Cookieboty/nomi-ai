/**
 * 附件图片放大查看：挂到 body 上的全屏遮罩，显示原图；点遮罩、关闭按钮或按 Esc 关闭，关闭后焦点回到缩略图。
 */
import { Icon, t, useFocusTrap } from '@nomi-ai/ui';
import { X } from 'lucide-react';
import React, { useRef } from 'react';
import { createPortal } from 'react-dom';

import type { ImageAttachment } from '../../services/screenClient';

import styles from './ImageLightbox.module.css';

export const ImageLightbox: React.FC<{ image: ImageAttachment; onClose: () => void }> = ({
  image,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  // 焦点留在遮罩里（Tab 不会跑到背后的输入框），Esc 关闭，关闭后焦点回到缩略图
  useFocusTrap(rootRef, true, onClose);

  return createPortal(
    <div
      ref={rootRef}
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
        type="button"
        data-autofocus
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
