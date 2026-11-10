/** 素材库页主体（瀑布流、筛选、查看器）：首次打开素材库时才加载（见 index.tsx 的 useAssetLibraryHost） */
import { Icon, Select, t } from '@nomi-ai/ui';
import { Database, Images, Search } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { hostAssetUrl } from '../../services/api';

import { ASSET_CATEGORIES, CATEGORY_LABEL, formatBytes, type AssetCategory } from './categories';
import { ImageViewer, SourceBadge, sourceName, type AssetItem } from './ImageViewer';
import styles from './index.module.css';
import { layoutMasonry, ratioOf } from './masonry';
import { useAssets } from './useAssets';

/** 图片间距（px），与 --cd-space-3 一致 */
const GAP = 12;

/**
 * 瀑布流：每张图按真实分辨率的宽高比显示（内核读过文件头就直接用，没有时用加载后的、再没有用画幅占位）。
 * 信息收在图片里：左上分类，底部渐变里是来源与分辨率（提示词在查看器里看）
 */
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
  const sizeOf = (x: AssetItem) =>
    x.width && x.height ? { w: x.width, h: x.height } : sizes[x.file];
  const ratios = items.map((x) => {
    const s = sizeOf(x);
    return s ? s.w / s.h : (ratioOf(x.aspect) ?? 1);
  });
  const layout = layoutMasonry(ratios, width, GAP, 0);
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
        const size = sizeOf(x);
        const label = x.prompt ?? x.file;
        return (
          <button
            key={x.file}
            type="button"
            className={styles.tile}
            style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height }}
            onClick={() => onOpen(x)}
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
              {x.category && (
                <span className={styles.catChip}>{t(CATEGORY_LABEL[x.category])}</span>
              )}
              <span className={styles.overlay}>
                <span className={styles.overlayMeta}>
                  <SourceBadge source={x.source} />
                  <span className={styles.res} data-testid="asset-resolution">
                    {size ? `${size.w} × ${size.h}` : (x.aspect ?? '')}
                  </span>
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

type CategoryFilter = AssetCategory | 'all';

/** 主区整页 */
export const AssetLibraryPage: React.FC<{
  active: boolean;
  onBack: () => void;
  /** 以此修改 / 作为参考：回到对话并把这句话填进输入框 */
  onCompose?: (text: string) => void;
  /** 从搜索打开某张图（nonce 变了就再打开一次） */
  focus?: { file: string; nonce: number } | null;
}> = ({ active, onBack, onCompose, focus }) => {
  const { items, reload } = useAssets(active);
  const [source, setSource] = useState<string>('all');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<AssetItem | null>(null);
  // 从搜索打开某张图：列表到了之后在查看器里打开它
  const [focusSeen, setFocusSeen] = useState<number | undefined>(undefined);
  const focused = focus && items?.find((x) => x.file === focus.file);
  if (focus && focused && focus.nonce !== focusSeen) {
    setFocusSeen(focus.nonce);
    setCurrent(focused);
  }
  const all = useMemo(() => items ?? [], [items]);
  const sources = useMemo(() => [...new Set(all.map((x) => x.source))], [all]);
  // 来源与搜索先筛，分类标签上的数字按筛过的算
  const base = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (x) =>
        (source === 'all' || x.source === source) &&
        (!q ||
          [x.prompt ?? '', x.file, x.model ?? '', ...(x.tags ?? [])]
            .join('\n')
            .toLowerCase()
            .includes(q)),
    );
  }, [all, source, query]);
  const counts = useMemo(() => {
    const m = new Map<CategoryFilter, number>([['all', base.length]]);
    for (const x of base) if (x.category) m.set(x.category, (m.get(x.category) ?? 0) + 1);
    return m;
  }, [base]);
  const shown = category === 'all' ? base : base.filter((x) => x.category === category);
  const usedBytes = useMemo(() => all.reduce((n, x) => n + (x.bytes || 0), 0), [all]);
  // 回对话：导航栏的「对话」，或者没开查看器时按 Esc
  useEffect(() => {
    if (!active || current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, current, onBack]);
  return (
    <section
      className={styles.page}
      aria-label={t('ui.media.asset-library')}
      data-testid="asset-library"
    >
      <header className={styles.pageHead}>
        <span className={styles.headIcon} aria-hidden>
          <Icon icon={Images} size={22} />
        </span>
        <div className={styles.headText}>
          <h2 className={styles.pageTitle}>{t('ui.media.asset-library')}</h2>
          <p className={styles.subtitle}>{t('ui.media.asset-library-subtitle')}</p>
        </div>
        <span className={styles.spacer} />
        <label className={styles.search}>
          <Icon icon={Search} size={15} />
          <input
            className={styles.searchInput}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('ui.media.search-assets')}
            aria-label={t('ui.media.search-assets')}
            data-testid="asset-search"
          />
        </label>
        {sources.length > 1 && (
          <Select
            size="sm"
            className={styles.sourceSelect}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label={t('ui.usage-tools.filter-by-source')}
            options={[
              { value: 'all', label: t('ui.usage-tools.all-sources') },
              ...sources.map((s) => ({ value: s, label: sourceName(s) })),
            ]}
            data-testid="asset-source-filter"
          />
        )}
      </header>
      <div className={styles.toolbar}>
        <div className={styles.chips} role="group" aria-label={t('ui.media.category')}>
          {(['all', ...ASSET_CATEGORIES] as CategoryFilter[]).map((c) => (
            <button
              key={c}
              type="button"
              className={styles.chip}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              data-testid={`asset-category-${c}`}
            >
              {c === 'all' ? t('ui.providers-schedule.all') : t(CATEGORY_LABEL[c])}
              <span className={styles.chipCount}>{counts.get(c) ?? 0}</span>
            </button>
          ))}
        </div>
        <span className={styles.spacer} />
        {items && (
          <span className={styles.usage} data-testid="asset-usage">
            <Icon icon={Database} size={15} />
            {t('ui.media.used-space')}
            <strong className={styles.usageValue}>{formatBytes(usedBytes)}</strong>
          </span>
        )}
      </div>
      <div className={styles.pageBody}>
        <div className={styles.gridWrap}>
          {items !== null && !shown.length ? (
            <p className={styles.empty} data-testid="asset-empty">
              {all.length ? t('ui.media.no-matching-images') : t('ui.media.no-images-yet')}
            </p>
          ) : (
            <AssetMasonry items={shown} onOpen={setCurrent} />
          )}
        </div>
      </div>
      {current && (
        <ImageViewer
          item={current}
          items={shown}
          onNavigate={setCurrent}
          onShowCategory={(c) => {
            setCurrent(null);
            setCategory(c);
          }}
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
