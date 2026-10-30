/** 助手 Markdown 中的图片：协议白名单 + 懒加载 + 加载失败兜底 + 点击放大。*/
import { Modal, t, useLocale } from '@nomi-ai/ui';
import React, { memo, useState } from 'react';

import { hostAssetUrl } from '../../services/api';

import { sanitizeImgSrc } from './Markdown.helpers';
import styles from './MarkdownImage.module.css';

export const MarkdownImage: React.FC<{ src: string; alt?: string }> = memo(({ src, alt }) => {
  // 语言切换时重渲染：memo 挡住了根组件的更新，这里自己订阅（#140）
  useLocale();
  // 白名单过了再换址（Go 宿主里 chat-asset:// 走资产网关）
  const safe = hostAssetUrl(sanitizeImgSrc(src));
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
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
        title={t('ui.usage-tools.view-full-image')}
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
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        bodyClassName={styles.previewBody}
        data-testid="md-img-preview"
      >
        <img src={safe} alt={alt ?? ''} referrerPolicy="no-referrer" className={styles.preview} />
      </Modal>
    </>
  );
});
MarkdownImage.displayName = 'MarkdownImage';
