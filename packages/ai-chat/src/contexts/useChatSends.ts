/**
 * 发送一轮对话（普通 / 流式 / `/agent` 委派）：从 AiChatContext 拆出。
 * 会话在发起时固定（openTurn），准备期间切走也只写回发起它的会话。
 */
import { t } from '@nomi-ai/ui';
import { useCallback, type Dispatch, type MutableRefObject } from 'react';

import { api, hasTransport } from '../services/api';
import { importChatImages } from '../services/chatImages';
import { injectedMemoryIds, isCompaction } from '../services/compaction';
import {
  bindNextDelegateConversation,
  clearTurnPin,
  consumeNextDelegate,
  DELEGATE_GOAL_MAX,
  delegateClient,
  formatRunnerSummary,
  getNextDelegateMeta,
  isPresetPin,
  presetDisplayLabel,
  type DelegateCli,
} from '../services/delegateClient';
import { extClient } from '../services/extClient';
import {
  harnessClient,
  MAIN_TAB_ID,
  type HarnessTraceEvent,
  type HarnessUsage,
} from '../services/harnessClient';
import { imageLinksNote, STEER_TAG } from '../services/history';
import { kbClient } from '../services/kbClient';
import { createManagedMessageId } from '../services/managedMainChat';
import { memoryContext } from '../services/memClient';
import { gatewayStateSnapshot } from '../services/nomiModel';
import { nomiModelLabel, servedModelLabel } from '../services/nomiModel';
import { maybeStartManagedSmartTitle, maybeStartNomiSmartTitle } from '../services/nomiSmartTitle';
import { startReplySpeech, stopReplySpeech, type ReplySpeaker } from '../services/replySpeech';
import { schedClient } from '../services/schedClient';
import { screenClient, type ImageAttachment } from '../services/screenClient';
import { tasksApi } from '../services/tasksClient';
import type { ChatMessage } from '../types/chat';
import type { IPCClient } from '../types/ipc';
import { ENDPOINT_NAME } from '../utils/endpointBadge';
import { closeOpenCalls } from '../utils/toolTrace';

import {
  convoKey,
  errorMessage,
  type AiChatAction,
  type AiChatState,
  type ConvoOutcome,
} from './aiChatState';
import type { ActiveStream, ConversationTurn, InflightTurn } from './chatTurn';
import {
  finishDeliveredSteers,
  newReqId,
  openTurn,
  persistDeliveredSteer,
  userMessageSaver,
} from './chatTurn';
import { compactHistory } from './compactHistory';
import { attachSteer, finishSteer, type DeliveredSteer, type SteerLedger } from './nomiSteer';

