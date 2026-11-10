/** CLI 会话气泡插槽：用户附图缩略图网格 + lightbox（缩放 / 左右切图 / Esc） */
import { t } from '@nomi-ai/ui';
import React, { useState } from 'react';

import { hostAssetUrl } from '../../services/api';
import type { HarnessTabMessage } from '../../services/harnessClient';
import { aggregateTurnChanges } from '../../utils/sessionChanges';
import {
  hasRunning,
  reduceTrace,
  entriesFromLegacyTools,
  buildTimeline,
} from '../../utils/toolTrace';
import { ImageLightbox } from '../ImageLightbox/ImageLightbox';
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
  const im = images[index];
  const src = im?.url
    ? hostAssetUrl(im.url)
    : im?.thumb?.startsWith('chat-asset://')
      ? hostAssetUrl(im.thumb)
      : (im?.thumb ?? '');
  return (
    <ImageLightbox
      src={src}
      alt={t('ui.providers-schedule.image')}
      index={index}
      count={images.length}
      onIndex={onIndex}
      onClose={onClose}
      data-testid="cli-image-lightbox"
    />
  );
};

type CliImage = NonNullable<HarnessTabMessage['images']>[number];

const ImageThumbnail: React.FC<{ image: CliImage; onOpen: () => void }> = ({
  image: im,
  onOpen,
}) => {
  const [failed, setFailed] = useState(false);
  const unavailable = im.unavailable || failed;
  return (
    <button
      type="button"
      className={styles.imageThumbBtn}
      onClick={onOpen}
      disabled={unavailable}
      title={unavailable ? (im.path ?? im.name) : `${im.width}×${im.height}`}
      aria-label={
        unavailable
          ? t('ui.session-workspace.image-attachment-unavailable')
          : t('ui.knowledge-local.view-image')
      }
    >
      {unavailable ? (
        <span className={styles.imageUnavailable} role="status">
          {im.name || t('ui.providers-schedule.image')}
          <span>{t('ui.session-workspace.image-attachment-unavailable')}</span>
        </span>
      ) : (
        <img
          src={im.thumb.startsWith('chat-asset://') ? hostAssetUrl(im.thumb) : im.thumb}
          alt={im.name || t('ui.providers-schedule.image')}
          className={styles.imageThumb}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </button>
  );
};

const ImageRow: React.FC<{ images: NonNullable<HarnessTabMessage['images']> }> = ({ images }) => {
  const [pick, setPick] = useState<number | null>(null);
  const available = images.filter((image) => !image.unavailable && (image.url || image.thumb));
  return (
    <>
      <div className={styles.imageRow} data-testid="message-images" data-count={images.length}>
        {images.map((im, i) => (
          <ImageThumbnail
            key={`${i}:${im.url ?? im.thumb}`}
            image={im}
            onOpen={() => setPick(available.indexOf(im))}
          />
        ))}
      </div>
      {pick != null && available[pick] && (
        <UrlLightbox
          key={pick}
          images={available}
          index={pick}
          onClose={() => setPick(null)}
          onIndex={setPick}
        />
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
