/**
 * 分叉对话：一个弹窗选全——分叉到哪（同一个端的新会话，或工坊模式下的其他端）、带入几轮上下文、放进哪个项目。
 * 从消息末尾的「分叉」进来时只带到那条回复为止。原会话不受影响。
 */
import { Button, Icon, Modal, Select, t, useLocale } from '@nomi-ai/ui';
import { Check, MessageSquarePlus } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { harnessClient } from '../../services/harnessClient';
import type { ConversationBackend } from '../../types/chat';
import { CONVERSATION_BACKENDS } from '../../types/chat';
import { ENDPOINT_FULL } from '../../utils/endpointBadge';
import { DEFAULT_FORK_TURNS, FORK_TURN_CHOICES } from '../../utils/forkTranscript';
import { EndpointIcon } from '../EndpointIcon';
import { ProjectPicker } from '../ProjectPicker';

import styles from './index.module.css';

export interface ForkPick {
  /** 只带最近几轮（undefined = 全部） */
  turns?: number;
  /** 副本放进哪个项目（undefined = 沿用源会话的） */
  projectId?: string;
}

export const ForkDialog: React.FC<{
  open: boolean;
  /** 源会话的端：第一项「新会话」就在这个端 */
  current: ConversationBackend;
  /** 可以分叉到其他端（工坊模式） */
  allowCross: boolean;
  /** 从某条回复分叉：说明只带到它为止 */
  fromMessage?: boolean;
  /** 源会话的项目（项目选择器的默认值） */
  project?: string;
  onPick: (target: ConversationBackend, pick: ForkPick) => void;
  onClose: () => void;
}> = ({ open, current, allowCross, fromMessage, project, onPick, onClose }) => {
  useLocale();
  const [bins, setBins] = useState<Record<string, string | null>>({});
  const [target, setTarget] = useState<ConversationBackend>(current);
  // 默认带最近 20 轮；空字符串 = 全部
  const [turns, setTurns] = useState(String(DEFAULT_FORK_TURNS));
  const [projectId, setProjectId] = useState<string | undefined>();
  // 每次打开都从源会话的默认值开始
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = open ? `${current}|${project ?? ''}` : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    setTarget(current);
    setTurns(String(DEFAULT_FORK_TURNS));
    setProjectId(undefined);
  }
  useEffect(() => {
    if (!open || !allowCross) return;
    void harnessClient
      .state()
      .then((s) => setBins(s.bins))
      .catch(() => undefined);
  }, [open, allowCross]);

  if (!open) return null;
  const missing = (b: ConversationBackend) => b !== 'nomi' && !bins[b];
  const others = allowCross ? CONVERSATION_BACKENDS.filter((b) => b !== current) : [];
  const confirm = () =>
    onPick(target, {
      turns: turns ? Number(turns) : undefined,
      ...(projectId ? { projectId } : {}),
    });

  const option = (b: ConversationBackend, label: string, icon: React.ReactNode) => {
    const disabled = b !== current && missing(b);
    const checked = target === b;
    return (
      <button
        key={b}
        type="button"
        role="radio"
        aria-checked={checked}
        className={styles.item}
        data-checked={checked || undefined}
        disabled={disabled}
        data-testid={`fork-target-${b}`}
        onClick={() => setTarget(b)}
      >
        {icon}
        <span>{label}</span>
        {disabled ? (
          <span className={styles.miss}>{t('ui.mascot-theme.not-installed')}</span>
        ) : checked ? (
          <span className={styles.check}>
            <Icon icon={Check} size={14} />
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('ui.cli-monitor.fork-dialog-title')}
      data-testid="fork-target-menu"
      footer={
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>
            {t('ui.foundation.cancel')}
          </Button>
          <Button variant="primary" onClick={confirm} data-testid="fork-confirm">
            {t('ui.cli-monitor.fork')}
          </Button>
        </div>
      }
    >
      <p className={styles.hint}>
        {fromMessage
          ? t('ui.cli-monitor.fork-from-here-hint')
          : t('ui.cli-monitor.fork-dialog-hint')}
      </p>
      <div className={styles.label}>{t('ui.cli-monitor.fork-to')}</div>
      <div
        className={styles.list}
        role="radiogroup"
        aria-label={t('ui.cli-monitor.fork-to')}
        data-testid="fork-targets"
      >
        {option(
          current,
          t('ui.cli-monitor.fork-new-session-on', ENDPOINT_FULL[current]()),
          <Icon icon={MessageSquarePlus} size={18} />,
        )}
        {others.length > 0 && <div className={styles.sep} role="separator" />}
        {others.map((b) =>
          option(b, ENDPOINT_FULL[b](), <EndpointIcon backend={b} size={18} decorative />),
        )}
      </div>
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
      <div className={styles.row}>
        <span className={styles.rowLabel}>
          {t('ui.cli-monitor.project-for-the-new-conversation')}
        </span>
        <div className={styles.rowControl}>
          <ProjectPicker
            value={projectId ?? project}
            onChange={setProjectId}
            size="sm"
            testId="fork-project"
          />
        </div>
      </div>
    </Modal>
  );
};