let lastMessageId = 0;
function nextMessageId(): string {
  const now = Date.now();
  lastMessageId = now <= lastMessageId && lastMessageId - now < 60_000 ? lastMessageId + 1 : now;
  return String(lastMessageId);
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';

/** 转后台时随任务交给后台的原图上限（与契约 tasks.handoffFromChat.images 一致） */
const MAX_HANDOFF_IMAGES = 8;
/** 后台执行器认的原图类型（与服务端校验一致） */
const HANDOFF_IMAGE_MIMES = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

interface SendsOptions {
  stateRef: MutableRefObject<AiChatState>;
  dispatch: Dispatch<AiChatAction>;
  activeStream: MutableRefObject<Map<string, ActiveStream>>;
  inflight: MutableRefObject<Map<string, InflightTurn>>;
  maybeIngest: (msgs: ChatMessage[], convoId?: string) => void;
  /** 当前会话这一轮的工具开始订阅（见 contexts/nomiSteer） */
  notifyToolStart: (key: string) => void;
  /** 这一轮里交给模型的用户插入（按对话键；见 contexts/nomiSteer.DeliveredSteer） */
  steering: MutableRefObject<SteerLedger>;
}

interface ManagedSendParams {
  client: IPCClient;
  turn: ConversationTurn & { convoId: string };
  reqId: string;
  content: string;
  images?: ImageAttachment[];
  encodedImages?: string[];
  baseMessagesOverride?: ChatMessage[];
  stateRef: MutableRefObject<AiChatState>;
  dispatch: Dispatch<AiChatAction>;
  inflight: MutableRefObject<Map<string, InflightTurn>>;
  signal?: AbortSignal;
}

/**
 * 托管主对话发送共享入口：仅在内存中乐观上屏（绝不写入旧视图存储或触发 ADD_MESSAGE），
 * 使用客户端预生成的幂等 messageId 登记 inflight 并在收到权威投影后整体替换；
 * 若在首帧权威投影前失败，则从权威存储对齐回滚未落盘的乐观消息。
 */
async function runManagedSend({
  client,
  turn,
  reqId,
  content,
  images,
  encodedImages,
  baseMessagesOverride,
  stateRef,
  dispatch,
  inflight,
  signal,
}: ManagedSendParams): Promise<void> {
  if (typeof client.sendManagedConversation !== 'function')
    throw new Error(t('ui.chat-settings.managed-ingress'));

  const messageId = createManagedMessageId();
  const turnKey = convoKey(turn.convoId);
  const optimisticImages = images
    ?.filter((i) => typeof i.thumb === 'string' && i.thumb.length > 0)
    .map((i) => ({
      thumb: i.thumb,
      width: i.width,
      height: i.height,
      ...(i.source ? { source: i.source } : {}),
    }));
  const optimisticUser: ChatMessage = {
    id: messageId,
    role: 'user',
    content,
    timestamp: Date.now(),
    ...(optimisticImages?.length ? { images: optimisticImages } : {}),
  };
  const cachedMessages = client.conversationStore?.()?.getMessages?.(turn.convoId);
  const baseMessages: ChatMessage[] =
    baseMessagesOverride !== undefined
      ? baseMessagesOverride
      : turn.isActive()
        ? stateRef.current.messages
        : Array.isArray(cachedMessages)
          ? cachedMessages
          : [];

  inflight.current.set(turnKey, {
    reqId,
    convoId: turn.convoId,
    messages: [optimisticUser],
  });
  if (turn.isActive()) {
    dispatch({
      type: 'SET_MESSAGES',
      payload: [...baseMessages, optimisticUser],
      convoId: turn.convoId,
    });
  }
  void maybeStartManagedSmartTitle(client, turn.convoId, content);

  let authoritativeReceived = false;
  const onUpdate = (messages: ChatMessage[]): void => {
    authoritativeReceived = true;
    if (inflight.current.get(turnKey)?.reqId === reqId) {
      const liveTail = messages.filter((m) => m.id === messageId || m.id.startsWith('draft_'));
      if (liveTail.length) {
        inflight.current.set(turnKey, { reqId, convoId: turn.convoId, messages: liveTail });
      } else {
        inflight.current.delete(turnKey);
      }
    }
    if (turn.isActive()) {
      dispatch({ type: 'SET_MESSAGES', payload: messages, convoId: turn.convoId });
    }
  };

  try {
    await client.sendManagedConversation(turn.convoId, content, onUpdate, signal, {
      messageId,
      ...(encodedImages?.length ? { images: encodedImages } : {}),
    });
  } catch (err) {
    if (inflight.current.get(turnKey)?.reqId === reqId) {
      inflight.current.delete(turnKey);
    }
    if (!authoritativeReceived && turn.isActive()) {
      let reconciled: ChatMessage[] = baseMessages;
      if (typeof client.getChatHistory === 'function') {
        try {
          reconciled = await client.getChatHistory();
        } catch {
          reconciled = baseMessages;
        }
      }
      if (turn.isActive()) {
        dispatch({ type: 'SET_MESSAGES', payload: reconciled, convoId: turn.convoId });
      }
    }
    throw err;
  } finally {
    if (inflight.current.get(turnKey)?.reqId === reqId) {
      inflight.current.delete(turnKey);
    }
  }
}

/** 普通发送与知识库问答：一次性返回整段回复 */
function usePlainSends({ stateRef, dispatch, inflight, maybeIngest }: SendsOptions) {
  // 发送普通消息
  const sendMessage = useCallback(
    async (content: string) => {
      const s = stateRef.current;
      const turn = openTurn(s.ipcClient);
      let outcome: ConvoOutcome = 'done';
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });
        if (turn.convoId && s.ipcClient.isManagedConversation?.(turn.convoId)) {
          await runManagedSend({
            client: s.ipcClient,
            turn: { ...turn, convoId: turn.convoId },
            reqId: newReqId(),
            content,
            stateRef,
            dispatch,
            inflight,
          });
          return;
        }

        const userMessage: ChatMessage = {
          id: nextMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          modelId: nomiModelLabel(),
        };
        // 本轮之前的会话消息作为多轮上下文（state.messages 尚未包含本轮 userMessage）
        const history = s.messages;
        dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
        // 用户消息先落盘（不等这一轮结束）：中途重启也不丢
        const user = userMessageSaver(turn, userMessage);
        await user.early();
        schedClient.activity();

        // CLI 后端：全部转发，禁用 Nomi 工具 / 记忆注入
        if (harnessClient.available()) {
          const hs = await harnessClient.state();
          if (hs.backend !== 'nomi') {
            const r = await harnessClient.send(content);
            const aiMessage: ChatMessage = {
              id: nextMessageId(),
              role: 'assistant',
              content: r.text,
              timestamp: Date.now(),
              // eslint-disable-next-line nomi/no-cli-literal -- 旧对话里 Claude Code 的模型 id 记作 claude-code（兼容）
              modelId: hs.backend === 'claude' ? 'claude-code' : hs.backend,
            };
            if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
            await user.final();
            await turn.save(aiMessage);
            return;
          }
        }

        // 标题与回复并行：不等请求回来（名字仍是默认名时才会真的请求模型）
        maybeStartNomiSmartTitle(s.ipcClient, turn.convoId, userMessage.content);
        const mem = await memoryContext(content, injectedMemoryIds(history));
        if (mem.text.trim()) userMessage.memory = { text: mem.text, ids: mem.ids };
        await user.early();
        const response = await s.ipcClient.sendMessage(
          content,
          history,
          undefined,
          mem.text,
          turn.convoId ? { id: turn.convoId } : undefined,
        );

        const aiMessage: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: response,
          timestamp: Date.now(),
          modelId: nomiModelLabel(),
          ...(mem.used.length ? { memories: mem.used } : {}),
        };
        if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });

        await user.final();
        await turn.save(aiMessage);
        if (turn.exists()) maybeIngest([...history, userMessage, aiMessage], turn.convoId);
      } catch (error) {
        outcome = isAbortError(error) ? 'stopped' : 'error';
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId, outcome });
      }
    },
    [stateRef, dispatch, inflight, maybeIngest],
  );

  // 知识库问答：主进程检索本地索引 → 模型带引用回答
  const askKnowledge = useCallback(
    async (content: string, override?: { history: ChatMessage[] }) => {
      const s = stateRef.current;
      const turn = openTurn(s.ipcClient);
      let outcome: ConvoOutcome = 'done';
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });
        if (turn.convoId && s.ipcClient.isManagedConversation?.(turn.convoId))
          throw new Error(t('ui.chat-settings.managed-unsupported'));
        const userMessage: ChatMessage = {
          id: nextMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          kb: true,
        };
        const history = (override?.history ?? s.messages)
          .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant'))
          .slice(-6)
          .map((m) => ({ role: m.role, content: m.content }));
        dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
        // 用户消息先落盘（不等这一轮结束）：中途重启也不丢
        const user = userMessageSaver(turn, userMessage);
        await user.early();
        // 标题与检索并行（名字仍是默认名时才会真的请求模型）
        maybeStartNomiSmartTitle(s.ipcClient, turn.convoId, userMessage.content);
        const r = await kbClient.ask(content, history);
        const aiMessage: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: r.answer,
          timestamp: Date.now(),
          modelId: nomiModelLabel(),
          sources: r.sources,
          kb: true,
        };
        if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
        await user.final();
        await turn.save(aiMessage);
      } catch (error) {
        outcome = isAbortError(error) ? 'stopped' : 'error';
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId, outcome });
      }
    },
    [stateRef, dispatch],
  );

  return { sendMessage, askKnowledge };
}

