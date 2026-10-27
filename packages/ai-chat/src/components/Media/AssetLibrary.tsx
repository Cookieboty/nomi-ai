/**
 * 素材库（整页，侧栏固定入口打开）：已入库的图片（sha256 去重），按来源筛选；手动导入；
 * 多选后批量删除（文件 + 索引一起删）/ 批量导出原图；单张右键复制 / 另存为 / 移除。
 */
import { ASSET_SOURCES, type AssetSource } from '@nomi-ai/gateway/media';
import { Button, Icon, Modal, t } from '@nomi-ai/ui';
import { Check } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import {
  mediaClient,
  mediaToast,
  modelName,
  useMediaState,
  type MediaAsset,
} from '../../services/mediaClient';

import styles from './Media.module.css';
import { MediaImageMenu } from './MediaImageMenu';

export const SOURCE_LABEL: Record<AssetSource, string> = {
  chat_generated: 'ui.media.src-chat-generated',
  chat_upload: 'ui.media.src-chat-upload',
  chat_reply: 'ui.media.src-chat-reply',
  studio: 'ui.media.src-studio',
  manual_add: 'ui.media.src-manual-add',
  agent: 'ui.media.src-agent',
};

/** 选中集合的纯函数操作（单测覆盖） */
export function toggleSelection(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
export function selectAllOrNone(sel: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  return ids.length && ids.every((id) => sel.has(id)) ? new Set() : new Set(ids);
}
/** 列表刷新后去掉已不存在的选中项 */
export function pruneSelection(sel: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const keep = new Set(ids);
  return new Set([...sel].filter((id) => keep.has(id)));
}

export const AssetLibrary: React.FC<{ active: boolean }> = ({ active }) => {
  const [state] = useMediaState();
  const [filter, setFilter] = useState<AssetSource | 'all'>('all');
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const load = useCallback(() => {
    if (!mediaClient.available()) return;
    void mediaClient
      .assets(filter === 'all' ? undefined : filter)
      .then((list) => {
        setAssets(list);
        setSelected((s) =>
          pruneSelection(
            s,
            list.map((a) => a.id),
          ),
        );
      })
      .catch(() => undefined);
  }, [filter]);
  useEffect(() => {
    if (!active) return;
    load();
    return mediaClient.onChanged(load);
  }, [active, load]);

  const fail = (e: unknown) => mediaToast((e as Error).message || t('ui.media.action-failed'));
  const importFiles = async () => {
    try {
      const added = await mediaClient.importFiles();
      if (added.length) mediaToast(t('ui.media.imported', added.length));
      load();
    } catch (e) {
      fail(e);
    }
  };
  const ids = [...selected];
  const exportSelected = async () => {
    try {
      const n = await mediaClient.exportAssets(ids);
      if (n) mediaToast(t('ui.media.exported', n));
    } catch (e) {
      fail(e);
    }
  };
  const deleteSelected = async () => {
    setConfirming(false);
    try {
      const n = await mediaClient.deleteAssets(ids);
      mediaToast(t('ui.media.deleted', n));
      setSelected(new Set());
      load();
    } catch (e) {
      fail(e);
    }
  };
  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  return (
    <section
      className={styles.libraryPage}
      data-testid="asset-library"
      aria-label={t('ui.media.nav-library')}
    >
      <div className={styles.pageHead}>
        <div>
          <h2 className={styles.pageTitle}>{t('ui.media.nav-library')}</h2>
          <div className={styles.muted}>{t('ui.media.library-subtitle')}</div>
        </div>
        <div className={styles.actions}>
          {selecting ? (
            <>
              <span className={styles.selCount} data-testid="library-selected-count">
                {t('ui.media.selected-count', selected.size)}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  setSelected((s) =>
                    selectAllOrNone(
                      s,
                      assets.map((a) => a.id),
                    ),
                  )
                }
              >
                {t('ui.providers-schedule.select-all')}
              </Button>
              <Button
                size="sm"
                disabled={!selected.size}
                onClick={() => void exportSelected()}
                data-testid="library-export"
              >
                {t('ui.knowledge-local.export')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!selected.size}
                onClick={() => setConfirming(true)}
                data-testid="library-delete"
              >
                {t('ui.foundation.delete')}
              </Button>
              <Button size="sm" variant="ghost" onClick={exitSelect}>
                {t('ui.foundation.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={!assets.length}
                onClick={() => setSelecting(true)}
                data-testid="library-select"
              >
                {t('ui.media.multi-select')}
              </Button>
              <Button size="sm" onClick={() => void importFiles()} data-testid="library-import">
                {t('ui.media.import')}
              </Button>
            </>
          )}
        </div>
      </div>
      <div
        className={styles.chips}
        role="radiogroup"
        aria-label={t('ui.usage-tools.filter-by-source')}
      >
        {(['all', ...ASSET_SOURCES] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={filter === s}
            className={`${styles.chip} ${filter === s ? styles.chipOn : ''}`}
            onClick={() => setFilter(s)}
          >
            {s === 'all' ? t('ui.providers-schedule.all') : t(SOURCE_LABEL[s])}
          </button>
        ))}
      </div>
      {!assets.length ? (
        <p className={styles.muted}>{t('ui.media.library-empty')}</p>
      ) : (
        <div className={styles.libraryGrid} data-testid="library-grid">
          {assets.map((a) => {
            const on = selected.has(a.id);
            const img = (
              <img src={a.url} alt={a.prompt ?? ''} className={styles.tileImg} loading="lazy" />
            );
            return (
              <figure
                key={a.id}
                className={`${styles.tile} ${on ? styles.tileOn : ''}`}
                data-testid="library-item"
              >
                {selecting ? (
                  <button
                    type="button"
                    className={styles.tilePick}
                    aria-pressed={on}
                    onClick={() => setSelected((s) => toggleSelection(s, a.id))}
                  >
                    {img}
                    <span className={styles.tileCheck}>
                      {on && <Icon icon={Check} size={12} />}
                    </span>
                  </button>
                ) : (
                  <MediaImageMenu src={a.url} source={a.sources[0] ?? 'manual_add'}>
                    {img}
                  </MediaImageMenu>
                )}
                <figcaption className={styles.tileMeta}>
                  <span className={styles.tags}>
                    {a.sources.map((s) => (
                      <span key={s} className={styles.tag}>
                        {t(SOURCE_LABEL[s])}
                      </span>
                    ))}
                  </span>
                  {a.modelId ? <span>{modelName(state, a.modelId)}</span> : null}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('ui.foundation.delete')}
        footer={
          <>
            <Button onClick={() => setConfirming(false)}>{t('ui.foundation.cancel')}</Button>
            <Button
              variant="danger"
              onClick={() => void deleteSelected()}
              data-testid="library-delete-confirm"
            >
              {t('ui.foundation.delete')}
            </Button>
          </>
        }
      >
        <p>{t('ui.media.confirm-delete', selected.size)}</p>
      </Modal>
    </section>
  );
};
