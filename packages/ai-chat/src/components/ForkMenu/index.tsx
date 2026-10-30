/**
 * 分叉对话：选带入几轮上下文；跨端分叉（mode=cross）再选目标后端与工作目录。
 */
import { Button, Select, t } from '@nomi-ai/ui';
import React, { useEffect, useState } from 'react';

import { useNewWorkspace } from '../../hooks/useNewWorkspace';
import { harnessClient } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { DEFAULT_FORK_TURNS, FORK_TURN_CHOICES } from '../../utils/forkTranscript';
import { EndpointIcon } from '../EndpointIcon';
import { WorkspacePicker } from '../WorkspacePicker';

import styles from './index.module.css';

export interface ForkPick {
  /** 用户为 CLI 目标选的工作目录（未选 / 同端分叉为 undefined） */
  cwd?: string;
  /** 只带最近几轮（undefined = 全部） */
  turns?: number;
}

export const ForkTargetMenu: React.FC<{
  open: boolean;
  /** same：分叉为同端新对话（只选轮数）；cross：分叉到其他端 */
  mode?: 'same' | 'cross';
  current: ConversationBackend;
  onPick: (b: ConversationBackend, pick: ForkPick) => void;
  onClose: () => void;
}> = ({ open, mode = 'cross', current, onPick, onClose }) => {
  const [bins, setBins] = useState<Record<string, string | null>>({});
  // 默认带最近 20 轮；空字符串 = 全部
  const [turns, setTurns] = useState(String(DEFAULT_FORK_TURNS));
  const ws = useNewWorkspace();
  const cross = mode === 'cross';
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
  const pickedTurns = turns ? Number(turns) : undefined;
  const title = cross
    ? t('ui.cli-monitor.fork-to-another-endpoint')
    : t('ui.cli-monitor.fork-as-new-chat');

  return (
    <div className={styles.backdrop} data-testid="fork-target-menu" onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.title}>{title}</div>
        <p className={styles.hint}>
          {cross
            ? t('ui.cli-monitor.copies-visible-messages-into-a-new-chat-across')
            : t('ui.cli-monitor.copies-the-chosen-turns-into-a-new-chat')}
        </p>
        <div className={styles.row}>
          <label className={styles.rowLabel} htmlFor="fork-turns">
            {t('ui.cli-monitor.context-to-carry')}
          </label>
          <div className={styles.rowControl}>
            <Select
              id="fork-turns"
              size="sm"
              value={turns}
              onChange={(e) => setTurns(e.target.value)}
              data-testid="fork-turns"
              options={[
                { value: '', label: t('ui.cli-monitor.all-turns') },
                ...FORK_TURN_CHOICES.map((n) => ({
                  value: String(n),
                  label: t('ui.cli-monitor.last-n-turns', String(n)),
                })),
              ]}
            />
          </div>
        </div>
        {cross && (
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
                  onClick={() =>
                    onPick(b, {
                      ...(ws.chosen ? { cwd: ws.chosen } : {}),
                      turns: pickedTurns,
                    })
                  }
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
        )}
        {cross && (
          <div className={styles.ws}>
            <span className={styles.wsLabel}>
              {t('ui.cli-monitor.workspace-for-the-new-conversation')}
            </span>
            <WorkspacePicker value={ws.cwd} onChange={ws.set} testId="fork-workspace" />
          </div>
        )}
        <div className={styles.actions}>
          <Button size="sm" onClick={onClose}>
            {t('ui.foundation.cancel')}
          </Button>
          {!cross && (
            <Button
              variant="primary"
              size="sm"
              data-testid="fork-confirm"
              onClick={() => onPick(current, { turns: pickedTurns })}
            >
              {t('ui.cli-monitor.fork')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
