/**
 * 发送一轮对话（普通 / 流式 / `/agent` 委派）：从 AiChatContext 拆出。
 * 会话在发起时固定（openTurn），准备期间切走也只写回发起它的会话。
 */
import { t } from '@nomi-ai/ui';
import { useCallback, type Dispatch, type MutableRefObject } from 'react';

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
import { memoryContext } from '../services/memClient';
import { gatewayStateSnapshot } from '../services/nomiModel';
import { nomiModelLabel, servedModelLabel } from '../services/nomiModel';
import { maybeStartNomiSmartTitle } from '../services/nomiSmartTitle';
import { startReplySpeech, stopReplySpeech, type ReplySpeaker } from '../services/replySpeech';
import { schedClient } from '../services/schedClient';
import { screenClient, type ImageAttachment } from '../services/screenClient';
import type { ChatMessage } from '../types/chat';
import { ENDPOINT_NAME } from '../utils/endpointBadge';
import { closeOpenCalls } from '../utils/toolTrace';

import { convoKey, errorMessage, type AiChatAction, type AiChatState } from './aiChatState';
import type { ActiveStream, InflightTurn } from './chatTurn';
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

/** 普通发送与知识库问答：一次性返回整段回复 */
function usePlainSends({ stateRef, dispatch, maybeIngest }: SendsOptions) {
  // 发送普通消息
  const sendMessage = useCallback(
    async (content: string) => {
      const s = stateRef.current;
      const turn = openTurn(s.ipcClient);
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });

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
        const response = await s.ipcClient.sendMessage(content, history, undefined, mem.text);

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
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId });
      }
    },
    [stateRef, dispatch, maybeIngest],
  );

  // 知识库问答：主进程检索本地索引 → 模型带引用回答
  const askKnowledge = useCallback(
    async (content: string, override?: { history: ChatMessage[] }) => {
      const s = stateRef.current;
      const turn = openTurn(s.ipcClient);
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });
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
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId });
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
      // 用户发了新消息：正在朗读的上一条回复立即停
      if (!bgFollow) stopReplySpeech();
      let speaker: ReplySpeaker | null = null;
      try {
        dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
        dispatch({ type: 'SET_ERROR', payload: undefined });

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
            const failed: ChatMessage = {
              id: nextMessageId(),
              role: 'assistant',
              content: '',
              error: t(
                'ui.slash-commands.handoff-not-dispatched',
                controller.signal.aborted ? t('ui.chat-settings.stopped') : errorMessage(err),
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
        if (!turn.exists()) return;
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

        activeStream.current.set(convoKey(turn.convoId), {
          reqId,
          convoId: turn.convoId,
          controller,
        });
        owned = true;
        // 朗读 AI 回复：只念普通 Nomi 对话（`/agent` 委派或后台自动跟进不念）
        if (!delegateTo && !bgFollow) speaker = startReplySpeech(reqId);
        dispatch({ type: 'SET_STREAMING', payload: true, convoId: turn.convoId });
        let accumulated = '';
        let thinking: boolean | undefined;
        const startedAt = Date.now();
        const trace: HarnessTraceEvent[] = [];
        let usage: HarnessUsage | undefined;
        let steps: string | undefined;
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
        const stopped = controller.signal.aborted;
        // 停止时还在跑的工具调用（内核已随这一轮中止它们）：标成已停止，否则时间线一直显示运行中
        trace.push(...closeOpenCalls(trace, Date.now(), t('ui.chat-settings.stopped')));
        if (stopped) speaker?.stop();
        else speaker?.finish();
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
        speaker?.stop();
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        // 本轮未委派时清掉主进程 turn pin，避免泄漏到下一轮
        void clearTurnPin(reqId);
        const key = convoKey(turn.convoId);
        if (owned && activeStream.current.get(key)?.reqId === reqId)
          activeStream.current.delete(key);
        if (inflight.current.get(key)?.reqId === reqId) inflight.current.delete(key);
        dispatch({ type: 'SET_STREAMING', payload: false, convoId: turn.convoId });
        dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId });
      }
    },
    [stateRef, dispatch, activeStream, inflight, maybeIngest, notifyToolStart, steering],
  );

  return { sendStreamMessage };
}

/** 发送相关的全部动作 */
export function useChatSends(options: SendsOptions) {
  const { sendMessage, askKnowledge } = usePlainSends(options);
  const { sendStreamMessage } = useStreamSend(options);
  return { sendMessage, askKnowledge, sendStreamMessage };
}
