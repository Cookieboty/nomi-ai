/**
 * 文件附件卡片：图标 + 文件名（悬停看完整路径），点开弹窗预览文本内容；输入框与已发送消息共用。
 */
import { Icon, Modal, t } from '@nomi-ai/ui';
import { File as FileIcon, FileText, X } from 'lucide-react';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import type { FileAttachment } from '../../services/fileAttachments';

import styles from './index.module.css';

const FilePreview: React.FC<{ file: FileAttachment; onClose: () => void }> = ({ file, onClose }) =>
  // 挂到 body：消息气泡的 backdrop-filter 会让 fixed 定位的弹层错位
  createPortal(
    <Modal open onClose={onClose} title={file.name} size="lg" data-testid="file-preview">
      <div className={styles.previewBody}>
        {file.path && <div className={styles.previewPath}>{file.path}</div>}
        {file.text !== undefined ? (
          <pre className={styles.previewText}>{file.text}</pre>
        ) : (
          <div className={styles.previewNote}>
            {t('ui.knowledge-local.file-sent-as-path-no-preview')}
          </div>
        )}
      </div>
    </Modal>,
    document.body,
  );

export const FileChip: React.FC<{ file: FileAttachment; onRemove?: () => void }> = ({
  file,
  onRemove,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.chip} data-testid="file-chip">
      <button
        type="button"
        className={styles.chipOpen}
        title={file.path || file.name}
        aria-label={t('ui.knowledge-local.view-file', file.name)}
        onClick={() => setOpen(true)}
      >
        <Icon icon={file.text !== undefined ? FileText : FileIcon} size={14} />
        <span className={styles.chipName}>{file.name}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className={styles.chipRemove}
          aria-label={t('ui.knowledge-local.remove-file', file.name)}
          onClick={onRemove}
        >
          <Icon icon={X} size={12} />
        </button>
      )}
      {open && <FilePreview file={file} onClose={() => setOpen(false)} />}
    </div>
  );
};

export const FileChipRow: React.FC<{ files: FileAttachment[]; className?: string }> = ({
  files,
  className,
}) => (
  <div className={`${styles.row} ${className ?? ''}`} data-testid="message-files">
    {files.map((f) => (
      <FileChip key={f.id} file={f} />
    ))}
  </div>
);
