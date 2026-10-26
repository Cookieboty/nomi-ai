/**
 * 素材库：已入库的图片（sha256 去重），按来源筛选；手动导入；右键复制 / 另存为 / 移除。
 */
import { ASSET_SOURCES, type AssetSource } from '@nomi-ai/gateway/media';
import { Button, Modal, Select, t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useState } from 'react';

import { mediaClient, mediaToast, type MediaAsset } from '../../services/mediaClient';

import styles from './Media.module.css';
import { MediaImageMenu } from './MediaImageMenu';

const SOURCE_LABEL: Record<AssetSource, string> = {
  chat_generated: 'ui.media.src-chat-generated',
  chat_upload: 'ui.media.src-chat-upload',
  chat_reply: 'ui.media.src-chat-reply',
  studio: 'ui.media.src-studio',
  manual_add: 'ui.media.src-manual-add',
  agent: 'ui.media.src-agent',
};

export const AssetLibrary: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const [filter, setFilter] = useState<AssetSource | 'all'>('all');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const load = useCallback(() => {
    if (!mediaClient.available()) return;
    void mediaClient
      .assets(filter === 'all' ? undefined : filter)
      .then(setAssets)
      .catch(() => undefined);
  }, [filter]);
  useEffect(() => {
    if (!open) return;
    load();
    return mediaClient.onChanged(load);
  }, [open, load]);

  const importFiles = async () => {
    try {
      const added = await mediaClient.importFiles();
      if (added.length) mediaToast(t('ui.media.imported', added.length));
      load();
    } catch (e) {
      mediaToast((e as Error).message || t('ui.media.action-failed'));
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={t('ui.media.nav-library')}
      data-testid="asset-library"
    >
      <div className={styles.libraryBar}>
        <Select
          size="sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value as AssetSource | 'all')}
          aria-label={t('ui.usage-tools.filter-by-source')}
          options={[
            { value: 'all', label: t('ui.providers-schedule.all') },
            ...ASSET_SOURCES.map((s) => ({ value: s, label: t(SOURCE_LABEL[s]) })),
          ]}
        />
        <Button size="sm" onClick={() => void importFiles()} data-testid="library-import">
          {t('ui.media.import')}
        </Button>
      </div>
      {!assets.length ? (
        <p className={styles.muted}>{t('ui.media.library-empty')}</p>
      ) : (
        <div className={styles.libraryGrid}>
          {assets.map((a) => (
            <figure key={a.id} className={styles.libraryItem}>
              <MediaImageMenu src={a.url} source={a.sources[0] ?? 'manual_add'}>
                <img src={a.url} alt={a.prompt ?? ''} className={styles.genImg} loading="lazy" />
              </MediaImageMenu>
              <figcaption className={styles.muted}>
                {a.sources.map((s) => t(SOURCE_LABEL[s])).join(' · ')}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </Modal>
  );
};
