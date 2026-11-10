import React, { useState } from 'react';

import type { ResourceEntry } from '../../contexts/ResourceContext';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';

import { assetFileOf, ImageViewer, useAssetItem, type AssetItem } from './ImageViewer';

/** Assistant provenance controls presentation; asset lookup only supplements actual recorded metadata. */
export function GeneratedImageModal({
  entry,
  src,
  originMismatch,
  onCloseEntry,
}: {
  entry: ResourceEntry;
  src: string;
  originMismatch: boolean;
  onCloseEntry: () => void;
}) {
  const loaded = useAssetItem(entry.href, true);
  const [shown, setShown] = useState<AssetItem | null>(null);
  const { fillComposer } = useChangesUi();
  const metadata = entry.image;
  const recorded = shown ?? loaded;
  const fallback: AssetItem = {
    file: assetFileOf(entry.href) ?? '',
    url: entry.href,
    source: metadata?.source ?? entry.scope.source ?? 'assistant',
    createdAt: metadata?.createdAt ?? 0,
    bytes: 0,
    prompt: metadata?.prompt,
    model: metadata?.model,
    aspect: metadata?.aspect,
    editedFrom: metadata?.editedFrom,
    references: metadata?.references,
  };
  const item: AssetItem = recorded
    ? {
        ...fallback,
        ...recorded,
        prompt: recorded.prompt ?? metadata?.prompt,
        model: recorded.model ?? metadata?.model,
        aspect: recorded.aspect ?? metadata?.aspect,
        createdAt: recorded.createdAt || metadata?.createdAt || 0,
      }
    : fallback;
  return (
    <ImageViewer
      item={item}
      imageSrc={shown ? undefined : src}
      managed={!!assetFileOf(item.url)}
      actionsDisabled={originMismatch}
      onClose={onCloseEntry}
      onChange={(next) => {
        if (next) setShown(next);
        else onCloseEntry();
      }}
      onCompose={(text) => {
        if (originMismatch) return;
        onCloseEntry();
        fillComposer(text);
      }}
    />
  );
}
