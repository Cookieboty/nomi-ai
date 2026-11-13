/**
 * 侧边聊天面板：标签区里的一个标签（和子任务同一套：状态点、悬停卡片、拖动排序、拆分、铺满、弹出窗口）。
 * 只问 Nomi（只读、不委派编程助手），内容不保存。对话区和输入栏用主对话同一套组件：
 * ConversationView（工具步骤、重新生成、编辑重发）+ MessageInput（引用胶囊、图片 / 文件附件、排队、停止），
 * 模型 / 思考深度是主对话同一个选择器（NomiModelSwitch 的 binding，记在这个侧边聊天上）。
 * 数据在 services/sideChat（按聊天 id）。设计见 docs/design/side-tabs-workspace.md。
 */
import { Button, Icon, t } from '@nomi-ai/ui';
import { MessageCirclePlus, Square } from 'lucide-react';
import React, { useEffect, useMemo } from 'react';

import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { nomiMainRef, splitRef, useGatewayState } from '../../services/nomiModel';
import { likelyVision } from '../../services/screenClient';
import {
  editSideChat,
  imagesOf,
  markSideChatComposer,
  regenerateSideChat,
  removeSideChatQueued,
  sendSideChat,
  setSideChatEffort,
  setSideChatModel,
  sideChatDraftKey,
  sideChatDrafts,
  sideChatName,
  stopSideChat,
  useSideChat,
} from '../../services/sideChat';
import type { ConvMessage } from '../../types/conversation';
import { ConversationView } from '../Conversation/index';
import type { ConvSlots } from '../Conversation/Messages';
import { UserImages } from '../Conversation/UserImages';
import { MessageInput } from '../MessageInput';
import { NomiModelSwitch } from '../NomiModelSwitch';
import paneStyles from '../SubagentPane/SubagentPane.module.css';

import styles from './SideChat.module.css';

export interface SideChatSlot {
  tabKey: string;
  active: boolean;
}

const slots: ConvSlots = {
  before: (m: ConvMessage) => {
    const images = m.role === 'user' ? imagesOf(m) : [];
    return images.length ? <UserImages images={images} /> : null;
  },
};

/** 这个侧边聊天现在用的模型能不能看图（模型元数据写明了就以它为准，否则按名字猜） */
function useVision(model: string | null): boolean {
  const state = useGatewayState();
  const ref = model ?? nomiMainRef(state);
  const parts = ref ? splitRef(ref) : null;
  const meta = parts
    ? state?.providers
        .find((p) => p.id === parts.provider)
        ?.models.find((m) => m.id === parts.model)
    : undefined;
  const vision = meta?.effective?.vision ?? meta?.vision;
  return vision ?? likelyVision(parts?.model);
}

export const SideChatPane: React.FC<{
  chatId: string;
  slot: SideChatSlot;
  cwd?: string | null;
}> = ({ chatId, slot, cwd }) => {
  const chat = useSideChat(chatId);
  const report = useSubagentPane()?.reportMeta;
  const name = sideChatName(chat);
  const running = !!chat?.running;
  useEffect(() => {
    if (name) report?.(slot.tabKey, { name, state: running ? 'running' : 'idle' });
  }, [report, slot.tabKey, name, running]);
  useEffect(() => () => report?.(slot.tabKey, null), [report, slot.tabKey]);
  useEffect(() => markSideChatComposer(chatId), [chatId]);
  const vision = useVision(chat?.model ?? null);
  const binding = useMemo(
    () =>
      chat
        ? {
            model: chat.model,
            effort: chat.effort,
            onModel: (ref: string) => setSideChatModel(chatId, ref),
            onEffort: (level: string | undefined) => setSideChatEffort(chatId, level),
            menuKey: sideChatDraftKey(chatId),
            testPrefix: 'side-chat',
          }
        : null,
    [chat, chatId],
  );
  if (!chat || !binding) return null;
  const empty = !chat.messages.length && !chat.running;
  return (
    <section
      className={paneStyles.pane}
      hidden={!slot.active}
      data-testid="side-chat"
      data-side-tab={slot.tabKey}
      data-selection-label={name}
      aria-label={name}
    >
      <header className={paneStyles.head}>
        <Icon icon={MessageCirclePlus} size={14} />
        <span className={paneStyles.title}>{name}</span>
        <span
          className={paneStyles.status}
          data-testid="side-chat-status"
          data-state={running ? 'running' : 'idle'}
        >
          {running ? t('ui.knowledge-local.running') : t('ui.mascot-theme.idle')}
        </span>
        <span className={paneStyles.spacer} />
        {running && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => stopSideChat(chatId)}
            data-testid="side-chat-stop"
          >
            <Icon icon={Square} size={12} />
            {t('ui.foundation.stop')}
          </Button>
        )}
      </header>
      <p className={paneStyles.hint}>{t('ui.session-workspace.side-chat-only-nomi')}</p>
      <div className={paneStyles.conv}>
        {empty ? (
          <div className={styles.empty} data-testid="side-chat-empty" data-selection-scope="">
            <strong>{name}</strong>
            <p>{t('ui.session-workspace.side-chat-empty')}</p>
          </div>
        ) : (
          <ConversationView
            scopeId={`side-chat:${chatId}`}
            messages={chat.messages}
            live={chat.running?.live ?? null}
            phase={running ? 'running' : 'idle'}
            queued={chat.queued}
            onRemoveQueued={(i) => removeSideChatQueued(chatId, i)}
            onRetry={(id) => void regenerateSideChat(chatId, id)}
            onEdit={(id, text) => void editSideChat(chatId, id, text)}
            slots={slots}
          />
        )}
      </div>
      <footer className={paneStyles.composer}>
        <MessageInput
          onSend={(text, images) =>
            void sendSideChat(
              chatId,
              text,
              images?.map((i) => ({
                mime: i.mime,
                data: i.data,
                thumb: i.thumb,
                width: i.width,
                height: i.height,
              })),
            )
          }
          busyOverride={running}
          imageCapability={vision ? 'full' : 'none'}
          placeholder={t('ui.session-workspace.side-chat-placeholder')}
          queue={{
            onQueue: (text) => void sendSideChat(chatId, text),
            onStop: () => stopSideChat(chatId),
          }}
          fill={chat.fill}
          cwd={cwd}
          draftStore={sideChatDrafts}
          draftKey={sideChatDraftKey(chatId)}
          delegate={false}
          modelControl={<NomiModelSwitch binding={binding} />}
        />
      </footer>
    </section>
  );
};
