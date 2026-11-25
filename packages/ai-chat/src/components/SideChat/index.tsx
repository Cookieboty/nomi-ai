/**
 * 侧边聊天面板：标签区里的一个标签（和子任务同一套：状态点、悬停卡片、拖动排序、拆分、铺满、弹出窗口）。
 * 只问 Nomi（只读、不委派 agent），内容不保存。对话区和输入栏用主对话同一套组件：
 * ConversationView（工具步骤、重新生成、编辑重发）+ MessageInput（引用胶囊、图片 / 文件附件、排队、停止），
 * 模型 / 思考深度是主对话同一个选择器（NomiModelSwitch 的 binding，记在这个侧边聊天上）。
 * 数据在 services/sideChat（按聊天 id）。设计见 docs/design/side-tabs-workspace.md。
 */
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import {
  IconMessageCirclePlus as MessageCirclePlus,
  IconSquare as Square,
  IconX as X,
} from '@tabler/icons-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useSubagentPane } from '../../contexts/SubagentPaneContext';
import { currentVision, visionOf } from '../../services/modelCapability';
import { nomiMainRef, splitRef, useGatewayState } from '../../services/nomiModel';
import type { ImageAttachment } from '../../services/screenClient';
import {
  editSideChat,
  flushSideChat,
  imagesOf,
  markSideChatComposer,
  regenerateSideChat,
  removeSideChatQueued,
  sendSideChat,
  setSideChatEffort,
  setSideChatLongContext,
  setSideChatModel,
  sideChatDraftKey,
  sideChatDrafts,
  sideChatName,
  stopSideChat,
  useSideChat,
} from '../../services/sideChat';
import type { ComposerDraftLock } from '../MessageInput/types';
import type { ConvMessage } from '../../types/conversation';
import { ConversationView } from '../Conversation/index';
import type { ConvSlots } from '../Conversation/Messages';
import { UserImages } from '../Conversation/UserImages';
import { MessageInput } from '../MessageInput';
import { NomiModelSwitch } from '../NomiModelSwitch';
import { PaneBrief, type PaneNotes, useInTabStrip } from '../SubagentPane/chrome';
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

/** 这个侧边聊天现在用的模型能不能看图；元数据没写时 undefined（不提示，也不拦着发） */
function useVision(model: string | null): boolean | undefined {
  const state = useGatewayState();
  const ref = model ?? nomiMainRef(state);
  if (!model) return currentVision(state);
  const parts = splitRef(ref ?? '');
  return parts ? visionOf(parts.provider, parts.model, state) : undefined;
}

const toSideChatImages = (images?: readonly ImageAttachment[]) =>
  images?.map((i) => ({
    mime: i.mime,
    data: i.data,
    thumb: i.thumb,
    width: i.width,
    height: i.height,
  }));

/**
 * 侧边聊天「正在放回主窗口」：独立窗口在等主窗口确认收下时传进来（见 DetachedApp 的 dock）。
 * pending 带着这边锁住的草稿（输入栏照常能写，写的是锁里的那份）；failed 只是提示，草稿已经回到桶里。
 */
export type SideChatDockState =
  | { status: 'pending'; lock: ComposerDraftLock }
  | { status: 'failed'; lock?: ComposerDraftLock }
  /** 第几次放回（被主窗口重新打开时换一个数，输入栏解锁到最新的草稿） */
  | { status: 'aborted'; attempt: number };

/**
 * 放回等待期间锁住草稿：输入栏照常能写，但写的是锁里的那份，已经交出去的快照不变。
 * 解锁（放回失败 / 超时 / 被重新打开）时锁里的那份就是最新的草稿，原样写回草稿桶，输入栏接着用它。
 */
function useDockDraftLock(
  draftKey: string,
  dock: SideChatDockState | undefined,
): ComposerDraftLock | undefined {
  const [lock, setLockState] = useState<ComposerDraftLock | null>(null);
  // 换锁 / 解锁都只 setState 一次（句柄本身别变，变了输入栏会按它重新读一遍草稿）
  const setLock = (next: ComposerDraftLock | null) =>
    setLockState((cur) => (cur === next ? cur : next));
  const [abort, setAbort] = useState(0);
  useEffect(() => {
    if (dock?.status === 'aborted') {
      setAbort(dock.attempt);
      return;
    }
    setLock(dock?.status === 'pending' ? dock.lock : null);
    return () => setLockState(null);
  }, [draftKey, dock]);
  // 被主窗口重新打开了（放回实际没有成功，或这边迟到了）：草稿换成最新的那份
  useEffect(() => {
    if (!abort) return;
    setLock(null);
    const latest = sideChatDrafts.read(draftKey);
    sideChatDrafts.write(draftKey, latest);
  }, [abort, draftKey]);
  return lock ?? undefined;
}

