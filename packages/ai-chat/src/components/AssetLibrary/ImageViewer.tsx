/**
 * 生成图片的查看器（对话里点开图片 / 素材库点开一张共用）：左边大图，右边信息与操作。
 * - 提示词（可复制）、模型、尺寸、画幅、来源、生成时间；改图 / 参考图生成的标出原图与参考图；
 * - 重新生成（沿用原图的提示词 / 模型 / 画幅 / 改图来源 / 参考图）、以此修改、作为参考生成、
 *   下载（另存为）、在文件夹中显示、删除。
 * 「以此修改 / 作为参考」回到对话，把带图片链接的一句话填进输入框：用户写完要求发出去，
 * Nomi 才会带着这张图调 image_generate（edit_image / reference_images）。图片只发给图片模型，不进对话上下文。
 */
import { Button, Icon, Modal, getLocale, t } from '@nomi-ai/ui';
import { Copy, Download, FolderOpen, ImagePlus, PencilLine, RefreshCw, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { api, hostAssetUrl } from '../../services/api';
import { gatewayClient, gatewayClientAvailable } from '../../services/gatewayClient';
import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { confirmDialog } from '../ConfirmDialog';
import { EndpointIcon } from '../EndpointIcon';

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
}

/** 素材库里的图片地址：chat-asset://images/<来源>-<编号>.<扩展名> */
const ASSET_URL =
  /^chat-asset:\/\/images\/([a-z][a-z0-9]*-[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))$/i;
export const assetFileOf = (url: string): string | null => ASSET_URL.exec(url)?.[1] ?? null;
const assetUrl = (file: string) => `chat-asset://images/${file}`;

const isEndpoint = (s: string): s is ConversationBackend => s in ENDPOINT_NAME;
export const sourceName = (s: string) => (isEndpoint(s) ? t(ENDPOINT_NAME[s]) : s);

export const SourceBadge: React.FC<{ source: string }> = ({ source }) => (
  <span className={styles.source} data-testid="asset-source">
    {isEndpoint(source) && <EndpointIcon backend={source} size={12} decorative />}
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
  <span className={styles.thumbs} data-testid={testId}>
    {files.map((f) => (
      <img key={f} src={hostAssetUrl(assetUrl(f))} alt="" title={f} referrerPolicy="no-referrer" />
    ))}
  </span>
);

export interface ImageViewerProps {
  item: AssetItem;
  onClose: () => void;
  /** 重新生成后换成新图；删除后 null */
  onChange?: (next: AssetItem | null) => void;
  /** 回到对话并把这句话填进输入框（以此修改 / 作为参考）；没有时不显示这两个操作 */
  onCompose?: (text: string) => void;
}

export const ImageViewer: React.FC<ImageViewerProps> = ({ item, onClose, onChange, onCompose }) => {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setSize(null);
    setErr(null);
  }, [item.file]);
  const nomi = item.source === 'nomi';
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
      const next = (await api.chatAssets.regenerate({ file: item.file })) as AssetItem;
      onChange?.(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const showErr = (e: unknown) => setErr(e instanceof Error ? e.message : String(e));
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
  const copy = () => {
    if (!item.prompt) return;
    void navigator.clipboard?.writeText(item.prompt).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={<SourceBadge source={item.source} />}
      className={styles.modal}
      bodyClassName={styles.body}
      data-testid="image-viewer"
    >
      <div className={styles.stage}>
        <img
          className={styles.image}
          src={hostAssetUrl(item.url)}
          alt={item.prompt ?? ''}
          referrerPolicy="no-referrer"
          onLoad={(e) =>
            setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
        />
      </div>
      <aside className={styles.panel}>
        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span className={styles.blockTitle}>{t('ui.media.prompt')}</span>
            {item.prompt && (
              <Button size="sm" variant="ghost" onClick={copy} data-testid="viewer-copy-prompt">
                <Icon icon={Copy} size={13} />
                {copied ? t('ui.usage-tools.copied') : t('ui.knowledge-local.copy')}
              </Button>
            )}
          </div>
          <p className={styles.prompt} data-testid="viewer-prompt">
            {item.prompt ?? t('ui.media.no-prompt')}
          </p>
        </section>
        <section className={styles.block}>
          <div className={styles.blockHead}>
            <span className={styles.blockTitle}>{t('ui.media.details')}</span>
          </div>
          <dl className={styles.meta} data-testid="viewer-details">
            {item.model && (
              <>
                <dt>{t('ui.foundation.model')}</dt>
                <dd className={styles.mono}>{modelLabel}</dd>
              </>
            )}
            {size && (
              <>
                <dt>{t('ui.media.size')}</dt>
                <dd>{`${size.w}×${size.h}`}</dd>
              </>
            )}
            {item.aspect && (
              <>
                <dt>{t('ui.media.aspect')}</dt>
                <dd>{item.aspect}</dd>
              </>
            )}
            <dt>{t('ui.knowledge-local.sources')}</dt>
            <dd>
              <SourceBadge source={item.source} />
            </dd>
            <dt>{t('ui.media.created-at')}</dt>
            <dd>{fmtTime(item.createdAt)}</dd>
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
        {err && (
          <p className={styles.error} role="alert">
            {err}
          </p>
        )}
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
            <div className={styles.row}>
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
            </div>
          )}
          <div className={styles.row}>
            <Button
              variant="secondary"
              onClick={() => void api.chatAssets.saveAs({ file: item.file }).catch(showErr)}
              data-testid="viewer-download"
            >
              <Icon icon={Download} size={14} />
              {t('ui.knowledge-local.download')}
            </Button>
            <Button
              variant="ghost"
              aria-label={t('ui.providers-schedule.show-in-folder')}
              title={t('ui.providers-schedule.show-in-folder')}
              onClick={() => void api.chatAssets.reveal({ file: item.file }).catch(showErr)}
              data-testid="asset-reveal"
            >
              <Icon icon={FolderOpen} size={14} />
            </Button>
            <Button
              variant="ghost"
              aria-label={t('ui.foundation.delete')}
              title={t('ui.foundation.delete')}
              onClick={() => void remove()}
              data-testid="asset-delete"
            >
              <Icon icon={Trash2} size={14} />
            </Button>
          </div>
        </div>
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
