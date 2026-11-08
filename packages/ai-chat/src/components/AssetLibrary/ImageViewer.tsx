/**
 * 生成图片的查看器（对话里点开图片 / 素材库点开一张共用）：左边大图，右边信息与操作。
 * - 大图：左上分辨率（真实像素，长边够大时写 4K / 2K），右上全屏查看 · 复制图片 · 更多（下载、在文件夹中显示、删除）；
 *   从素材库打开时（给了 items）左右切换、底下一排缩略图，←/→ 也能切；
 * - 右边：文件名、提示词（可复制）、标签（素材库里可以加 / 删）、分类（可以改）、素材信息（尺寸、画幅、来源、模型、
 *   生成时间、文件大小、改自 / 参考图）、同一分类的相关推荐；
 * - 重新生成（沿用原图的提示词 / 模型 / 画幅 / 改图来源 / 参考图）、以此修改、作为参考生成。
 * 「以此修改 / 作为参考」回到对话，把带图片链接的一句话填进输入框：用户写完要求发出去，
 * Nomi 才会带着这张图调 image_generate（edit_image / reference_images）。图片只发给图片模型，不进对话上下文。
 */
import { Button, Icon, IconButton, Modal, Select, getLocale, t } from '@nomi-ai/ui';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  File,
  FolderOpen,
  ImageIcon,
  ImagePlus,
  Info,
  Maximize2,
  MoreHorizontal,
  PencilLine,
  Plus,
  Ratio,
  RefreshCw,
  Ruler,
  Sparkles,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { api, hostAssetUrl } from '../../services/api';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import type { ConversationBackend } from '../../types/chat';
import { copyImage } from '../../utils/copyImage';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { confirmDialog } from '../ConfirmDialog';
import { EndpointIcon } from '../EndpointIcon';

import {
  ASSET_CATEGORIES,
  CATEGORY_LABEL,
  formatBytes,
  resolutionLabel,
  type AssetCategory,
} from './categories';
import styles from './ImageViewer.module.css';

export interface AssetItem {
  file: string;
  url: string;
  source: string;
  createdAt: number;
  bytes: number;
  model?: string;
  prompt?: string;
  aspect?: string;
  editedFrom?: string;
  references?: string[];
  category?: AssetCategory;
  categoryBy?: 'ai' | 'rule' | 'user';
  tags?: string[];
  width?: number;
  height?: number;
}

/** 素材库里的图片地址：chat-asset://images/<来源>-<编号>.<扩展名> */
const ASSET_URL =
  /^chat-asset:\/\/images\/([a-z][a-z0-9]*-[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))$/i;
export const assetFileOf = (url: string): string | null => ASSET_URL.exec(url)?.[1] ?? null;
const assetUrl = (file: string) => `chat-asset://images/${file}`;

const isEndpoint = (s: string): s is ConversationBackend => s in ENDPOINT_NAME;
/** 来源名：编程助手 / Nomi 用端点名；user = 用户在对话里发送的原图 */
export const sourceName = (s: string) =>
  s === 'user' ? t('ui.media.source-user') : isEndpoint(s) ? t(ENDPOINT_NAME[s]) : s;

export const SourceBadge: React.FC<{ source: string }> = ({ source }) => (
  <span className={styles.source} data-testid="asset-source">
    {isEndpoint(source) && <EndpointIcon backend={source} size={14} decorative />}
    {sourceName(source)}
  </span>
);

