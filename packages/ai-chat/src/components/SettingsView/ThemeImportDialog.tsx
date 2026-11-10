/**
 * 导入主题包：弹窗里拖入文件，或点一下用系统选择框选；可以下载模板照着改。
 * 取消选择不算失败（什么也不显示）；只有文件本身不对才在弹窗里提示。
 */
import { Button, Icon, Modal, ModalHostContext, t as tr, type CustomThemeDef } from '@nomi-ai/ui';
import { FileDown, Upload } from 'lucide-react';
import React, { useState } from 'react';

import {
  THEME_DROP_MAX_BYTES,
  downloadThemeTemplate,
  importThemePack,
  importThemePackFile,
  themeErrorText,
} from '../../services/customThemes';

import styles from './ThemeImportDialog.module.css';

export interface ThemeImportDialogProps {
  onClose: () => void;
  onImported: (def: CustomThemeDef) => void;
}

type Status = { text: string; error: boolean } | null;

export const ThemeImportDialog: React.FC<ThemeImportDialogProps> = ({ onClose, onImported }) => {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const run = async (task: () => Promise<CustomThemeDef | null>) => {
    setBusy(true);
    setStatus(null);
    try {
      const def = await task();
      if (def) onImported(def);
    } catch (e) {
      setStatus({
        text: tr('ui.chat-settings.theme-import-failed', themeErrorText(e)),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const pick = () => {
    if (!busy) void run(importThemePack);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || busy) return;
    if (file.size > THEME_DROP_MAX_BYTES) {
      setStatus({
        text: tr('ui.chat-settings.theme-drop-too-large', String(THEME_DROP_MAX_BYTES >> 20)),
        error: true,
      });
      return;
    }
    void run(() => importThemePackFile(file));
  };

  const template = () =>
    void downloadThemeTemplate().then(
      (path) => {
        if (path)
          setStatus({ text: tr('ui.chat-settings.theme-template-saved', path), error: false });
      },
      (e: unknown) => setStatus({ text: themeErrorText(e), error: true }),
    );

  // 设置页里的 Modal 默认内嵌；这里要真正的弹窗
  return (
    <ModalHostContext.Provider value={null}>
      <Modal
        open
        onClose={onClose}
        title={tr('ui.chat-settings.import-theme-pack')}
        data-testid="theme-import-dialog"
        footer={
          <>
            <Button
              variant="ghost"
              className={styles.template}
              onClick={template}
              data-testid="theme-template"
            >
              <Icon icon={FileDown} size={14} />
              {tr('ui.chat-settings.theme-download-template')}
            </Button>
            <Button onClick={onClose}>{tr('ui.foundation.cancel')}</Button>
          </>
        }
      >
        <div
          role="button"
          tabIndex={0}
          aria-disabled={busy || undefined}
          aria-label={tr('ui.chat-settings.theme-drop-title')}
          className={`${styles.drop} ${dragging ? styles.dragging : ''}`}
          onClick={pick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              pick();
            }
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
          data-testid="theme-drop"
        >
          <Icon icon={Upload} size={24} className={styles.dropIcon} />
          <span className={styles.dropTitle}>
            {busy
              ? tr('ui.chat-settings.theme-importing')
              : tr('ui.chat-settings.theme-drop-title')}
          </span>
          <span className={styles.dropHint}>{tr('ui.chat-settings.theme-drop-hint')}</span>
        </div>
        {status && (
          <p
            className={status.error ? styles.error : styles.info}
            role={status.error ? 'alert' : 'status'}
            data-testid="theme-import-status"
          >
            {status.text}
          </p>
        )}
      </Modal>
    </ModalHostContext.Provider>
  );
};
