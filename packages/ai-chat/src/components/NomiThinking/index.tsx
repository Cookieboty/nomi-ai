/**
 * Nomi 对话的思考深度。和编程助手（Claude / Codex / Grok）用同一根分档滑杆：
 * 输入栏上一个小按钮显示当前档，点开是滑杆。模型不支持时不渲染。
 * 没选过时落在该模型档位列表的第二档，并随这一轮请求发给上游。
 */
import { t } from '@nomi-ai/ui';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { selectIpcClient, useAiChatSelector } from '../../contexts/aiChatStore';
import {
  CONVERSATIONS_CHANGED_EVENT,
  notifyConversationsChanged,
  type ConversationStore,
} from '../../services/conversationStore';
import { nomiMainRef, useGatewayState } from '../../services/nomiModel';
import {
  resolveThinkingLevel,
  thinkingProfileOf,
  type ThinkingProfile,
} from '../../services/thinkingDepth';
import type { IPCClient } from '../../types/ipc';
import { thinkingLevelLabel } from '../ModelControls/effortLabel';
import { EffortSlider } from '../ModelControls/EffortSlider';
import menuStyles from '../ModelControls/index.module.css';

import styles from './index.module.css';

function useStoredEffort(): {
  stored: string | undefined;
  save: (level: string | undefined) => void;
} {
  const ipc = useAiChatSelector(selectIpcClient) as IPCClient | undefined;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, bump);
  }, []);
  void tick;
  const store = ipc?.conversationStore?.() as ConversationStore | undefined;
  const id = ipc?.currentConversationId?.();
  const meta = id && store?.get(id)?.backend === 'nomi' ? store.get(id) : undefined;
  const save = (level: string | undefined) => {
    if (!store) return;
    const target = id && store.get(id)?.backend === 'nomi' ? id : ipc?.ensureConversationId?.();
    if (!target) return;
    store.updateMeta(target, { reasoningEffort: level });
    notifyConversationsChanged();
  };
  return { stored: meta?.reasoningEffort, save };
}

export const NomiThinking: React.FC = () => {
  const state = useGatewayState();
  const profile = thinkingProfileOf(state, nomiMainRef(state));
  const { stored, save } = useStoredEffort();
  const value = resolveThinkingLevel(stored, profile);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  if (!profile || !value) return null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.effort}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('ui.chat-settings.reasoning-effort')}
        data-testid="nomi-thinking"
        onClick={() => setOpen((v) => !v)}
      >
        {thinkingLevelLabel(value)}
      </button>
      {open && (
        <EffortMenu
          btnRef={btnRef}
          menuRef={menuRef}
          profile={profile}
          shown={preview ?? value}
          stored={stored}
          onClose={() => {
            setPreview(null);
            setOpen(false);
            btnRef.current?.focus();
          }}
          onPreview={setPreview}
          onCommit={(level) => {
            setPreview(null);
            if (level !== value) save(level);
          }}
          onReset={() => {
            setPreview(null);
            if (stored) save(undefined);
          }}
        />
      )}
    </>
  );
};

const MENU_WIDTH = 280;

const EffortMenu: React.FC<{
  btnRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  profile: ThinkingProfile;
  shown: string;
  stored: string | undefined;
  onClose: () => void;
  onPreview: (level: string | null) => void;
  onCommit: (level: string) => void;
  onReset: () => void;
}> = ({ btnRef, menuRef, profile, shown, stored, onClose, onPreview, onCommit, onReset }) => {
  const [pos, setPos] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)),
      bottom: window.innerHeight - r.top + 6,
      width: MENU_WIDTH,
    });
  }, [btnRef]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        onClose();
        return;
      }
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menuRef, btnRef, onClose]);
  return createPortal(
    <div
      ref={menuRef}
      className={menuStyles.menu}
      style={pos}
      role="dialog"
      aria-label={t('ui.chat-settings.reasoning-effort')}
      data-testid="nomi-thinking-menu"
    >
      <div className={menuStyles.effortView}>
        <div className={menuStyles.effortHead}>
          <span className={menuStyles.effortHeadLabel}>
            {t('ui.chat-settings.reasoning-effort')}
          </span>
          {stored ? (
            <button
              type="button"
              className={menuStyles.link}
              data-testid="nomi-thinking-reset"
              onClick={onReset}
            >
              {t('ui.providers-schedule.restore-defaults')}
            </button>
          ) : null}
        </div>
        <EffortSlider
          levels={profile.levels}
          value={shown}
          onPreview={onPreview}
          onCommit={onCommit}
        />
      </div>
    </div>,
    document.body,
  );
};
