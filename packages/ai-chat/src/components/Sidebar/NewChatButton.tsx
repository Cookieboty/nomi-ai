import { Icon } from '@nomi-ai/ui';
import React from 'react';

import { CONVERSATION_BACKENDS, type ConversationBackend } from '../../types/chat';
import { NewChatMenu } from '../NewChatMenu';

import { AnchoredPopover } from './AnchoredPopover';
import { SIDEBAR_ICONS } from './icons';
import styles from './index.module.css';

interface NewChatButtonProps {
  label: string;
  onClick: () => void;
  /** 有下拉菜单（开发模式「全部」视图）时才带 aria-haspopup / aria-expanded */
  hasMenu: boolean;
  menuOpen: boolean;
  menuP: { value: boolean | null; closing: boolean };
  menuRef: React.RefObject<HTMLDivElement | null>;
  newBtnRef: React.RefObject<HTMLButtonElement | null>;
  newPopRef: React.RefObject<HTMLDivElement | null>;
  bins: Record<string, string | null>;
  project: React.ComponentProps<typeof NewChatMenu>['project'];
  onPick: (backend: ConversationBackend) => void;
}

/** 顶行左侧的「新对话」按钮与它的后端选择菜单 */
export const NewChatButton: React.FC<NewChatButtonProps> = ({
  label,
  onClick,
  hasMenu,
  menuOpen,
  menuP,
  menuRef,
  newBtnRef,
  newPopRef,
  bins,
  project,
  onPick,
}) => (
  <div className={styles.newWrap} ref={menuRef}>
    <button
      ref={newBtnRef}
      type="button"
      className={styles.newChatBtn}
      onClick={onClick}
      aria-label={label}
      aria-haspopup={hasMenu ? 'menu' : undefined}
      aria-expanded={hasMenu ? menuOpen : undefined}
      data-testid="new-chat"
    >
      <Icon icon={SIDEBAR_ICONS.newChat} size={16} />
      <span className={styles.newChatLabel}>{label}</span>
    </button>
    {menuP.value && (
      <AnchoredPopover anchor={newBtnRef.current} popRef={newPopRef}>
        <NewChatMenu
          closing={menuP.closing}
          className={styles.newMenu}
          backends={CONVERSATION_BACKENDS}
          bins={bins}
          strictBins
          project={project}
          onPick={onPick}
        />
      </AnchoredPopover>
    )}
  </div>
);