/** 流式发送：`/agent` 委派、CLI 后端直连、Nomi 流式三条路径 */
function useStreamSend({
  stateRef,
  dispatch,
  activeStream,
  inflight,
  maybeIngest,
  notifyToolStart,
  steering,
}: SendsOptions) {
  // 发送流式消息
  const sendStreamMessage = useCallback(
    async (
      content: string,
      images?: ImageAttachment[],
      override?: { history: ChatMessage[]; backgroundFollowUp?: boolean },
    ) => {
      const bgFollow = override?.backgroundFollowUp === true;
      const s = stateRef.current;
      const client = s.ipcClient;
      // 发起时固定会话：之后无论用户切到哪个会话，这一轮都写回这里
      const turn = openTurn(client);
      const reqId = newReqId();
      const controller = new AbortController();
      let owned = false;
      let outcome: ConvoOutcome = 'done';
      // 用户发了新消息：正在朗读的上一条回复立即停
      if (!bgFollow) stopReplySpeech();
      const managed = !!(turn.convoId && client.isManagedConversation?.(turn.convoId));
      let speaker: ReplySpeaker | null = null;
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });
        if (turn.convoId && managed) {
          if (override) throw new Error(t('ui.chat-settings.managed-unsupported'));
          if (!client.sendManagedConversation)
            throw new Error(t('ui.chat-settings.managed-ingress'));
          let encodedImages: string[] | undefined;
          if (images?.length) {
            if (!hasTransport()) throw new Error(t('ui.chat-settings.managed-unsupported'));
            const runtime = await api.conversations.runtimeState({ id: turn.convoId });
            if (!runtime.capabilities.attachments) {
              throw new Error(
                t('ui.chat-settings.managed-attachments-unsupported', runtime.backend || 'runtime'),
              );
            }
            encodedImages = images.map((img) => `data:${img.mime};base64,${img.data}`);
          }
          activeStream.current.set(convoKey(turn.convoId), {
            reqId,
            convoId: turn.convoId,
            controller,
          });
          owned = true;
          dispatch({ type: 'SET_STREAMING', payload: true, convoId: turn.convoId });
          await runManagedSend({
            client,
            turn: { ...turn, convoId: turn.convoId },
            reqId,
            content,
            images,
            encodedImages,
            stateRef,
            dispatch,
            inflight,
            signal: controller.signal,
          });
          return;
        }

        // 图片要离开本机前：云端模型首次告知 / 仅本地模式拦截
        if (images?.length && screenClient.available()) {
          const r = await screenClient.checkSend();
          if (r === 'local_only')
            throw new Error(t('ui.chat-settings.local-models-only-is-on-and-the-current'));
          if (r === 'user_denied')
            throw new Error(t('ui.chat-settings.cancelled-the-image-wasn-t-sent-to-the'));
        }

        // `/agent`：按会话 chip → 按 turnId 钉到主进程；钉住失败则中止发送（后台自动跟进不消费用户的 pin）
        let delegateTo: Awaited<ReturnType<typeof consumeNextDelegate>> = null;
        if (!bgFollow) {
          bindNextDelegateConversation(turn.convoId);
          try {
            delegateTo = await consumeNextDelegate(reqId);
          } catch (pinErr) {
            const msg =
              pinErr instanceof Error
                ? pinErr.message
                : t('ui.slash-commands.couldn-t-pin-the-coding-assistant-the-message');
            throw Object.assign(new Error(msg), { cause: pinErr });
          }
        }
        // 原图存进素材库：消息里记下地址（放大看原图、复制、以此修改 / 作为参考），这一轮也把地址告诉模型
        const imageUrls = images?.length ? await importChatImages(images, turn.convoId) : [];
        const userMessage: ChatMessage = {
          id: nextMessageId(),
          role: 'user',
          content,
          timestamp: Date.now(),
          modelId: nomiModelLabel(),
          ...(images?.length
            ? {
                images: images.map((i, k) => ({
                  thumb: i.thumb,
                  width: i.width,
                  height: i.height,
                  source: i.source,
                  ...(imageUrls[k] ? { url: imageUrls[k] } : {}),
                })),
              }
            : {}),
        };
        // 先上屏：后面的后端探测、压缩摘要、记忆召回都要等，不能让输入框把刚发的话吞进去
        // （压缩期间用户只看到摘要卡跑几十秒，自己那句话一直不出现）。后台自动恢复跟进不造假用户气泡。
        if (!bgFollow && turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
        // 用户消息发出就先落盘（不等这一轮结束）：回复期间应用重启（如更新）时它还在对话里，重开后可重试。
        // 之后内容有变（记忆、委派对象）或中间存了压缩摘要时按 id 再存一次（放回摘要之后），没变不重复写。
        const user = userMessageSaver(turn, userMessage);
        const saveUser = (stage: 'early' | 'final', force = false): Promise<void> =>
          bgFollow ? Promise.resolve() : stage === 'early' ? user.early(force) : user.final();
        if (!bgFollow) {
          inflight.current.set(convoKey(turn.convoId), {
            reqId,
            convoId: turn.convoId,
            messages: [userMessage],
          });
          await saveUser('early');
        }
        // `/agent`：直接派出 agent。不交给对话模型——模型不调工具时会像已经交出，其实什么都没开始。
        if (delegateTo) {
          maybeStartNomiSmartTitle(s.ipcClient, turn.convoId, userMessage.content);
          // 等确认时可以停止：停止键中止这次调用，内核里的确认随之取消
          activeStream.current.set(convoKey(turn.convoId), {
            reqId,
            convoId: turn.convoId,
            controller,
          });
          owned = true;
          dispatch({ type: 'SET_STREAMING', payload: true, convoId: turn.convoId });
          // 附图的地址作为背景交给 agent（它读不到对话里的缩略图）
          const linked = imageUrls.filter(Boolean);
          try {
            if (content.length > DELEGATE_GOAL_MAX)
              throw new Error(
                t('ui.slash-commands.handoff-request-too-long', String(DELEGATE_GOAL_MAX)),
              );
            let dispatchCli: DelegateCli;
            let dispatchPresetId: string | undefined;
            let targetLabel: string;
            if (isPresetPin(delegateTo)) {
              dispatchPresetId = delegateTo.slice('preset:'.length);
              const meta = getNextDelegateMeta(delegateTo, turn.convoId);
              if (meta) {
                dispatchCli = meta.cli;
                targetLabel = meta.label;
              } else {
                const s = await delegateClient.settings();
                const p = s.presets?.find((x) => x.id === dispatchPresetId);
                dispatchCli = (p?.cli ?? s.installed[0] ?? 'claude') as DelegateCli;
                targetLabel = p
                  ? `${formatRunnerSummary(p, gatewayStateSnapshot())} (${presetDisplayLabel(p)})`
                  : dispatchPresetId;
              }
            } else {
              dispatchCli = delegateTo;
              targetLabel = t(ENDPOINT_NAME[delegateTo]);
            }
            await delegateClient.dispatch(
              {
                cli: dispatchCli,
                ...(dispatchPresetId ? { presetId: dispatchPresetId } : {}),
                goal: content,
                ...(linked.length ? { context: imageLinksNote(linked).slice(0, 8000) } : {}),
                ...(turn.convoId ? { conversationId: turn.convoId } : {}),
                ...(turn.projectId ? { projectId: turn.projectId } : {}),
                turnId: reqId,
              },
              controller.signal,
            );
            userMessage.delegateTo = dispatchCli;
            const ack: ChatMessage = {
              id: nextMessageId(),
              role: 'assistant',
              content: t('ui.slash-commands.handed-off-started', targetLabel, content),
              timestamp: Date.now(),
            };
            if (turn.isActive()) dispatch({ type: 'UPSERT_MESSAGES', payload: [userMessage, ack] });
            await saveUser('final');
            await turn.save(ack);
          } catch (err) {
            const stoppedDelegate = controller.signal.aborted || isAbortError(err);
            outcome = stoppedDelegate ? 'stopped' : 'error';
            const failed: ChatMessage = {
              id: nextMessageId(),
              role: 'assistant',
              content: '',
              error: t(
                'ui.slash-commands.handoff-not-dispatched',
                stoppedDelegate ? t('ui.chat-settings.stopped') : errorMessage(err),
              ),
              timestamp: Date.now(),
            };
            if (turn.isActive())
              dispatch({ type: 'UPSERT_MESSAGES', payload: [userMessage, failed] });
            await saveUser('final');
            await turn.save(failed);
          }
          return;
        }
        let history = override?.history ?? s.messages;
        const hs = harnessClient.available() ? await harnessClient.state() : null;
        // Nomi 对话：这一轮的上下文快到模型输入预算的 95% 时，先把较早的对话压缩成摘要。
        // 摘要要跑一次模型（几十秒），所以用户消息已经先上屏了，摘要卡插到它上方。
        if (!hs || hs.backend === 'nomi') {
          const c = await compactHistory(
            client,
            history,
            content,
            turn,
            false,
            dispatch,
            undefined,
            userMessage.id,
          );
          if (c.next) {
            history = c.next;
            // 摘要存在了先存的用户消息后面：按 id 再存一次，让它回到摘要之后（下一轮的上下文从摘要往后取）
            await saveUser('early', true);
          }
        }
        // 万一起手时不在这个会话（或已被切回），补一次：按 id upsert，不会重复
        if (!bgFollow && turn.isActive())
          dispatch({ type: 'UPSERT_MESSAGES', payload: [userMessage] });
        inflight.current.set(convoKey(turn.convoId), {
          reqId,
          convoId: turn.convoId,
          messages: bgFollow ? [] : [userMessage],
        });
        schedClient.activity();

        if (hs) {
          if (hs.backend !== 'nomi') {
            if (bgFollow) return;
            // 主对话标签切到 agent：和普通标签同一条路径（能不能附图由主进程按模型能力判断）
            const r = images?.length
              ? await harnessClient.sendTab(
                  MAIN_TAB_ID,
                  content,
                  images.map((i, k) => ({
                    mime: i.mime,
                    data: i.data,
                    width: i.width,
                    height: i.height,
                    thumb: i.thumb,
                    source: i.source,
                    ...(imageUrls[k] ? { url: imageUrls[k] } : {}),
                  })),
                )
              : await harnessClient.send(content);
            const done: ChatMessage = {
              id: nextMessageId(),
              role: 'assistant',
              content: r.text,
              timestamp: Date.now(),
              // eslint-disable-next-line nomi/no-cli-literal -- 旧对话里 Claude Code 的模型 id 记作 claude-code（兼容）
              modelId: hs.backend === 'claude' ? 'claude-code' : hs.backend,
              ...(r.trace?.length ? { trace: r.trace } : {}),
              ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
              ...(r.usage ? { usage: r.usage } : {}),
            };
            if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: done });
            await saveUser('final');
            await turn.save(done);
            return;
          }
        }

        // 标题不等这一轮结束：用户消息已确定，和回复并行生成（长任务不再一直显示「新对话」）
        if (!bgFollow) maybeStartNomiSmartTitle(client, turn.convoId, userMessage.content);

        // 新召回的记忆跟着本轮用户消息走（存进消息、之后每轮原样带），已在上下文里的不再召回；
        // 技能目录每轮不变，留在 system
        const [mem, skills] = await Promise.all([
          memoryContext(content, injectedMemoryIds(history)),
          extClient.context(),
        ]);
        if (!bgFollow && mem.text.trim()) userMessage.memory = { text: mem.text, ids: mem.ids };
        // 准备期间（压缩 / 记忆召回等）发起会话被删了：不发送（没有地方落盘，也不能借用当前会话）
        if (!turn.exists()) {
          outcome = 'stopped';
          return;
        }
        // 带上了召回的记忆：开始回复前更新先存的那份（中途重启后重试，记忆也还在）
        await saveUser('early');
        const aiMessageId = nextMessageId();
        const aiMessage: ChatMessage = {
          id: aiMessageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          modelId: nomiModelLabel(),
          ...(bgFollow ? { origin: 'background' as const } : {}),
          ...(mem.used.length ? { memories: mem.used } : {}),
        };
        const pair = (ai: ChatMessage): ChatMessage[] => (bgFollow ? [ai] : [userMessage, ai]);
        // 用户消息一并 upsert：准备期间切走又切回时，用户消息还没上屏（顺序保持「问在前、答在后」）
        if (turn.isActive()) dispatch({ type: 'UPSERT_MESSAGES', payload: pair(aiMessage) });
        inflight.current.set(convoKey(turn.convoId), {
          reqId,
          convoId: turn.convoId,
          messages: pair(aiMessage),
        });

        let accumulated = '';
        let thinking: boolean | undefined;
        const startedAt = Date.now();
        const trace: HarnessTraceEvent[] = [];
        let usage: HarnessUsage | undefined;
        let steps: string | undefined;

        const streamEntry: ActiveStream = {
          reqId,
          convoId: turn.convoId,
          projectId: turn.projectId,
          userGoal: userMessage.content,
          controller,
          getHandoffSnapshot: () => ({
            partialContent: accumulated,
            progressSummary: trace
              .filter((x) => x.type === 'tool')
              .slice(-15)
              .map((x) => `${x.name ?? 'tool'}(${x.status ?? 'start'})`)
              .join(' -> '),
            historyContext: history
              .filter((m) => !isCompaction(m) && !m.hidden && m.content.trim())
              .slice(-4)
              .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
              .join('\n'),
            // 用户这一轮附图的原图：后台接管时原样交给它（它读不到对话里的缩略图 / 素材库里的本地地址）
            images: (images ?? [])
              .slice(0, MAX_HANDOFF_IMAGES)
              .filter(
                (i): i is ImageAttachment & { data: string } =>
                  typeof i.data === 'string' &&
                  i.data.length > 0 &&
                  !!i.mime &&
                  HANDOFF_IMAGE_MIMES.has(i.mime),
              )
              .map((i) => ({ mime: i.mime, data: i.data })),
          }),
        };
        activeStream.current.set(convoKey(turn.convoId), streamEntry);
        owned = true;
        // 朗读 AI 回复：只念普通 Nomi 对话（`/agent` 委派或后台自动跟进不念）
        if (!delegateTo && !bgFollow) speaker = startReplySpeech(reqId);
        dispatch({ type: 'SET_STREAMING', payload: true, convoId: turn.convoId });
        // 流式 UI 更新按帧合批：一帧内到达的文本 / 工具事件只 dispatch 一次（逐 chunk dispatch 会让整条消息列表重渲染）
        let raf = 0;
        let timer = 0;
        let traceSnap: HarnessTraceEvent[] | undefined;
        const traceNow = () => {
          if (!trace.length) return undefined;
          if (traceSnap?.length !== trace.length) traceSnap = [...trace];
          return traceSnap;
        };
        /** 这一轮的对话键 / 交给模型的插入（按它记） */
        const turnKey = convoKey(turn.convoId);
        const steerList = () => steering.current.get(turnKey);
        const markSteerTraced = (text: string) => {
          for (const x of steerList() ?? [])
            if (x.text === text || x.text.split('\n\n').some((p) => p.trim() === text.trim()))
              x.traced = true;
        };
        /** 回复的正文 / 轨迹里已经有这一轮的插入了：补进记录的那几条不再需要 */
        const noteSteersSent = (list: readonly DeliveredSteer[] = steerList() ?? []) => {
          for (const x of list) {
            if (x.traced) continue;
            const want = x.text.trim();
            if (
              trace.some(
                (e) =>
                  e.type === 'interject' &&
                  (e.text === x.text || e.text.split('\n\n').some((p) => p.trim() === want)),
              )
            ) {
              x.traced = true;
            }
          }
        };
        /**
         * 结局时补进回复正文的「你加入了」分节：已经有分节的（重启后再交付时接进了回复的开头）续写在后面；
         * 没有的在开头加一节。文字里已经有的不重复加。
         */
        const fullSteerText = (text: string, done: readonly DeliveredSteer[]): string => {
          noteSteersSent(done);
          const missing = done
            .filter((x) => !x.traced && !text.includes(`\n\n${STEER_TAG}\n\n${x.text}`))
            .map((x) => x.text);
          if (!missing.length) return text;
          const part = `${STEER_TAG}\n\n${missing.join('\n\n')}`;
          return text.includes(`\n\n${STEER_TAG}\n\n`)
            ? `${text}\n\n${missing.join('\n\n')}`
            : `${part}${text ? `\n\n${text}` : ''}`;
        };
        const flushUi = () => {
          if (raf) cancelAnimationFrame(raf);
          if (timer) window.clearTimeout(timer);
          raf = 0;
          timer = 0;
          const payload = pair({
            ...aiMessage,
            content: accumulated,
            ...(thinking !== undefined ? { thinking } : {}),
            ...(trace.length ? { trace: traceNow() } : {}),
          });
          const f = inflight.current.get(convoKey(turn.convoId));
          if (f?.reqId === reqId) f.messages = payload;
          // 用户已切到别的会话：只累积，不动当前界面；回到本会话时由 loadChatHistory 补回整轮消息
          if (!turn.isActive()) return;
          dispatch({ type: 'UPSERT_MESSAGES', payload });
        };
        const scheduleUi = () => {
          if (raf || timer) return;
          raf = requestAnimationFrame(flushUi);
          timer = window.setTimeout(flushUi, 100);
        };
        const stream = activeStream.current.get(convoKey(turn.convoId));
        if (stream?.reqId === reqId)
          attachSteer(stream, {
            trace,
            textLength: () => accumulated.length,
            deliver: (id, text) => stateRef.current.ipcClient.steerStream?.(id, text),
            onChange: () => {
              // 刚交给内核的插入记进元信息（中途重启后补成用户消息）。进行中的这一轮它们已经在
              // 回复轨迹的 interject 里，不再往消息列表插一份，免得和轨迹重复显示。
              const list = steerList() ?? [];
              if (list.length) void persistDeliveredSteer(turn, reqId, list, userMessage.id);
              scheduleUi();
            },
            ledger: steering.current,
            convoKey: turnKey,
            reqId,
          });
        const finishAsHandoff = async (): Promise<boolean> => {
          if (!streamEntry.handoffPromise) return false;
          const handoffId = await streamEntry.handoffPromise.catch(() => null);
          if (!handoffId) return false;
          speaker?.stop();
          const doneSteers = finishSteer(steering.current, turnKey);
          const handoffMsg: ChatMessage = {
            ...aiMessage,
            ...(usage?.model ? { modelId: servedModelLabel(usage.model) } : {}),
            ...(usage?.responseModel ? { responseModel: usage.responseModel } : {}),
            content: fullSteerText(accumulated, doneSteers),
            handoffTaskId: handoffId,
            durationMs: Date.now() - startedAt,
            ...(trace.length ? { trace: [...trace] } : {}),
            ...(usage ? { usage } : {}),
          };
          if (turn.isActive()) dispatch({ type: 'UPSERT_MESSAGES', payload: pair(handoffMsg) });
          if (!bgFollow) {
            maybeStartNomiSmartTitle(client, turn.convoId, userMessage.content);
            await saveUser('final');
          }
          await turn.save(handoffMsg);
          await finishDeliveredSteers(turn);
          return true;
        };
        try {
          const linked = imageUrls.filter(Boolean);
          const sent = linked.length ? `${content}\n\n${imageLinksNote(linked)}` : content;
          await client.sendStreamMessage(
            sent,
            (chunk: string) => {
              // 重启后再交付时内核把「你加入了」分节带在回复开头（记录里补的那条算进了它）：
              // 分节留在这条回复里（有序），不在正文里重复一遍
              if (!accumulated && chunk.startsWith(`${STEER_TAG}\n\n`))
                accumulated = `${STEER_TAG}\n\n`;
              else accumulated += chunk;
              if (speaker) {
                // 已切到别的会话：不再朗读这一轮
                if (turn.isActive()) speaker.push(chunk);
                else speaker.stop();
              }
              scheduleUi();
            },
            history,
            skills,
            images?.map((i) => ({ mime: i.mime, data: i.data })),
            {
              reqId,
              memory: mem.text,
              onSteps: (s) => {
                steps = s;
              },
              signal: controller.signal,
              conversation: { id: turn.convoId, projectId: turn.projectId },
              onThinking: (active) => {
                thinking = active;
                scheduleUi();
              },
              onTrace: (ev) => {
                // 插入的消息到了回复的轨迹：补进对话记录的那条记成「已进回复」（结局时按 id 删掉）
                if (ev.type === 'interject') markSteerTraced(ev.text);
                trace.push(ev.textAt === undefined ? { ...ev, textAt: accumulated.length } : ev);
                scheduleUi();
                if (ev.type === 'tool' && ev.status === 'start')
                  notifyToolStart(convoKey(turn.convoId));
              },
              onUsage: (u) => {
                usage = { ...usage, ...u };
              },
            },
          );
        } catch (err) {
          flushUi();
          // 还在跑的工具调用不会再有结果：标成已停止，否则时间线一直转圈
          trace.push(...closeOpenCalls(trace, Date.now(), t('ui.chat-settings.stopped')));
          if (await finishAsHandoff()) {
            outcome = 'stopped';
            return;
          }
          outcome = controller.signal.aborted || isAbortError(err) ? 'stopped' : 'error';
          // 这一轮失败：保留已生成的部分与轨迹，作为「错误卡片」留在对话里（可重试），不进模型上下文
          // 插入的消息已经进了这条（轨迹里 / 正文开头「你加入了」分节）：补进记录的那几条不再需要
          const done = finishSteer(steering.current, turnKey);
          const failed: ChatMessage = {
            ...aiMessage,
            content: fullSteerText(accumulated, done),
            error: errorMessage(err),
            durationMs: Date.now() - startedAt,
            ...(usage?.responseModel ? { responseModel: usage.responseModel } : {}),
            ...(trace.length ? { trace: [...trace] } : {}),
            ...(steps ? { steps } : {}),
          };
          if (turn.isActive()) dispatch({ type: 'UPSERT_MESSAGES', payload: pair(failed) });
          if (!bgFollow) {
            maybeStartNomiSmartTitle(client, turn.convoId, userMessage.content);
            await saveUser('final');
          }
          await turn.save(failed);
          await finishDeliveredSteers(turn);
          // 错误已经显示在这一轮的卡片里（含详情 / 重试 / 复制）：不再抛给外层，避免底部再弹一条同样的提示（#78）
          return;
        }
        flushUi();
        // 停止时还在跑的工具调用（内核已随这一轮中止它们）：标成已停止，否则时间线一直显示运行中
        trace.push(...closeOpenCalls(trace, Date.now(), t('ui.chat-settings.stopped')));
        if (await finishAsHandoff()) {
          outcome = 'stopped';
          return;
        }
        const stopped = controller.signal.aborted;
        if (stopped) {
          outcome = 'stopped';
          speaker?.stop();
        } else speaker?.finish();
        // 中途插入的消息已经进了这条回复（轨迹里的 interject / 正文开头的「你加入了」分节）：
        // 补进对话记录的那几条按 id 删掉（正常结束时只留轨迹里的一份，不重复显示、不重复进上下文）
        const doneSteers = finishSteer(steering.current, turnKey);
        const finalAiMessage: ChatMessage = {
          ...aiMessage,
          // 故障转移后实际回答的可能是另一家：按网关报回的写
          ...(usage?.model ? { modelId: servedModelLabel(usage.model) } : {}),
          ...(usage?.responseModel ? { responseModel: usage.responseModel } : {}),
          content: fullSteerText(accumulated, doneSteers),
          durationMs: Date.now() - startedAt,
          ...(trace.length ? { trace: [...trace] } : {}),
          ...(usage ? { usage } : {}),
          ...(steps && !stopped ? { steps } : {}),
          ...(stopped ? { stopped: true } : {}),
        };
        if (turn.isActive()) {
          dispatch({ type: 'UPSERT_MESSAGES', payload: pair(finalAiMessage) });
        }
        if (!bgFollow) {
          maybeStartNomiSmartTitle(client, turn.convoId, userMessage.content);
          await saveUser('final');
        }
        await turn.save(finalAiMessage);
        await finishDeliveredSteers(turn);
        if (!stopped && turn.exists())
          maybeIngest(
            [
              ...history.filter((m) => !isCompaction(m)),
              ...(bgFollow ? [finalAiMessage] : [userMessage, finalAiMessage]),
            ],
            turn.convoId,
          );
      } catch (error) {
        outcome = controller.signal.aborted || isAbortError(error) ? 'stopped' : 'error';
        speaker?.stop();
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        // 本轮未委派时清掉主进程 turn pin，避免泄漏到下一轮
        if (!managed) void clearTurnPin(reqId);
        if (controller.signal.aborted && outcome === 'done') outcome = 'stopped';
        const key = convoKey(turn.convoId);
        if (owned && activeStream.current.get(key)?.reqId === reqId)
          activeStream.current.delete(key);
        if (inflight.current.get(key)?.reqId === reqId) inflight.current.delete(key);
        dispatch({ type: 'SET_STREAMING', payload: false, convoId: turn.convoId });
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId, outcome });
      }
    },
    [stateRef, dispatch, activeStream, inflight, maybeIngest, notifyToolStart, steering],
  );

  /**
   * 前台长程对话主动转后台：把用户这一轮的原图、已生成的部分与进度交给后台任务（tasks.handoffFromChat）。
   * 只有后台**真的接管了**（拿到 task.id）才中止前台这一轮；存储失败 / 图片不可用 / 这一轮已结束等
   * 情况前台照常继续已输出的内容，这里只给出明确提示（返回 null，界面据此不停流）。
   * 同一轮（reqId）重复点击只接管一次：成功复用同一个任务 id，失败复用同一次失败结果，不再重发。
   */
  const handoffCurrentToBackground = useCallback(async (): Promise<string | null> => {
    const s = stateRef.current;
    if (s.ipcClient.isManagedConversation?.(s.ipcClient.currentConversationId?.() ?? ''))
      return null;
    const key = convoKey(s.ipcClient.currentConversationId?.());
    const stream = activeStream.current.get(key);
    // 没有进行中的这一轮（已结束 / 期间切了会话）：没有可接管的内容，也不停任何东西
    if (!stream || stream.controller.signal.aborted) return null;
    if (!stream.handoffPromise) {
      const run = async (): Promise<string | null> => {
        const snap = stream.getHandoffSnapshot?.();
        try {
          const task = await tasksApi.handoffFromChat({
            reqId: stream.reqId,
            conversationId: stream.convoId ?? 'default',
            ...(stream.projectId ? { projectId: stream.projectId } : {}),
            userGoal: stream.userGoal ?? '',
            ...(snap?.partialContent ? { partialContent: snap.partialContent } : {}),
            ...(snap?.progressSummary ? { progressSummary: snap.progressSummary } : {}),
            ...(snap?.historyContext ? { historyContext: snap.historyContext } : {}),
            ...(snap?.images?.length ? { images: snap.images } : {}),
          });
          const taskId = typeof task?.id === 'string' && task.id ? task.id : null;
          if (!taskId) throw new Error(t('ui.providers-schedule.task-handoff-failed-to-take-over'));
          // 接管成功：才中止前台这一轮（内核建好任务后已自己中止上游；这里让本地循环立即退出）。
          // 只有 task.id 不算数——抛错 / 没返回 id 的都走下面的失败分支，前台照常继续
          stream.controller.abort();
          return taskId;
        } catch (err) {
          // 没接管成：前台流保留已输出的内容，只提示失败原因
          if (!stream.controller.signal.aborted)
            dispatch({
              type: 'SET_ERROR',
              payload: t(
                'ui.providers-schedule.task-handoff-failed-kept-foreground',
                errorMessage(err),
              ),
            });
          return null;
        }
      };
      stream.handoffPromise = run();
    }
    return stream.handoffPromise;
  }, [stateRef, activeStream, dispatch]);

  const sendAsBackgroundTask = useCallback(
    async (text: string): Promise<string | null> => {
      const trimmed = text.trim();
      if (!trimmed) return null;
      const s = stateRef.current;
      const turn = openTurn(s.ipcClient);
      if (turn.convoId && s.ipcClient.isManagedConversation?.(turn.convoId)) {
        dispatch({ type: 'SET_ERROR', payload: t('ui.chat-settings.managed-unsupported') });
        return null;
      }
      const userMessage: ChatMessage = {
        id: nextMessageId(),
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        modelId: nomiModelLabel(),
      };
      dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
      const userSaver = userMessageSaver(turn, userMessage);
      await userSaver.early();
      schedClient.activity();
      try {
        const task = await tasksApi.handoffFromChat({
          conversationId: turn.convoId ?? 'default',
          ...(turn.projectId ? { projectId: turn.projectId } : {}),
          userGoal: trimmed,
        });
        await userSaver.final();
        maybeStartNomiSmartTitle(s.ipcClient, turn.convoId, trimmed);
        const aiMessage: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: t('ui.providers-schedule.task-handoff-initial-reply'),
          timestamp: Date.now(),
          modelId: nomiModelLabel(),
          handoffTaskId: task.id,
        };
        if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
        await turn.save(aiMessage);
        return task.id;
      } catch (e) {
        await userSaver.final();
        const errMsg: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: '',
          error: errorMessage(e),
          timestamp: Date.now(),
        };
        if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: errMsg });
        await turn.save(errMsg);
        return null;
      }
    },
    [stateRef, dispatch],
  );

  const resendManagedMessage = useCallback(
    async (userMessageId: string, content: string) => {
      const s = stateRef.current;
      const client = s.ipcClient;
      const turn = openTurn(client);
      if (!turn.convoId || !client.isManagedConversation?.(turn.convoId)) return;
      const reqId = newReqId();
      const controller = new AbortController();
      let owned = false;
      let outcome: ConvoOutcome = 'done';
      stopReplySpeech();
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });
        if (
          typeof client.rewindManagedConversation !== 'function' ||
          typeof client.sendManagedConversation !== 'function'
        ) {
          throw new Error(t('ui.chat-settings.managed-ingress'));
        }
        activeStream.current.set(convoKey(turn.convoId), {
          reqId,
          convoId: turn.convoId,
          controller,
        });
        owned = true;
        dispatch({ type: 'SET_STREAMING', payload: true, convoId: turn.convoId });
        const rewound = await client.rewindManagedConversation(turn.convoId, userMessageId);
        if (turn.isActive()) {
          dispatch({ type: 'SET_MESSAGES', payload: rewound, convoId: turn.convoId });
        }
        if (controller.signal.aborted) {
          outcome = 'stopped';
          return;
        }
        await runManagedSend({
          client,
          turn: { ...turn, convoId: turn.convoId },
          reqId,
          content,
          baseMessagesOverride: rewound,
          stateRef,
          dispatch,
          inflight,
          signal: controller.signal,
        });
      } catch (error) {
        outcome = controller.signal.aborted || isAbortError(error) ? 'stopped' : 'error';
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        if (controller.signal.aborted && outcome === 'done') outcome = 'stopped';
        const key = convoKey(turn.convoId);
        if (owned && activeStream.current.get(key)?.reqId === reqId)
          activeStream.current.delete(key);
        if (inflight.current.get(key)?.reqId === reqId) inflight.current.delete(key);
        dispatch({ type: 'SET_STREAMING', payload: false, convoId: turn.convoId });
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId, outcome });
      }
    },
    [stateRef, dispatch, activeStream, inflight],
  );

  return {
    sendStreamMessage,
    resendManagedMessage,
    handoffCurrentToBackground,
    sendAsBackgroundTask,
  };
}

/** 发送相关的全部动作 */
export function useChatSends(options: SendsOptions) {
  const { sendMessage, askKnowledge } = usePlainSends(options);
  const {
    sendStreamMessage,
    resendManagedMessage,
    handoffCurrentToBackground,
    sendAsBackgroundTask,
  } = useStreamSend(options);
  return {
    sendMessage,
    askKnowledge,
    sendStreamMessage,
    resendManagedMessage,
    handoffCurrentToBackground,
    sendAsBackgroundTask,
  };
}
