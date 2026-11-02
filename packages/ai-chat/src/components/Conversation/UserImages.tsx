/**
 * 用户消息里的图片：缩略图可以点开看大图、复制到剪贴板；原图存进了素材库的（url）还能「以此修改 / 作为参考」，
 * 把带图片地址的一句话填进输入框，Nomi 收到后带着这张图调 image_generate。
 * 早期消息只有缩略图（没有 url）：放大看的是缩略图，不能引用。
 */
import { Button, Icon, Modal, t, useLocale } from '@nomi-ai/ui';
import { Copy, ImagePlus, PencilLine } from 'lucide-react';
import React, { useState } from 'react';

import { hostAssetUrl } from '../../services/api';
import type { ChatMessage } from '../../types/chat';
import { copyImage } from '../../utils/copyImage';
import { useChangesUi } from '../SessionWorkspace/ChangesUiContext';

import styles from './UserImages.module.css';

type Img = NonNullable<ChatMessage['images']>[number];

const altOf = (im: Img) =>
  im.source === 'snip' ? t('ui.providers-schedule.screenshot') : t('ui.providers-schedule.image');

export const UserImages: React.FC<{ images: Img[] }> = ({ images }) => {
  useLocale();
  const [open, setOpen] = useState<Img | null>(null);
  const [note, setNote] = useState('');
  const { fillComposer } = useChangesUi();
  const src = open ? (open.url ? hostAssetUrl(open.url) : open.thumb) : '';
  const close = () => {
    setOpen(null);
    setNote('');
  };
  const compose = (key: 'ui.media.compose-edit' | 'ui.media.compose-reference') => {
    if (!open?.url) return;
    const url = open.url;
    close();
    fillComposer(t(key, url));
  };
  return (
    <>
      <div className={styles.row} data-testid="message-images">
        {images.map((im, i) => (
          <button
            key={i}
            type="button"
            className={styles.thumbBtn}
            onClick={() => setOpen(im)}
            aria-label={t('ui.usage-tools.view-full-image')}
            title={`${im.width}×${im.height}`}
            data-testid="message-image"
          >
            <img src={im.thumb} alt={altOf(im)} className={styles.thumb} />
          </button>
        ))}
      </div>
      <Modal
        open={!!open}
        onClose={close}
        size="lg"
        bodyClassName={styles.previewBody}
        data-testid="message-image-preview"
      >
        {open && (
          <>
            <img src={src} alt={altOf(open)} className={styles.preview} />
            <div className={styles.actions}>
              <Button
                variant="secondary"
                onClick={() =>
                  void copyImage(src)
                    .then(() => setNote(t('ui.usage-tools.copied')))
                    .catch((e: unknown) =>
                      setNote(
                        t('ui.media.copy-image-failed', e instanceof Error ? e.message : String(e)),
                      ),
                    )
                }
                data-testid="message-image-copy"
              >
                <Icon icon={Copy} size={14} />
                {t('ui.media.copy-image')}
              </Button>
              {open.url && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => compose('ui.media.compose-edit')}
                    data-testid="message-image-edit"
                  >
                    <Icon icon={PencilLine} size={14} />
                    {t('ui.media.edit-this')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => compose('ui.media.compose-reference')}
                    data-testid="message-image-reference"
                  >
                    <Icon icon={ImagePlus} size={14} />
                    {t('ui.media.use-as-reference')}
                  </Button>
                </>
              )}
              {note && (
                <span className={styles.note} role="status">
                  {note}
                </span>
              )}
            </div>
          </>
        )}
      </Modal>
    </>
  );
};
