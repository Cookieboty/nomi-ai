import { t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import type { ResourceEntry } from '../../contexts/ResourceContext';
import { hostAssetUrl } from '../../services/api';
import { resourcePreviewClient, type PreviewResult } from '../../services/resourcePreviewClient';
import { resourceTarget, workspaceFileHref } from '../../utils/resourceLinks';
import { GeneratedImageModal } from '../AssetLibrary/GeneratedImageModal';
import { confirmDialog } from '../ConfirmDialog';

import { ImageLightbox } from './ImageLightbox';

/** This viewer owns its URL whitelist independently of Markdown renderers. */
const sanitizeImgSrc = (url: string) =>
  /^(https:\/\/|data:image\/|blob:|chat-asset:\/\/)/i.test(url.trim()) ? url.trim() : '';

export function ResourceImageModal({
  entry,
  mismatch,
  onClose,
}: {
  entry: ResourceEntry;
  mismatch: boolean;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<PreviewResult | null>(null);
  useEffect(() => {
    let stale = false;
    let capability: string | undefined;
    const read = async () => {
      const target = resourceTarget(entry.href);
      let result: PreviewResult;
      if (!target) result = { ok: false, code: 'invalid' };
      else if (!target.path && !target.web) {
        const src = sanitizeImgSrc(entry.href);
        result = src
          ? { ok: true, kind: 'image', url: hostAssetUrl(src) }
          : { ok: false, code: 'invalid' };
      } else if (target.web) result = await resourcePreviewClient.web(entry.href);
      else {
        let cwd = entry.scope.cwd ?? '';
        let path = target.path!;
        result = await resourcePreviewClient.open(cwd, path);
        const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
        const original = path.replace(/\\/g, '/');
        if (base && original.startsWith(`${base}/`)) {
          const relative = original.slice(base.length + 1);
          for (const fallback of entry.scope.fallbackCwds ?? []) {
            if (stale || result.code !== 'missing') break;
            cwd = fallback;
            path = resourceTarget(workspaceFileHref(cwd, relative))!.path!;
            result = await resourcePreviewClient.open(cwd, path);
          }
        }
        if (!stale && result.code === 'authorization') {
          const approved = await confirmDialog({
            title: t('ui.session-workspace.preview-authorize-title'),
            message: t('ui.session-workspace.preview-authorize-message', result.path ?? path),
            confirmLabel: t('ui.session-workspace.preview-authorize-file'),
          });
          if (approved && !stale) result = await resourcePreviewClient.open(cwd, path, true);
        }
      }
      if (result.url?.startsWith('/__nomi/preview/')) capability = result.url;
      if (stale) {
        if (capability) void resourcePreviewClient.close(capability).catch(() => undefined);
      } else setLoaded(result);
    };
    void read().catch(() => {
      if (!stale) setLoaded({ ok: false, code: 'read' });
    });
    return () => {
      stale = true;
      if (capability) void resourcePreviewClient.close(capability).catch(() => undefined);
    };
  }, [entry]);
  const src = loaded?.url ? hostAssetUrl(loaded.url) : '';
  if (loaded?.ok && loaded.kind === 'image' && src && entry.image?.origin === 'assistant')
    return (
      <GeneratedImageModal
        entry={entry}
        src={src}
        originMismatch={mismatch}
        onCloseEntry={onClose}
      />
    );
  return (
    <ImageLightbox
      src={src}
      alt={loaded?.path ?? ''}
      onClose={onClose}
      pending={!loaded}
      error={
        loaded && (!loaded.ok || loaded.kind !== 'image' || !src)
          ? t('ui.usage-tools.image-failed-to-load')
          : undefined
      }
    />
  );
}
