/**
 * 素材库：所有生成的图片——Nomi 的生图、编程助手（如 Grok）生成后复制过来的——统一在这里管理。
 * 入口在侧栏会话列表上方（醒目的一行）；打开后在主区整页显示，替换对话区（侧栏保持，对话区只隐藏不卸载），
 * 点一张图在右侧看大图、提示词、模型，在文件夹中显示或删除（移到废纸篓）。
 * 在侧栏切到别的会话 / 标签、新建对话时自动回到对话（参考 feat/2.1.0-image-gen-p0 的 useMediaHost）。
 * 数据来自内核 media/AssetLibrary.ts（契约 chatAssets.*）；生成 / 删除后内核推 chatAssets.changed。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { ArrowLeft, Images } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { selectFirstMessageId, useAiChatSelector } from '../../contexts/aiChatStore';
import { useHarnessTabs } from '../../contexts/HarnessTabsContext';
import { api, hasTransport, hostAssetUrl } from '../../services/api';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';
import { SideNavItem } from '../Sidebar/SideNavItem';

import { fmtTime, ImageViewer, SourceBadge, sourceName, type AssetItem } from './ImageViewer';
import styles from './index.module.css';
import { layoutMasonry, ratioOf } from './masonry';

export { ImageViewer, type AssetItem } from './ImageViewer';

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

/** 侧栏入口：会话列表上方醒目的一行（收起时只显示图标） */
export const AssetLibraryNav: React.FC<{
  collapsed: boolean;
  active: boolean;
  count?: number;
  onOpen: () => void;
}> = ({ collapsed, active, count, onOpen }) => (
  <SideNavItem
    icon={Images}
    label={t('ui.media.asset-library')}
    collapsed={collapsed}
    active={active}
    count={count}
    onOpen={onOpen}
    testId="asset-library-open"
  />
);

/** 图片间距（px），与 --cd-space-3 一致 */
const GAP = 12;
/** 图下说明行的高度（px），与 --cd-control-h-sm 一致 */
const CAPTION = 28;

