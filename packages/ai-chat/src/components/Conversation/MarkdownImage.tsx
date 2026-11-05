/** 助手 Markdown 中的图片：协议白名单 + 懒加载 + 加载失败兜底 + 点击放大。*/
import { Modal, t, useLocale } from '@nomi-ai/ui';
import React, { memo, useEffect, useState } from 'react';

import { api, hasTransport, hostAssetUrl } from '../../services/api';
import { assetFileOf, ImageViewer, useAssetItem } from '../AssetLibrary/ImageViewer';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';

import { isLocalImagePath, sanitizeImgSrc } from './Markdown.helpers';
import styles from './MarkdownImage.module.css';

/**
 * 本机图片（CLI 把二维码、截图存成本地文件，回复里写的是路径）：请内核读成 data URL。
 * undefined = 读取中；null = 读不了（不在工作区 / 授权文件夹 / 临时目录，不是图片，或太大）
 */
function useLocalImage(src: string): string | null | undefined {
  const live = !!src && hasTransport();
  const [got, setGot] = useState<{ src: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    api.chatAssets
      .localImage({ src })
      .then((r) => alive && setGot({ src, url: r?.dataUrl ?? null }))
      .catch(() => alive && setGot({ src, url: null }));
    return () => {
      alive = false;
    };
  }, [src, live]);
  if (!live) return null;
  return got?.src === src ? got.url : undefined;
}

export const MarkdownImage: React.FC<{ src: string; alt?: string }> = memo(({ src, alt }) => {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  // 白名单过了再换址（Go 宿主里 chat-asset:// 走资产网关）
  const local = isLocalImagePath(src);
  const localUrl = useLocalImage(local ? src : '');
  const safe = local ? (localUrl ?? '') : hostAssetUrl(sanitizeImgSrc(src));
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  if (local && localUrl === undefined) return null; // 内核还在读
  if (local && !safe) {
    return (
      <span className={styles.failed} title={src}>
        [{t('ui.usage-tools.local-image-unavailable')}：{src}]
      </span>
    );
  }
  if (!safe) {
    return <span className={styles.unsafe}>[{t('ui.usage-tools.unsupported-image-link')}]</span>;
  }
  if (failed) {
    return <span className={styles.failed}>[{t('ui.usage-tools.image-failed-to-load')}]</span>;
  }
  return (
    <>
      <button
        type="button"
        className={styles.imgBtn}
        onClick={() => setOpen(true)}
        aria-label={t('ui.usage-tools.view-full-image')}
        data-testid="md-img"
      >
        <img
          src={safe}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className={styles.img}
        />
      </button>
      {assetFileOf(src) ? (
        // 生成的图片（素材库里的）：用查看器，带提示词 / 模型 / 重新生成 / 以此修改 / 作为参考 / 下载
        <AssetViewer url={src} open={open} onClose={() => setOpen(false)} />
      ) : (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          size="lg"
          bodyClassName={styles.previewBody}
          data-testid="md-img-preview"
        >
          <img src={safe} alt={alt ?? ''} referrerPolicy="no-referrer" className={styles.preview} />
        </Modal>
      )}
    </>
  );
});
MarkdownImage.displayName = 'MarkdownImage';

/** 对话里点开一张生成的图片：查看器（按文件名从素材库补齐信息；重新生成后换成新图） */
const AssetViewer: React.FC<{ url: string; open: boolean; onClose: () => void }> = ({
  url,
  open,
  onClose,
}) => {
  const loaded = useAssetItem(url, open);
  const [shown, setShown] = useState<typeof loaded>(null);
  const { fillComposer } = useChangesUi();
  const item = shown ?? loaded;
  if (!open || !item) return null;
  return (
    <ImageViewer
      item={item}
      onClose={() => {
        setShown(null);
        onClose();
      }}
      onChange={(next) => setShown(next)}
      onCompose={(text) => {
        setShown(null);
        onClose();
        fillComposer(text);
      }}
    />
  );
};
