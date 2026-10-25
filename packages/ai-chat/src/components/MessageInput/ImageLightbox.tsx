/**
 * 附件图片放大查看：缩放 / Esc 关闭；挂到 body。
 */
import { Icon, t, useFocusTrap } from '@nomi-ai/ui';
import { Minus, Plus, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ImageAttachment } from '../../services/screenClient';

import styles from './ImageLightbox.module.css';

export const ImageLightbox: React.FC<{ image: ImageAttachment; onClose: () => void }> = ({
  image,
  onClose,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  useFocusTrap(rootRef, true, onClose);

  return createPortal(
    <div
      ref={rootRef}
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t('ui.knowledge-local.view-image')}
      data-testid="attach-lightbox"
      onClick={onClose}
    >
      <img
        src={`data:${image.mime};base64,${image.data}`}
        alt={t('ui.knowledge-local.attached-image')}
        className={styles.image}
        style={{ transform: `scale(${zoom})`, transition: 'transform 0.15s ease' }}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.stopPropagation();
          setZoom((z) => Math.min(4, Math.max(0.5, z + (e.deltaY < 0 ? 0.1 : -0.1))));
        }}
      />
      <div className={styles.toolbar} onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={styles.toolBtn}
          aria-label={t('ui.usage-tools.zoom-out')}
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
        >
          <Icon icon={Minus} size={14} />
        </button>
        <button
          type="button"
          className={styles.toolBtn}
          aria-label={t('ui.usage-tools.zoom-in')}
          onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
        >
          <Icon icon={Plus} size={14} />
        </button>
      </div>
      <button
        type="button"
        data-autofocus
        className={styles.close}
        aria-label={t('ui.providers-schedule.close')}
        onClick={onClose}
      >
        <Icon icon={X} size={16} />
      </button>
    </div>,
    document.body,
  );
};
