import { useCallback, useEffect, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import type { AssetItem } from './ImageViewer';

/** 素材库列表：拉一次并跟着 chatAssets.changed 刷新（enabled 为 false 时不拉） */
export function useAssets(enabled = true) {
  const [items, setItems] = useState<AssetItem[] | null>(null);
  const load = useCallback(() => {
    if (!hasTransport()) return;
    void api.chatAssets
      .list()
      .then((l) => setItems(l as AssetItem[]))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    if (!enabled || !hasTransport()) return;
    load();
    return api.on('chatAssets.changed', load);
  }, [enabled, load]);
  return { items, reload: load };
}
