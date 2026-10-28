/**
 * 唯一的「新建」菜单：侧栏「新对话」与标签栏「+」共用。
 * 端点（图标 + 名称，未安装置灰）+ 工作目录（CLI 标签的目录 / Nomi 对话的工作区）。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useRef } from 'react';

import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';
import { EndpointIcon } from '../EndpointIcon';
import { WorkspacePicker } from '../WorkspacePicker';

import styles from './index.module.css';

export interface NewChatMenuProps {
  backends: readonly ConversationBackend[];
  /** 已探测到的 CLI 路径；null / 空 = 未安装；缺省键视为未知（可点） */
  bins: Record<string, string | null | undefined>;
  /** 把「未探测」也当作未安装（侧栏用） */
  strictBins?: boolean;
  lastBackend?: ConversationBackend | null;
  workspace: { cwd: string; set: (cwd: string) => void };
  onPick: (b: ConversationBackend) => void;
  testId?: string;
  itemTestId?: (b: ConversationBackend) => string;
  workspaceTestId?: string;
  className?: string;
}

export const NewChatMenu: React.FC<NewChatMenuProps> = ({
  backends,
  bins,
  strictBins,
  lastBackend,
  workspace,
  onPick,
  testId = 'new-chat-menu',
  itemTestId = (b) => `new-chat-${b}`,
  workspaceTestId = 'new-chat-workspace',
  className,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const missing = (b: ConversationBackend) =>
    b !== 'nomi' && (strictBins ? !bins[b] : bins[b] === null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[n]?.focus();
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('ui.cli-monitor.new-conversation')}
      className={`${styles.menu} ${className ?? ''}`}
      data-testid={testId}
      onKeyDown={onKey}
    >
      {backends.map((b) => (
        <button
          key={b}
          type="button"
          role="menuitem"
          className={styles.item}
          disabled={missing(b)}
          data-testid={itemTestId(b)}
          onClick={() => onPick(b)}
        >
          <span className={styles.name}>
            <EndpointIcon backend={b} size={16} decorative />
            {ENDPOINT_NAME[b]}
          </span>
          <span className={styles.hint}>
            {missing(b)
              ? t('ui.mascot-theme.not-installed')
              : b === lastBackend
                ? t('ui.mascot-theme.last-used')
                : ''}
          </span>
        </button>
      ))}
      <div className={styles.ws}>
        <WorkspacePicker
          value={workspace.cwd}
          onChange={workspace.set}
          testId={workspaceTestId}
          label={t('ui.mascot-theme.folder')}
        />
      </div>
    </div>
  );
};
