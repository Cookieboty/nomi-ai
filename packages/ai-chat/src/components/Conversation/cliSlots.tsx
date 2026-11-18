/** CLI 会话气泡插槽：用户附图缩略图网格 + lightbox（缩放 / 左右切图 / Esc） */
import { t } from '@nomi-ai/ui';
import React, { useState } from 'react';

import { hostAssetUrl } from '../../services/api';
import {
  codingModelChoices,
  refSlashLabel,
  switchTabSource,
  tabSourceOf,
} from '../../services/cliSource';
import { presetDisplayLabel, useDelegatePresets } from '../../services/delegateClient';
import {
  harnessClient,
  type HarnessTabMessage,
  type HarnessTabMeta,
} from '../../services/harnessClient';
import { useGatewayState } from '../../services/nomiModel';
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

const QUOTA_ERROR_RE =
  /\b429\b|rate[-_\s]?limit|quota\s+exceeded|insufficient_quota|usage\s+limit|credit\s+balance|hit\s+your\s+limit|limit\s+reached|too\s+many\s+requests|额度|限流|用量已达上限|次数已用完/i;

export function isQuotaExhaustedError(text: string | undefined | null): boolean {
  return !!text && QUOTA_ERROR_RE.test(text);
}

const CliQuotaFallbackAction: React.FC<{
  tab: HarnessTabMeta;
  retry?: () => void;
}> = ({ tab, retry }) => {
  const gateway = useGatewayState();
  const presets = useDelegatePresets(true);
  const choices = codingModelChoices(gateway);
  const cliTpPresets = presets.filter(
    (p) =>
      p.cli === tab.backend &&
      p.source === 'thirdParty' &&
      !!p.model &&
      choices.some((c) => c.ref === p.model),
  );
  const matchedPreset =
    cliTpPresets.find((p) => p.id === 'low' || p.costTier === 'low') ?? cliTpPresets[0];
  const clientMain =
    tab.backend !== 'nomi' ? gateway?.clients[tab.backend]?.models.main : undefined;
  const validMain = clientMain && choices.some((c) => c.ref === clientMain) ? clientMain : null;
  const targetRef = matchedPreset?.model ?? validMain ?? choices[0]?.ref ?? null;
  if (!targetRef) return null;
  const displayRef = refSlashLabel(gateway, targetRef);
  const targetLabel = matchedPreset
    ? `${presetDisplayLabel(matchedPreset)} (${displayRef})`
    : displayRef !== targetRef
      ? displayRef
      : t('ui.models.quota-fallback-low-label');

  return (
    <button
      type="button"
      className={styles.errorBtn}
      data-testid="cli-quota-fallback"
      onClick={() => {
        void (async () => {
          const switched = await switchTabSource(tab, 'thirdParty', {
            model: targetRef,
            hasMessages: true,
          });
          if (!switched) return;
          if (matchedPreset?.reasoningEffort) {
            await harnessClient
              .setTabEffort(tab.id, matchedPreset.reasoningEffort)
              .catch(() => undefined);
          }
          retry?.();
        })();
      }}
    >
      {t('ui.models.quota-fallback-continue', targetLabel)}
    </button>
  );
};

export function buildCliSlots(
  opts?: ConvSlots & { cwd?: string | null; tab?: HarnessTabMeta | null },
): ConvSlots {
  const { cwd, tab, ...base } = opts ?? {};
  return {
    ...base,
    errorActions: (m, ctx) => {
      const baseActions = base?.errorActions?.(m, ctx) ?? null;
      const fallback =
        tab && tabSourceOf(tab) !== 'thirdParty' && isQuotaExhaustedError(m.error) ? (
          <CliQuotaFallbackAction key={`quota-${m.id}`} tab={tab} retry={ctx.retry} />
        ) : null;
      if (!baseActions && !fallback) return null;
      return (
        <>
          {baseActions}
          {fallback}
        </>
      );
    },
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