export const SideChatPane: React.FC<{
  chatId: string;
  slot: SideChatSlot;
  cwd?: string | null;
  onClose?: () => void;
  dockState?: SideChatDockState;
}> = ({ chatId, slot, cwd, onClose, dockState }) => {
  const chat = useSideChat(chatId);
  // 标签区里名字 / 状态在标签上、关闭在 ×、停止在输入栏：不再画面板头（见 SubagentPane/chrome）
  const inStrip = useInTabStrip();
  const report = useSubagentPane()?.reportMeta;
  const name = sideChatName(chat);
  const running = !!chat?.running;
  useEffect(() => {
    if (name) report?.(slot.tabKey, { name, state: running ? 'running' : 'idle' });
  }, [report, slot.tabKey, name, running]);
  useEffect(() => () => report?.(slot.tabKey, null), [report, slot.tabKey]);
  useEffect(() => markSideChatComposer(chatId), [chatId]);
  const draftKey = sideChatDraftKey(chatId);
  const draftLock = useDockDraftLock(draftKey, dockState);
  const dockPending = dockState?.status === 'pending';
  const dockFailed = dockState?.status === 'failed';
  const vision = useVision(chat?.model ?? null);
  const paneRef = useRef<HTMLElement>(null);
  const binding = useMemo(
    () =>
      chat
        ? {
            model: chat.model,
            effort: chat.effort,
            longContext: chat.longContext,
            onModel: (ref: string) => setSideChatModel(chatId, ref),
            onEffort: (level: string | undefined) => setSideChatEffort(chatId, level),
            onLongContext: (next: { model: string; on: boolean } | undefined) =>
              setSideChatLongContext(chatId, next),
            menuKey: sideChatDraftKey(chatId),
            testPrefix: 'side-chat',
          }
        : null,
    [chat, chatId],
  );
  if (!chat || !binding) return null;
  const empty = !chat.messages.length && !chat.running;
  const notes: PaneNotes = { hint: t('ui.session-workspace.side-chat-only-nomi') };
  return (
    <section
      ref={paneRef}
      className={paneStyles.pane}
      hidden={!slot.active}
      data-testid="side-chat"
      data-side-tab={slot.tabKey}
      data-selection-label={name}
      aria-label={name}
    >
      {!inStrip && (
        <>
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
            {onClose && (
              <IconButton
                size="sm"
                label={t('ui.providers-schedule.close')}
                icon={<Icon icon={X} size={14} />}
                onClick={onClose}
                data-testid="side-chat-close"
              />
            )}
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
          <p className={paneStyles.hint}>{notes.hint}</p>
        </>
      )}
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
      <footer className={paneStyles.composer} data-in-strip={inStrip || undefined}>
        {inStrip && <PaneBrief {...notes} />}
        {(dockPending || dockFailed) && (
          <p
            className={styles.dockNote}
            data-state={dockState?.status}
            role="status"
            data-testid="side-chat-dock-note"
          >
            {dockFailed
              ? t('ui.session-workspace.side-tab-dock-failed')
              : t('ui.session-workspace.side-tab-docking')}
          </p>
        )}
        <MessageInput
          // 放回等待期间不发送（但输入框照常能打字）：发送会清掉草稿，结果可能是主窗口手里没有、这里也空了
          onBeforeSend={() => !dockPending}
          onSend={(text, images) => void sendSideChat(chatId, text, toSideChatImages(images))}
          busyOverride={running}
          imageCapability={vision === false ? 'none' : 'full'}
          placeholder={t('ui.session-workspace.side-chat-placeholder')}
          queue={{
            onQueue: (text, opts) =>
              void sendSideChat(chatId, text, toSideChatImages(opts?.images)),
            onStop: () => stopSideChat(chatId),
            pending: chat.queued.length,
            onFlush: () => flushSideChat(chatId),
          }}
          fill={chat.fill}
          cwd={cwd}
          dropZoneRef={paneRef}
          draftStore={sideChatDrafts}
          draftKey={draftKey}
          draftLock={draftLock}
          delegate={false}
          modelControl={<NomiModelSwitch binding={binding} />}
        />
      </footer>
    </section>
  );
};
