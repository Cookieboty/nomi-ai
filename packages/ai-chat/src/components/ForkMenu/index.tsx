/**
 * 跨端分叉：选择目标后端。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useNewWorkspace } from '../../hooks/useNewWorkspace';
import { harnessClient } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';
import { WorkspacePicker } from '../WorkspacePicker';

import styles from './index.module.css';

export const ForkTargetMenu: React.FC<{
  open: boolean;
  current: ConversationBackend;
  /** cwd：用户为 CLI 目标选的工作目录（未选为 undefined） */
  onPick: (b: ConversationBackend, cwd?: string) => void;
  onClose: () => void;
}> = ({ open, current, onPick, onClose }) => {
  const [bins, setBins] = useState<Record<string, string | null>>({});
  const ws = useNewWorkspace();
  useEffect(() => {
    if (!open) return;
    void harnessClient
      .state()
      .then((s) => setBins(s.bins))
      .catch(() => undefined);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.backdrop} data-testid="fork-target-menu" onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t('ui.cli-monitor.fork-to-another-endpoint')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.title}>{t('ui.cli-monitor.fork-to-another-endpoint')}</div>
        <p className={styles.hint}>
          {t('ui.cli-monitor.copies-visible-messages-into-a-new-chat-across')}
        </p>
        <div className={styles.list}>
          {CONVERSATION_BACKENDS.filter((b) => b !== current).map((b) => {
            const missing = b !== 'nomi' && !bins[b];
            return (
              <button
                key={b}
                type="button"
                className={styles.item}
                disabled={missing}
                data-testid={`fork-target-${b}`}
                onClick={() => onPick(b, b === 'nomi' ? undefined : ws.chosen)}
              >
                <EndpointIcon backend={b} size={18} decorative />
                <span>{ENDPOINT_FULL[b]()}</span>
                {missing && (
                  <span className={styles.miss}>{t('ui.mascot-theme.not-installed')}</span>
                )}
              </button>
            );
          })}
        </div>
        <div className={styles.ws}>
          <span className={styles.wsLabel}>
            {t('ui.cli-monitor.workspace-when-the-target-is-a-coding-agent')}
          </span>
          <WorkspacePicker value={ws.cwd} onChange={ws.set} testId="fork-workspace" />
        </div>
        <button type="button" className={styles.cancel} onClick={onClose}>
          {t('ui.foundation.cancel')}
        </button>
      </div>
    </div>
  );
};
