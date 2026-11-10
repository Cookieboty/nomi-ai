/** 助手 Markdown 中的图片：协议白名单 + 懒加载 + 加载失败兜底 + 点击放大。*/
import { t, useLocale } from '@nomi-ai/ui';
import React, { memo, useEffect, useState } from 'react';

import { useResourceContext, type ResourceImageInfo } from '../../contexts/ResourceContext';
import { api, hasTransport, hostAssetUrl } from '../../services/api';
import { resourceTarget } from '../../utils/resourceLinks';
import { GeneratedImageModal } from '../AssetLibrary/GeneratedImageModal';
import { assetFileOf } from '../AssetLibrary/ImageViewer';
import { ImageLightbox } from '../ImageLightbox/ImageLightbox';

import { ConversationLink } from './ConversationLink';
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

export const MarkdownImage: React.FC<{ src: string; alt?: string; imageInfo?: ResourceImageInfo }> =
  memo(({ src, alt, imageInfo }) => {
    // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
    useLocale();
    // 白名单过了再换址（Go 宿主里 chat-asset:// 走资产网关）
    const resource = useResourceContext();
    const resolved = src;
    const local = isLocalImagePath(resolved);
    const localUrl = useLocalImage(local ? resolved : '');
    const safe = local ? (localUrl ?? '') : hostAssetUrl(sanitizeImgSrc(resolved));
    const [failed, setFailed] = useState(false);
    const [open, setOpen] = useState(false);
    if (local && localUrl === undefined) return null;
    if (!safe && resource && resourceTarget(resolved))
      return <ConversationLink href={resolved}>{alt || src}</ConversationLink>;
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
          onClick={() =>
            resource
              ? resource.open(resolved, resource.scope, {
                  ...(imageInfo ?? { origin: 'assistant' }),
                  kind: 'image',
                })
              : setOpen(true)
          }
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
        {open &&
          ((assetFileOf(resolved) || imageInfo?.origin === 'assistant') &&
          imageInfo?.origin !== 'user' ? (
            <GeneratedImageModal
              entry={{
                key: resolved,
                href: resolved,
                scope: resource?.scope ?? { id: 'image' },
                image: imageInfo ?? { origin: 'assistant' },
              }}
              src={safe}
              originMismatch={false}
              onCloseEntry={() => setOpen(false)}
            />
          ) : (
            <ImageLightbox
              src={safe}
              alt={alt}
              onClose={() => setOpen(false)}
              data-testid="md-img-preview"
            />
          ))}
      </>
    );
  });
MarkdownImage.displayName = 'MarkdownImage';
