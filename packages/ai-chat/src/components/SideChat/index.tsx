/**
 * 侧边聊天面板（对话旁标签区里的「侧边聊天」标签，见 docs/design/side-tabs-workspace.md）：
 * 临时聊天，只问 Nomi（只读、不委派编程助手），内容不保存。数据在 services/sideChat（按会话各一份）。
 */
import { Icon, t, useLocale } from '@nomi-ai/ui';
import { ArrowUp, Loader2, MessageCirclePlus, Quote, Square, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef } from 'react';

import { gatewayClientAvailable } from '../../services/gatewayClient';
import { nomiMainRef, nomiModelChoices, refLabel, useGatewayState } from '../../services/nomiModel';
import {
  removeSideChatQuote,
  sendSideChat,
  setSideChatDraft,
  setSideChatModel,
  stopSideChat,
  useSideChat,
} from '../../services/sideChat';
import { isImeComposing } from '../../utils/keyboard';
import { quoteExcerpt, type SelectionQuote } from '../../utils/selectionQuote';
import { Markdown } from '../Conversation/Markdown';

import styles from './SideChat.module.css';

const QuoteChips: React.FC<{
  quotes: readonly SelectionQuote[];
  onRemove?: (index: number) => void;
}> = ({ quotes, onRemove }) => (
  <div className={styles.quotes}>
    {quotes.map((q, i) => (
      <span
        key={`${i}-${q.source}`}
        className={styles.quote}
        data-testid="side-chat-quote"
        title={q.source ? `${q.source}\n${q.text}` : q.text}
      >
        <Icon icon={Quote} size={12} />
        <span className={styles.quoteText}>{quoteExcerpt(q.text)}</span>
        {onRemove && (
          <button
            type="button"
            aria-label={t('ui.session-workspace.preview-remove-reference', quoteExcerpt(q.text))}
            onClick={() => onRemove(i)}
          >
            <Icon icon={X} size={12} />
          </button>
        )}
      </span>
    ))}
  </div>
);

/** 只列 Nomi 的模型（统一网关里启用的对话模型）；不列编程助手 */
const ModelPicker: React.FC<{ scope: string; value: string | null }> = ({ scope, value }) => {
  const state = useGatewayState();
  const choices = useMemo(() => nomiModelChoices(state), [state]);
  if (!gatewayClientAvailable() || !state || !choices.length) return null;
  const main = nomiMainRef(state);
  return (
    <select
      className={styles.model}
      data-testid="side-chat-model"
      aria-label={t('ui.session-workspace.side-chat-model')}
      value={value ?? ''}
      onChange={(e) => setSideChatModel(scope, e.target.value || null)}
    >
      <option value="">
        {t('ui.session-workspace.side-chat-model-default', main ? refLabel(state, main) : '—')}
      </option>
      {choices.map((c) => (
        <option key={c.ref} value={c.ref}>
          {c.label}
        </option>
      ))}
    </select>
  );
};

export const SideChat: React.FC<{
  scope: string;
  hidden?: boolean;
  projectId?: string | null;
}> = ({ scope, hidden, projectId }) => {
  useLocale();
  const chat = useSideChat(scope);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const quoteCount = chat.quotes.length;
  // 带着引用进来 / 切到这个标签：焦点给输入框
  useEffect(() => {
    if (!hidden) input.current?.focus({ preventScroll: true });
  }, [hidden, quoteCount]);
  const runningText = chat.running?.text;
  const count = chat.messages.length;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, runningText]);
  const send = () => void sendSideChat(scope, { projectId });
  const canSend = !chat.running && (!!chat.draft.trim() || quoteCount > 0);
  const empty = !count && !chat.running;
  return (
    <section
      className={styles.root}
      hidden={hidden}
      data-testid="side-chat"
      aria-label={t('ui.session-workspace.side-chat-title')}
    >
      <div ref={list} className={styles.list} data-testid="side-chat-messages">
        {empty ? (
          <div className={styles.empty}>
            <Icon icon={MessageCirclePlus} size={28} />
            <strong>{t('ui.session-workspace.side-chat-title')}</strong>
            <p>{t('ui.session-workspace.side-chat-empty')}</p>
            <p className={styles.hint}>{t('ui.session-workspace.side-chat-only-nomi')}</p>
          </div>
        ) : (
          <div
            data-selection-scope=""
            data-selection-label={t('ui.session-workspace.side-chat-title')}
          >
            {chat.messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className={styles.user} data-testid="side-chat-user">
                  {m.quotes?.length ? <QuoteChips quotes={m.quotes} /> : null}
                  {m.text && <div className={styles.bubble}>{m.text}</div>}
                </div>
              ) : (
                <div
                  key={m.id}
                  className={styles.assistant}
                  data-testid="side-chat-assistant"
                  data-message-id={m.id}
                >
                  {m.text && <Markdown text={m.text} settled />}
                  {m.error && (
                    <p className={styles.error} role="alert">
                      {t('ui.session-workspace.side-chat-failed', m.error)}
                    </p>
                  )}
                </div>
              ),
            )}
            {chat.running && (
              <div className={styles.assistant} data-testid="side-chat-running">
                {chat.running.text ? (
                  <Markdown text={chat.running.text} streaming />
                ) : (
                  <span className={styles.thinking}>
                    <Icon icon={Loader2} size={14} className={styles.spin} />
                    {chat.running.tool
                      ? t('ui.session-workspace.side-chat-reading', chat.running.tool)
                      : t('ui.session-workspace.agent-card-running')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className={styles.composer} data-testid="side-chat-composer">
        {quoteCount > 0 && (
          <div className={styles.quoteBar}>
            <span className={styles.quoteCount} data-testid="side-chat-quote-count">
              {t('ui.session-workspace.side-chat-quotes', String(quoteCount))}
            </span>
            <QuoteChips quotes={chat.quotes} onRemove={(i) => removeSideChatQuote(scope, i)} />
          </div>
        )}
        <textarea
          ref={input}
          className={styles.input}
          data-testid="side-chat-input"
          rows={2}
          value={chat.draft}
          placeholder={t('ui.session-workspace.side-chat-placeholder')}
          onChange={(e) => setSideChatDraft(scope, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey || isImeComposing(e.nativeEvent)) return;
            e.preventDefault();
            if (canSend) send();
          }}
        />
        <div className={styles.footer}>
          <ModelPicker scope={scope} value={chat.model} />
          {chat.running ? (
            <button
              type="button"
              className={styles.send}
              data-testid="side-chat-stop"
              aria-label={t('ui.foundation.stop')}
              onClick={() => stopSideChat(scope)}
            >
              <Icon icon={Square} size={14} />
            </button>
          ) : (
            <button
              type="button"
              className={styles.send}
              data-testid="side-chat-send"
              aria-label={t('ui.knowledge-local.send')}
              disabled={!canSend}
              onClick={send}
            >
              <Icon icon={ArrowUp} size={16} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
