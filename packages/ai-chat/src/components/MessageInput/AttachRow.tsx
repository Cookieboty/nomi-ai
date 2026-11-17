import { t as tr, Icon } from '@nomi-ai/ui';
import { IconX as X } from '@tabler/icons-react';
import React from 'react';

import type { FileAttachment } from '../../services/fileAttachments';
import { visionUnsupportedHint } from '../../services/modelCapability';
import type { ImageAttachment } from '../../services/screenClient';
import { FileChip } from '../FileAttachment';

import styles from './index.module.css';

interface AttachRowProps {
  images: ImageAttachment[];
  files: FileAttachment[];
  imgErr: string;
  visionWarn: boolean;
  imageCapability?: 'full' | 'none';
  imageUnsupportedReason?: string;
  onView: (image: ImageAttachment) => void;
  onRemoveImage: (id: string) => void;
  onRemoveFile: (id: string) => void;
}

/** 输入框上方的附件条：缩略图、文件 chip、读图能力提示 */
export const AttachRow: React.FC<AttachRowProps> = ({
  images,
  files,
  imgErr,
  visionWarn,
  imageCapability,
  imageUnsupportedReason,
  onView,
  onRemoveImage,
  onRemoveFile,
}) => (
  <div className={styles.attachRow} data-testid="attach-row">
    {images.map((i) => (
      <div key={i.id} className={styles.attachItem} title={`${i.width}×${i.height}`}>
        <button
          type="button"
          className={styles.attachOpen}
          aria-label={tr('ui.knowledge-local.view-image')}
          data-testid="attach-open"
          onClick={() => onView(i)}
        >
          <img
            src={i.thumb}
            alt={tr('ui.knowledge-local.attached-image')}
            className={styles.attachThumb}
          />
        </button>
        <button
          type="button"
          className={styles.attachRemove}
          aria-label={tr('ui.knowledge-local.remove-image')}
          onClick={() => onRemoveImage(i.id)}
        >
          <Icon icon={X} size={12} />
        </button>
      </div>
    ))}
    {files.map((f) => (
      <FileChip key={f.id} file={f} onRemove={() => onRemoveFile(f.id)} />
    ))}
    <div className={styles.attachMeta}>
      {imgErr ? (
        <span className={styles.attachErr}>{imgErr}</span>
      ) : visionWarn ? (
        <span className={styles.attachWarn} data-testid="vision-warn">
          {imageCapability === 'none'
            ? (imageUnsupportedReason ??
              tr('ui.session-workspace.the-current-model-doesn-t-support-images-remove'))
            : visionUnsupportedHint()}
        </span>
      ) : images.length ? (
        <span className={styles.attachHint}>
          {tr('ui.knowledge-local.images-are-sent-with-this-message-originals-aren')}
        </span>
      ) : null}
    </div>
  </div>
);