/** 按界面语言格式化（不跟系统 / WebView 的默认语言：Go 版 WebKit 默认是 en-US） */
export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleString(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 原图 / 参考图的小缩略图 */
const Thumbs: React.FC<{ files: string[]; testId: string }> = ({ files, testId }) => (
  <span className={styles.refThumbs} data-testid={testId}>
    {files.map((f) => (
      <img key={f} src={hostAssetUrl(assetUrl(f))} alt="" title={f} referrerPolicy="no-referrer" />
    ))}
  </span>
);

interface MenuItem {
  key: string;
  label: string;
  icon: typeof Download;
  danger?: boolean;
  testId: string;
  run: () => void;
}

/** 大图右上的「更多」：下载、在文件夹中显示、删除 */
const MoreMenu: React.FC<{ items: MenuItem[] }> = ({ items }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [open]);
  return (
    <div
      className={styles.menuWrap}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        // 只关菜单，不关查看器
        e.stopPropagation();
        setOpen(false);
      }}
    >
      <IconButton
        size="sm"
        className={styles.stageBtn}
        icon={<Icon icon={MoreHorizontal} size={16} />}
        label={t('ui.cli-monitor.more-actions')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="viewer-more"
      />
      {open && (
        <div className={styles.menu} role="menu">
          {items.map((m) => (
            <button
              key={m.key}
              type="button"
              role="menuitem"
              className={styles.menuItem}
              data-danger={m.danger || undefined}
              onClick={() => {
                setOpen(false);
                m.run();
              }}
              data-testid={m.testId}
            >
              <Icon icon={m.icon} size={14} />
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** 标签：素材库里可以加 / 删（onChange 有才可改） */
const TagEditor: React.FC<{ tags: string[]; onChange?: (tags: string[]) => void }> = ({
  tags,
  onChange,
}) => {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const commit = () => {
    const v = text.trim();
    setText('');
    setAdding(false);
    if (v && onChange) onChange([...tags, v]);
  };
  if (!tags.length && !onChange) return null;
  return (
    <div className={styles.tags} data-testid="viewer-tags">
      {tags.map((tag) => (
        <span key={tag} className={styles.tag}>
          {tag}
          {onChange && (
            <button
              type="button"
              className={styles.tagX}
              aria-label={t('ui.media.remove-tag', tag)}
              onClick={() => onChange(tags.filter((x) => x !== tag))}
            >
              <Icon icon={X} size={11} />
            </button>
          )}
        </span>
      ))}
      {onChange &&
        (adding ? (
          <input
            className={styles.tagInput}
            autoFocus
            value={text}
            maxLength={20}
            placeholder={t('ui.media.tag-placeholder')}
            aria-label={t('ui.media.add-tag')}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setText('');
                setAdding(false);
              }
            }}
            data-testid="viewer-tag-input"
          />
        ) : (
          tags.length < 12 && (
            <button
              type="button"
              className={styles.tagAdd}
              aria-label={t('ui.media.add-tag')}
              title={t('ui.media.add-tag')}
              onClick={() => setAdding(true)}
              data-testid="viewer-tag-add"
            >
              <Icon icon={Plus} size={13} />
            </button>
          )
        ))}
    </div>
  );
};

export interface ImageViewerProps {
  item: AssetItem;
  onClose: () => void;
  /** 重新生成后换成新图；删除后 null；改了分类 / 标签后是改后的这张 */
  onChange?: (next: AssetItem | null) => void;
  /** 回到对话并把这句话填进输入框（以此修改 / 作为参考）；没有时不显示这两个操作 */
  onCompose?: (text: string) => void;
  /** 素材库里打开时：当前列表（左右切换、缩略图、相关推荐）；对话里打开时不给 */
  items?: AssetItem[];
  /** 切到列表里的另一张 */
  onNavigate?: (item: AssetItem) => void;
  /** 相关推荐的「查看更多」：回到素材库按这个分类筛选 */
  onShowCategory?: (category: AssetCategory) => void;
}

const RELATED = 4;

export const ImageViewer: React.FC<ImageViewerProps> = ({
  item,
  onClose,
  onChange,
  onCompose,
  items,
  onNavigate,
  onShowCategory,
}) => {
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // 换了一张：清掉上一张的尺寸、错误与「已复制」（渲染时比对，不在 effect 里 setState）
  const [shownFile, setShownFile] = useState(item.file);
  if (shownFile !== item.file) {
    setShownFile(item.file);
    setLoaded(null);
    setErr(null);
    setCopied(false);
  }
  // 缩略图条滚到当前这张
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [item.file]);
  const nomi = item.source === 'nomi';
  const editable = !!onChange && !!items;
  const w = item.width ?? loaded?.w;
  const h = item.height ?? loaded?.h;
  const res = resolutionLabel(w, h);

  // 列表里的位置：左右切换与缩略图
  const index = items ? items.findIndex((x) => x.file === item.file) : -1;
  const prev = index > 0 ? items![index - 1] : undefined;
  const next = index >= 0 && items && index < items.length - 1 ? items[index + 1] : undefined;
  useEffect(() => {
    if (!onNavigate) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev);
      if (e.key === 'ArrowRight' && next) onNavigate(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNavigate, prev, next]);
  const related =
    items && item.category
      ? items.filter((x) => x.file !== item.file && x.category === item.category).slice(0, RELATED)
      : [];

  // 模型记成「供应商 id/模型」：供应商 id 是内部 id，显示时换成供应商名称（取不到就原样显示）
  const [providerNames, setProviderNames] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!item.model?.includes('/') || !gatewayClientAvailable()) return;
    let live = true;
    gatewayClient
      .state()
      .then((s) => live && setProviderNames(new Map(s.providers.map((p) => [p.id, p.name]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [item.model]);
  const modelLabel = (() => {
    const m = item.model;
    if (!m) return m;
    const i = m.indexOf('/');
    const name = i > 0 ? providerNames?.get(m.slice(0, i)) : undefined;
    return name ? `${name} / ${m.slice(i + 1)}` : m;
  })();

  const showErr = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));
  const update = (patch: { category?: AssetCategory; tags?: string[] }) => {
    void api.chatAssets
      .update({ file: item.file, ...patch })
      .then((next) => onChange?.(next as AssetItem))
      .catch(showErr);
  };
  const regenerate = async () => {
    // 会再调一次图片接口（按次计费）：先确认
    if (
      !(await confirmDialog({
        title: t('ui.media.regenerate-image-title'),
        message: item.model
          ? t('ui.media.regenerate-image-body-model', item.model)
          : t('ui.media.regenerate-image-body'),
        confirmLabel: t('ui.usage-tools.regenerate'),
      }))
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const fresh = (await api.chatAssets.regenerate({ file: item.file })) as AssetItem;
      onChange?.(fresh);
    } catch (e) {
      showErr(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: t('ui.media.delete-image-title'),
        message: t('ui.media.delete-image-body'),
        confirmLabel: t('ui.foundation.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await api.chatAssets.remove({ files: [item.file] });
    } catch (e) {
      showErr(e); // 删除失败：留在查看器里说明原因，不当成已删除
      return;
    }
    onChange?.(null);
    onClose();
  };
  const copyPrompt = () => {
    if (!item.prompt) return;
    void navigator.clipboard?.writeText(item.prompt).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  const copyImg = () =>
    void copyImage(hostAssetUrl(item.url)).catch((e: unknown) =>
      setErr(t('ui.media.copy-image-failed', e instanceof Error ? e.message : String(e))),
    );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={<SourceBadge source={item.source} />}
      className={styles.modal}
      bodyClassName={styles.body}
      data-testid="image-viewer"
    >
      <div className={styles.left}>
        <div className={styles.stage} ref={stageRef}>
          <img
            className={styles.image}
            src={hostAssetUrl(item.url)}
            alt={item.prompt ?? ''}
            referrerPolicy="no-referrer"
            onLoad={(e) =>
              setLoaded({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
          {res && (
            <span className={styles.resBadge} data-testid="viewer-resolution">
              <Icon icon={Sparkles} size={13} />
              {res}
            </span>
          )}
          <div className={styles.stageActions}>
            <IconButton
              size="sm"
              className={styles.stageBtn}
              icon={<Icon icon={Maximize2} size={15} />}
              label={t('ui.media.fullscreen')}
              onClick={() => void stageRef.current?.requestFullscreen?.().catch(() => undefined)}
              data-testid="viewer-fullscreen"
            />
            <IconButton
              size="sm"
              className={styles.stageBtn}
              icon={<Icon icon={Copy} size={15} />}
              label={t('ui.media.copy-image')}
              onClick={copyImg}
              data-testid="viewer-copy-image"
            />
            <MoreMenu
              items={[
                {
                  key: 'download',
                  label: t('ui.knowledge-local.download'),
                  icon: Download,
                  testId: 'viewer-download',
                  run: () => void api.chatAssets.saveAs({ file: item.file }).catch(showErr),
                },
                {
                  key: 'reveal',
                  label: t('ui.providers-schedule.show-in-folder'),
                  icon: FolderOpen,
                  testId: 'asset-reveal',
                  run: () => void api.chatAssets.reveal({ file: item.file }).catch(showErr),
                },
                {
                  key: 'delete',
                  label: t('ui.foundation.delete'),
                  icon: Trash2,
                  danger: true,
                  testId: 'asset-delete',
                  run: () => void remove(),
                },
              ]}
            />
          </div>
          {onNavigate && prev && (
            <button
              type="button"
              className={styles.nav}
              data-side="prev"
              aria-label={t('ui.session-workspace.previous')}
              onClick={() => onNavigate(prev)}
              data-testid="viewer-prev"
            >
              <Icon icon={ChevronLeft} size={20} />
            </button>
          )}
          {onNavigate && next && (
            <button
              type="button"
              className={styles.nav}
              data-side="next"
              aria-label={t('ui.session-workspace.next')}
              onClick={() => onNavigate(next)}
              data-testid="viewer-next"
            >
              <Icon icon={ChevronRight} size={20} />
            </button>
          )}
        </div>
        {onNavigate && items && items.length > 1 && (
          <div className={styles.strip} ref={stripRef} data-testid="viewer-strip">
            {items.map((x) => (
              <button
                key={x.file}
                type="button"
                className={styles.stripItem}
                aria-current={x.file === item.file ? 'true' : undefined}
                aria-label={x.prompt ?? x.file}
                onClick={() => onNavigate(x)}
              >
                <img src={hostAssetUrl(x.url)} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        )}
      </div>

      <aside className={styles.panel}>
        <div className={styles.titleRow}>
          <span className={styles.fileIcon} aria-hidden>
            <Icon icon={ImageIcon} size={16} />
          </span>
          <h3 className={styles.fileName} title={item.file}>
            {item.file}
          </h3>
        </div>
        <div className={styles.promptRow}>
          <p className={styles.prompt} data-testid="viewer-prompt">
            {item.prompt ?? t('ui.media.no-prompt')}
          </p>
          {item.prompt && (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={copyPrompt}
              data-testid="viewer-copy-prompt"
            >
              <Icon icon={Copy} size={12} />
              {copied ? t('ui.usage-tools.copied') : t('ui.media.copy-prompt')}
            </button>
          )}
        </div>
        <TagEditor
          tags={item.tags ?? []}
          {...(editable ? { onChange: (tags: string[]) => update({ tags }) } : {})}
        />

        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>
            <Icon icon={Info} size={15} />
            {t('ui.media.details')}
          </h4>
          <dl className={styles.meta} data-testid="viewer-details">
            {item.category && (
              <>
                <dt>
                  <Icon icon={Tag} size={14} />
                  {t('ui.media.category')}
                </dt>
                <dd>
                  {editable ? (
                    <Select
                      size="sm"
                      variant="ghost"
                      className={styles.categorySelect}
                      value={item.category}
                      aria-label={t('ui.media.category')}
                      onChange={(e) => update({ category: e.target.value as AssetCategory })}
                      options={ASSET_CATEGORIES.map((c) => ({
                        value: c,
                        label: t(CATEGORY_LABEL[c]),
                      }))}
                      data-testid="viewer-category"
                    />
                  ) : (
                    t(CATEGORY_LABEL[item.category])
                  )}
                </dd>
              </>
            )}
            {w && h ? (
              <>
                <dt>
                  <Icon icon={Ruler} size={14} />
                  {t('ui.media.size')}
                </dt>
                <dd>{`${w} × ${h}`}</dd>
              </>
            ) : null}
            {item.aspect && (
              <>
                <dt>
                  <Icon icon={Ratio} size={14} />
                  {t('ui.media.aspect')}
                </dt>
                <dd>{item.aspect}</dd>
              </>
            )}
            <dt>
              <Icon icon={User} size={14} />
              {t('ui.knowledge-local.sources')}
            </dt>
            <dd>
              <SourceBadge source={item.source} />
            </dd>
            {item.model && (
              <>
                <dt>
                  <Icon icon={Sparkles} size={14} />
                  {t('ui.foundation.model')}
                </dt>
                <dd className={styles.mono}>{modelLabel}</dd>
              </>
            )}
            <dt>
              <Icon icon={Clock} size={14} />
              {t('ui.media.created-at')}
            </dt>
            <dd>{fmtTime(item.createdAt)}</dd>
            {item.bytes > 0 && (
              <>
                <dt>
                  <Icon icon={File} size={14} />
                  {t('ui.media.file-size')}
                </dt>
                <dd>{formatBytes(item.bytes)}</dd>
              </>
            )}
            {item.editedFrom && (
              <>
                <dt>{t('ui.media.edited-from')}</dt>
                <dd>
                  <Thumbs files={[item.editedFrom]} testId="viewer-edited-from" />
                </dd>
              </>
            )}
            {!!item.references?.length && (
              <>
                <dt>{t('ui.media.references')}</dt>
                <dd>
                  <Thumbs files={item.references} testId="viewer-references" />
                </dd>
              </>
            )}
          </dl>
        </section>

        {related.length > 0 && onNavigate && (
          <section className={styles.section} data-testid="viewer-related">
            <div className={styles.sectionHead}>
              <h4 className={styles.sectionTitle}>{t('ui.media.related')}</h4>
              {onShowCategory && item.category && (
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => onShowCategory(item.category!)}
                  data-testid="viewer-related-more"
                >
                  {t('ui.media.see-more')}
                  <Icon icon={ChevronRight} size={12} />
                </button>
              )}
            </div>
            <div className={styles.related}>
              {related.map((x) => (
                <button
                  key={x.file}
                  type="button"
                  className={styles.relatedItem}
                  aria-label={x.prompt ?? x.file}
                  onClick={() => onNavigate(x)}
                >
                  <img
                    src={hostAssetUrl(x.url)}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </button>
              ))}
            </div>
          </section>
        )}

        {err && (
          <p className={styles.error} role="alert">
            {err}
          </p>
        )}
        {((nomi && item.prompt) || onCompose) && (
          <div className={styles.actions}>
            {nomi && item.prompt && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void regenerate()}
                data-testid="viewer-regenerate"
              >
                <Icon icon={RefreshCw} size={14} />
                {busy ? t('ui.media.regenerating') : t('ui.usage-tools.regenerate')}
              </Button>
            )}
            {onCompose && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => onCompose(t('ui.media.compose-edit', item.url))}
                  data-testid="viewer-edit"
                >
                  <Icon icon={PencilLine} size={14} />
                  {t('ui.media.edit-this')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => onCompose(t('ui.media.compose-reference', item.url))}
                  data-testid="viewer-reference"
                >
                  <Icon icon={ImagePlus} size={14} />
                  {t('ui.media.use-as-reference')}
                </Button>
              </>
            )}
          </div>
        )}
      </aside>
    </Modal>
  );
};

/** 对话里点开一张生成的图片：按文件名从素材库补齐提示词 / 模型等信息（拿不到时只显示图片） */
export function useAssetItem(url: string, open: boolean): AssetItem | null {
  const file = assetFileOf(url);
  const [item, setItem] = useState<AssetItem | null>(null);
  useEffect(() => {
    if (!open || !file) return;
    let alive = true;
    const fallback: AssetItem = {
      file,
      url,
      source: file.split('-')[0] === 'gen' ? 'nomi' : file.split('-')[0]!,
      createdAt: Date.now(),
      bytes: 0,
    };
    void api.chatAssets
      .list()
      .then((l) => {
        if (alive) setItem((l as AssetItem[]).find((x) => x.file === file) ?? fallback);
      })
      .catch(() => alive && setItem(fallback));
    return () => {
      alive = false;
    };
  }, [open, file, url]);
  return open ? item : null;
}
