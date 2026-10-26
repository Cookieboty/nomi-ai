/**
 * 对话输入区的「本会话生图模型」pill：临时换模型只影响当前会话，不改设置里的默认；
 * 新会话（还没有 id）先记为待定，首次发送拿到会话 id 后转给该会话。
 */
import type { MediaModelChoice } from '@nomi-ai/gateway/media';
import { Icon, t } from '@nomi-ai/ui';
import { ChevronDown, ImageIcon } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  selectFirstMessageId,
  selectIpcClient,
  selectMessageCount,
  useAiChatSelector,
} from '../../contexts/aiChatStore';
import {
  mediaClient,
  mediaToast,
  modelName,
  openMedia,
  providerName,
  usablePairs,
  useMediaState,
  type MediaState,
  type SessionChoice,
} from '../../services/mediaClient';

import styles from './Media.module.css';

const same = (a: MediaModelChoice | null | undefined, b: MediaModelChoice | null | undefined) =>
  !!a && !!b && a.modelId === b.modelId && a.providerRef === b.providerRef;

export function pillLabel(state: MediaState | null, sc: SessionChoice | null): string {
  if (!sc?.choice) return t('ui.media.session-unconfigured');
  const base = t(
    'ui.media.session-pill',
    modelName(state, sc.choice.modelId),
    providerName(state, sc.choice.providerRef),
  );
  return sc.override ? `${base}${t('ui.media.session-scope')}` : base;
}

export const MediaSessionPill: React.FC = () => {
  const ipc = useAiChatSelector(selectIpcClient);
  const count = useAiChatSelector(selectMessageCount);
  const first = useAiChatSelector(selectFirstMessageId);
  const [state] = useMediaState();
  const [sc, setSc] = useState<SessionChoice | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const prevId = useRef<string | undefined>(undefined);
  const convId = ipc?.currentConversationId?.();

  const refresh = useCallback(() => {
    void mediaClient
      .sessionChoice(convId)
      .then(setSc)
      .catch(() => undefined);
  }, [convId]);

  // 会话切换：新会话首次发送拿到 id 时，把待定的临时选择转给它（只在刚开始的会话上转）
  useEffect(() => {
    if (!mediaClient.available()) return;
    const prev = prevId.current;
    prevId.current = convId;
    if (prev === undefined && convId && sc?.override && count <= 2) {
      const pending = sc.choice;
      void mediaClient
        .setSessionChoice(convId, pending)
        .then(setSc)
        .then(() => mediaClient.setSessionChoice(undefined, null))
        .catch(() => undefined);
      return;
    }
    if (prev === undefined && convId)
      void mediaClient.setSessionChoice(undefined, null).catch(() => undefined);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按会话 id / 首条消息切换
  }, [convId, first]);
  useEffect(
    () => (mediaClient.available() ? mediaClient.onChanged(refresh) : undefined),
    [refresh],
  );
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!mediaClient.available() || !state) return null;
  const pairs = usablePairs(state);
  const def = state.prefs.chatDefaultImage;

  const pick = async (c: MediaModelChoice | null) => {
    setOpen(false);
    try {
      // 选回默认组合 = 清除本会话覆盖
      const next = await mediaClient.setSessionChoice(convId, same(c, def) ? null : c);
      setSc(next);
      if (next.override && next.choice)
        mediaToast(
          t(
            'ui.media.session-switched',
            modelName(state, next.choice.modelId),
            providerName(state, next.choice.providerRef),
          ),
        );
    } catch (e) {
      mediaToast((e as Error).message || t('ui.media.action-failed'));
    }
  };

  return (
    <div className={styles.sessionPill} ref={ref}>
      <button
        type="button"
        className={styles.sessionBtn}
        data-override={sc?.override || undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={pillLabel(state, sc)}
        data-testid="media-session-pill"
      >
        <Icon icon={ImageIcon} size={12} />
        <span>{pillLabel(state, sc)}</span>
        <Icon icon={ChevronDown} size={12} />
      </button>
      {open && (
        <div className={styles.sessionMenu} role="menu" data-testid="media-session-menu">
          {pairs.map((p) => (
            <button
              key={`${p.modelId}@${p.providerRef}`}
              type="button"
              role="menuitemradio"
              aria-checked={same(p, sc?.choice)}
              className={styles.menuItem}
              onClick={() => void pick(p)}
            >
              {modelName(state, p.modelId)} · {providerName(state, p.providerRef)}
            </button>
          ))}
          {pairs.length > 0 && <div className={styles.menuSep} />}
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              openMedia({ target: 'settings' });
            }}
          >
            {t('ui.media.go-settings')}
          </button>
        </div>
      )}
    </div>
  );
};