/** 瀑布流：每张图按真实分辨率的宽高比显示；加载前先用生成时记下的比例占位 */
const AssetMasonry: React.FC<{ items: AssetItem[]; onOpen: (x: AssetItem) => void }> = ({
  items,
  onOpen,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ratios = items.map((x) => {
    const s = sizes[x.file];
    return s ? s.w / s.h : (ratioOf(x.aspect) ?? 1);
  });
  const layout = layoutMasonry(ratios, width, GAP, CAPTION);
  const onLoad = (file: string, img: HTMLImageElement) => {
    const { naturalWidth: w, naturalHeight: h } = img;
    if (w > 0 && h > 0 && (sizes[file]?.w !== w || sizes[file]?.h !== h))
      setSizes((prev) => ({ ...prev, [file]: { w, h } }));
  };
  return (
    <div
      ref={ref}
      className={styles.masonry}
      style={{ height: layout.height }}
      data-testid="asset-grid"
    >
      {items.map((x, i) => {
        const pos = layout.items[i]!;
        const size = sizes[x.file];
        const label = x.prompt ?? x.file;
        return (
          <button
            key={x.file}
            type="button"
            className={styles.tile}
            style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height }}
            onClick={() => onOpen(x)}
            title={`${label}\n${fmtTime(x.createdAt)}`}
            aria-label={label}
            data-testid={`asset-${x.file}`}
          >
            <span className={styles.frame}>
              <img
                src={hostAssetUrl(x.url)}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onLoad={(e) => onLoad(x.file, e.currentTarget)}
              />
            </span>
            <span className={styles.tileMeta}>
              <SourceBadge source={x.source} />
              <span className={styles.res} data-testid="asset-resolution">
                {size ? `${size.w} × ${size.h}` : (x.aspect ?? '')}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

/** 主区整页 */
export const AssetLibraryPage: React.FC<{
  active: boolean;
  onBack: () => void;
  /** 以此修改 / 作为参考：回到对话并把这句话填进输入框 */
  onCompose?: (text: string) => void;
}> = ({ active, onBack, onCompose }) => {
  const { items, reload } = useAssets(active);
  const [filter, setFilter] = useState<string | null>(null);
  const [current, setCurrent] = useState<AssetItem | null>(null);
  const sources = useMemo(() => [...new Set((items ?? []).map((x) => x.source))], [items]);
  const shown = (items ?? []).filter((x) => filter === null || x.source === filter);
  return (
    <section
      className={styles.page}
      aria-label={t('ui.media.asset-library')}
      data-testid="asset-library"
    >
      <header className={styles.pageHead}>
        <Button size="sm" variant="ghost" onClick={onBack} data-testid="asset-back">
          <Icon icon={ArrowLeft} size={14} />
          {t('ui.chat-settings.back-to-chat')}
        </Button>
        <h2 className={styles.pageTitle}>{t('ui.media.asset-library')}</h2>
        {items && <span className={styles.pageCount}>{shown.length}</span>}
      </header>
      {sources.length > 1 && (
        <div
          className={styles.filters}
          role="group"
          aria-label={t('ui.usage-tools.filter-by-source')}
        >
          {[null, ...sources].map((s) => (
            <button
              key={s ?? '*'}
              type="button"
              className={styles.chip}
              aria-pressed={filter === s}
              onClick={() => setFilter(s)}
              data-testid={`asset-filter-${s ?? 'all'}`}
            >
              {s === null ? t('ui.providers-schedule.all') : sourceName(s)}
            </button>
          ))}
        </div>
      )}
      <div className={styles.pageBody}>
        <div className={styles.gridWrap}>
          {items !== null && !shown.length ? (
            <p className={styles.empty} data-testid="asset-empty">
              {t('ui.media.no-images-yet')}
            </p>
          ) : (
            <AssetMasonry items={shown} onOpen={setCurrent} />
          )}
        </div>
      </div>
      {current && (
        <ImageViewer
          item={current}
          onClose={() => setCurrent(null)}
          onChange={(next) => {
            setCurrent(next);
            reload();
          }}
          {...(onCompose
            ? {
                onCompose: (text: string) => {
                  setCurrent(null);
                  onCompose(text);
                },
              }
            : {})}
        />
      )}
    </section>
  );
};

/**
 * 素材库宿主：侧栏入口 + 主区整页。页面第一次打开后保持挂载（切回对话只隐藏）；
 * 切到别的会话 / 标签时自动回到对话。
 */
export function useAssetLibraryHost(collapsed: boolean) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  // 入口上的数量：常驻订阅（生成 / 删除后跟着变）
  const { items } = useAssets(hasTransport());
  const show = useCallback(() => {
    setOpen(true);
    setMounted(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const { fillComposer } = useChangesUi();
  // 以此修改 / 作为参考：回到对话，把带图片链接的一句话填进输入框
  const compose = useCallback(
    (text: string) => {
      setOpen(false);
      fillComposer(text);
    },
    [fillComposer],
  );
  // 在侧栏点了别的会话 / 切了标签 → 回到对话
  const first = useAiChatSelector(selectFirstMessageId);
  const tabId = useHarnessTabs().state?.activeTabId;
  const last = useRef({ first, tabId });
  useEffect(() => {
    if (last.current.first !== first || last.current.tabId !== tabId) setOpen(false);
    last.current = { first, tabId };
  }, [first, tabId]);
  if (!hasTransport()) return { nav: null, page: null, chatHidden: false, close };
  const nav = (
    <AssetLibraryNav collapsed={collapsed} active={open} count={items?.length} onOpen={show} />
  );
  const page = mounted ? (
    <div className={styles.main} hidden={!open} data-testid="asset-library-main">
      <AssetLibraryPage active={open} onBack={close} onCompose={compose} />
    </div>
  ) : null;
  return { nav, page, chatHidden: open, close };
}
