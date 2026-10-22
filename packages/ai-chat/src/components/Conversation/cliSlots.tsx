/** CLI 会话气泡插槽：用户附图缩略图 + 点击放大 */
import { t } from '@nomi-ai/ui';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import type { HarnessTabMessage } from '../../services/harnessClient';

import styles from './index.module.css';
import type { ConvSlots } from './Messages';

function rawOf(m: { raw?: unknown }): HarnessTabMessage | null {
  const r = m.raw;
  if (!r || typeof r !== 'object') return null;
  return r as HarnessTabMessage;
}

const UrlLightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) =>
  createPortal(
    <div
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={t('查看图片')}
      data-testid="cli-image-lightbox"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      tabIndex={-1}
    >
      <img
        src={src}
        alt={t('图片')}
        className={styles.lightboxImg}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );

const ImageRow: React.FC<{ images: NonNullable<HarnessTabMessage['images']> }> = ({ images }) => {
  const [pick, setPick] = useState<string | null>(null);
  return (
    <>
      <div className={styles.imageRow} data-testid="message-images">
        {images.map((im, i) => (
          <button
            key={i}
            type="button"
            className={styles.imageThumbBtn}
            onClick={() => setPick(im.thumb)}
            title={`${im.width}×${im.height}`}
            aria-label={t('查看图片')}
          >
            <img src={im.thumb} alt={t('图片')} className={styles.imageThumb} />
          </button>
        ))}
      </div>
      {pick && <UrlLightbox src={pick} onClose={() => setPick(null)} />}
    </>
  );
};

export function buildCliSlots(base?: ConvSlots): ConvSlots {
  return {
    ...base,
    before: (m) => {
      const raw = rawOf(m);
      const imgs = raw?.images;
      const prev = base?.before?.(m) ?? null;
      if (!imgs?.length) return prev;
      return (
        <>
          <ImageRow images={imgs} />
          {prev}
        </>
      );
    },
  };
}
