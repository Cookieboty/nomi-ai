/** CLI 会话气泡插槽：用户附图缩略图网格 + lightbox（缩放 / 左右切图 / Esc） */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { HarnessTabMessage } from '../../services/harnessClient';
import { aggregateTurnChanges } from '../../utils/sessionChanges';
import {
  hasRunning,
  reduceTrace,
  entriesFromLegacyTools,
  buildTimeline,
} from '../../utils/toolTrace';
import { TurnEditSummaryCard } from '../SessionWorkspace/TurnEditSummaryCard';

import styles from './index.module.css';
import type { ConvSlots } from './Messages';

function rawOf(m: { raw?: unknown }): HarnessTabMessage | null {
  const r = m.raw;
  if (!r || typeof r !== 'object') return null;
  return r as HarnessTabMessage;
}

const UrlLightbox: React.FC<{
  images: NonNullable<HarnessTabMessage['images']>;
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}> = ({ images, index, onClose, onIndex }) => {
  const [zoom, setZoom] = useState(1);
  const src = images[index]?.thumb ?? '';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
      else if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(4, z + 0.25));
      else if (e.key === '-') setZoom((z) => Math.max(0.5, z - 0.25));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, index, onClose, onIndex]);

  return createPortal(
    <div
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={t('ui.knowledge-local.view-image')}
      data-testid="cli-image-lightbox"
      onClick={onClose}
    >
      <img
        src={src}
        alt={t('ui.providers-schedule.image')}
        className={styles.lightboxImg}
        style={{ transform: `scale(${zoom})`, transition: 'transform 0.15s ease' }}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => {
          e.stopPropagation();
          setZoom((z) => Math.min(4, Math.max(0.5, z + (e.deltaY < 0 ? 0.1 : -0.1))));
        }}
      />
      <div className={styles.lightboxToolbar} onClick={(e) => e.stopPropagation()}>
        {images.length > 1 ? (
          <>
            <button
              type="button"
              className={styles.lightboxBtn}
              aria-label={t('ui.session-workspace.previous')}
              data-testid="lightbox-prev"
              onClick={() => onIndex((index - 1 + images.length) % images.length)}
            >
              ‹
            </button>
            <span style={{ color: '#fff', alignSelf: 'center', fontSize: 12 }}>
              {index + 1}/{images.length}
            </span>
            <button
              type="button"
              className={styles.lightboxBtn}
              aria-label={t('ui.session-workspace.next')}
              data-testid="lightbox-next"
              onClick={() => onIndex((index + 1) % images.length)}
            >
              ›
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={styles.lightboxBtn}
          aria-label={t('ui.usage-tools.zoom-out')}
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
        >
          −
        </button>
        <button
          type="button"
          className={styles.lightboxBtn}
          aria-label={t('ui.usage-tools.zoom-in')}
          onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
        >
          +
        </button>
      </div>
    </div>,
    document.body,
  );
};

const ImageRow: React.FC<{ images: NonNullable<HarnessTabMessage['images']> }> = ({ images }) => {
  const [pick, setPick] = useState<number | null>(null);
  return (
    <>
      <div className={styles.imageRow} data-testid="message-images" data-count={images.length}>
        {images.map((im, i) => (
          <button
            key={i}
            type="button"
            className={styles.imageThumbBtn}
            onClick={() => setPick(i)}
            title={`${im.width}×${im.height}`}
            aria-label={t('ui.knowledge-local.view-image')}
          >
            <img
              src={im.thumb}
              alt={t('ui.providers-schedule.image')}
              className={styles.imageThumb}
            />
          </button>
        ))}
      </div>
      {pick != null && (
        <UrlLightbox images={images} index={pick} onClose={() => setPick(null)} onIndex={setPick} />
      )}
    </>
  );
};

export function buildCliSlots(opts?: ConvSlots & { cwd?: string | null }): ConvSlots {
  const { cwd, ...base } = opts ?? {};
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
    after: (m) => {
      const prev = base?.after?.(m) ?? null;
      if (m.role !== 'assistant') return prev;
      const entries = aggregateTurnChanges(m);
      if (!entries.length) return prev;
      const timeline = buildTimeline(
        m.trace?.length ? reduceTrace(m.trace) : entriesFromLegacyTools(m.legacyTools ?? []),
      );
      if (hasRunning(timeline)) return prev;
      return (
        <>
          {prev}
          <TurnEditSummaryCard
            messageId={m.id}
            entries={entries}
            cwd={cwd}
            sourceLabel={m.id.slice(0, 16)}
          />
        </>
      );
    },
  };
}
