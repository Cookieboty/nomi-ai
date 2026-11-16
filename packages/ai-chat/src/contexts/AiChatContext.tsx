import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { startupBrandIntro } from '../components/BrandIntro/state';
import { notifyConversationsChanged } from '../services/conversationStore';
import { delegateClient, type DelegateResult } from '../services/delegateClient';
import { delegateResultMessage } from '../services/delegateMessage';
import { desktopClient } from '../services/desktopClient';
import { harnessClient } from '../services/harnessClient';
import { createIPCClient } from '../services/IPCClient';
import { stopReplySpeech } from '../services/replySpeech';
import { schedClient } from '../services/schedClient';
import type { ImageAttachment } from '../services/screenClient';
import type { ChatConfig, ChatMessage } from '../types/chat';

import {
  aiChatReducer,
  buildInitialState,
  busyIn,
  convoKey,
  errorMessage,
  type AiChatAction,
  type AiChatState,
} from './aiChatState';
import { AiChatStoreContext, createAiChatStore } from './aiChatStore';
import { openTurn, upsertById, type ActiveStream, type InflightTurn } from './chatTurn';
import { compactHistory } from './compactHistory';
import { useNomiSteer } from './nomiSteer';
import { useMemoryIngest } from './useChatMemory';
import { useChatSends } from './useChatSends';

export interface AiChatActionsValue {
  dispatch: React.Dispatch<AiChatAction>;
  actions: AiChatActions;
}

interface AiChatContextType extends AiChatActionsValue {
  state: AiChatState;
}

export interface AiChatActions {
  sendMessage: (content: string) => Promise<void>;
  sendStreamMessage: (
    content: string,
    images?: ImageAttachment[],
    override?: { history: ChatMessage[] },
  ) => Promise<void>;
  /**
   * 从某条用户消息重新来过（重新生成 / 编辑重发）：丢弃它及之后的消息，
   * 用原文（或 newText）重新发送；运行中无操作。
   */
  resendFrom: (userMessageId: string, newText?: string) => Promise<void>;
  /**
   * `/compact`：把当前 Nomi 对话较早的部分压缩成摘要。
   * 返回 done / nothing（没有可压缩的）/ busy（正在回复）/ failed（附原因）
   */
  compactConversation: (instructions?: string) => Promise<{
    status: 'done' | 'nothing' | 'busy' | 'failed';
    error?: string;
  }>;
  /** 停止当前流式生成：中止上游请求，已生成的内容落盘；没有进行中的流时无操作 */
  stopGeneration: () => void;
  /** 删除会话前调用：若进行中的流属于该会话则中止它（晚到的回调也不会再写回界面 / 记忆） */
  abortConversation: (convoId: string) => void;
  /** 一轮进行中插入用户消息 / 有工具在跑 / 工具开始的订阅（见 contexts/nomiSteer） */
  steerStream: ReturnType<typeof useNomiSteer>['steerStream'];
  nomiToolRunning: ReturnType<typeof useNomiSteer>['nomiToolRunning'];
  onNomiToolStart: ReturnType<typeof useNomiSteer>['onNomiToolStart'];
  askKnowledge: (content: string, override?: { history: ChatMessage[] }) => Promise<void>;
  loadChatHistory: () => Promise<void>;
  clearChatHistory: () => Promise<void>;
  /** projectId：新 Nomi 对话的项目；缺省沿用当前 Nomi 对话的 */
  newConversation: (opts?: { projectId?: string | null }) => Promise<void>;
  loadConfig: () => Promise<void>;
  updateConfig: (config: Partial<ChatConfig>) => Promise<void>;
}

const AiChatContext = createContext<AiChatContextType | undefined>(undefined);

export interface AiChatContextProviderProps {
  children: ReactNode;
  /** 由外层 <AIProvider> 提供的 ClientAIClient；若未提供则内部退化为 Mock。 */
  client?: ClientAIClient;
}

export { compactHistory, type CompactResult } from './compactHistory';
export {
  aiChatReducer,
  busyIn,
  convoKey,
  type AiChatAction,
  type AiChatState,
} from './aiChatState';
export { openTurn, type ConversationTurn } from './chatTurn';

export function AiChatContextProvider({ children, client }: AiChatContextProviderProps) {
  const [state, dispatch] = useReducer(aiChatReducer, client, buildInitialState);
  /** 首屏绑定的 client 与 IPCClient：client 未变时复用，不重复构造 */
  const [initial] = useState(() => ({ client, ipcClient: state.ipcClient }));
  // actions 保持引用稳定（useCallback）：读最新 state 一律走 ref，避免每次渲染重建 value
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  /** 各会话进行中的流（不同会话可以同时回复）：停止只停当前会话的那一轮 */
  const activeStream = useRef(new Map<string, ActiveStream>());
  // 一轮进行中插入用户消息（只投给当前显示的会话）
  const { steerStream, nomiToolRunning, onNomiToolStart, notifyToolStart } = useNomiSteer(
    activeStream,
    () => convoKey(stateRef.current.ipcClient.currentConversationId?.()),
  );
  /**
   * 进行中这一轮的消息快照（用户消息 + 已生成的回复）：一轮结束才落盘，
   * 期间切走再切回时 loadChatHistory 从存储读不到它们，要从这里补回
   */
  const inflight = useRef(new Map<string, InflightTurn>());
  /** 历史加载序号：切换会话时后发起的加载为准，先发起的晚到结果直接丢弃 */
  const historySeq = useRef(0);

  // 当外部提供 ClientAIClient 时，使用绑定该 client 的 IPCClient（首屏已绑定的直接复用）；
  // 否则沿用初始化时通过工厂函数产出的实例（可能是 Mock）。
  const ipcClient = useMemo(() => {
    if (!client) return state.ipcClient;
    if (client === initial.client) return initial.ipcClient;
    return createIPCClient(client);
    // 只在 client 引用变化时重新绑定；state.ipcClient 用作首屏兜底。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    if (ipcClient !== state.ipcClient) {
      dispatch({ type: 'SET_IPC_CLIENT', payload: ipcClient });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ipcClient]);

  // 长期记忆：最新消息的引用（窗口隐藏 / 新建会话时拿来做摘要）
  const { ingestCurrent, maybeIngest } = useMemoryIngest(stateRef);

  // 卸载时放弃仍在进行的流
  useEffect(
    () => () => {
      for (const a of activeStream.current.values()) a.controller.abort();
    },
    [],
  );

  // 定时任务结果（每日简报等）→ 写进当前对话
  useEffect(
    () =>
      schedClient.onResult((r) => {
        if (!r.ok) return;
        const m: ChatMessage = {
          id: `sched-${r.id}`,
          role: 'assistant',
          content: t(
            '**{0}**{1}\n\n{2}',
            r.name,
            r.catchUp ? t('ui.chat-settings.added') : '',
            r.text,
          ),
          timestamp: r.at,
        };
        dispatch({ type: 'ADD_MESSAGE', payload: m });
        void ipcClient.saveMessage(m);
      }),
    [ipcClient],
  );

  // 异步委派完成 → 写进当前对话（卡片也订阅同一广播更新汇报；Nomi 下一轮能读到）
  useEffect(
    () =>
      delegateClient.onCompleted((r: DelegateResult) => {
        const m = delegateResultMessage(r);
        const targetId = r.conversationId;
        if (targetId && ipcClient.saveMessageTo) {
          // 只在目标会话仍是当前展示时更新 UI，避免污染另一会话（#116）
          if (ipcClient.currentConversationId?.() === targetId) {
            dispatch({ type: 'ADD_MESSAGE', payload: m });
          }
          void ipcClient.saveMessageTo(m, targetId);
        } else {
          dispatch({ type: 'ADD_MESSAGE', payload: m });
          void ipcClient.saveMessage(m);
        }
      }),
    [ipcClient],
  );

  // 主标签接在编程助手上时，CLI 自发的一轮（后台子代理完成后的跟进）由主进程广播，这里落进当前会话
  useEffect(
    () =>
      harnessClient.onTabMessage(({ tabId, message }) => {
        if (tabId !== 'main' || message.origin !== 'background' || message.role !== 'assistant')
          return;
        const m: ChatMessage = {
          id: message.id,
          role: 'assistant',
          content: message.content,
          timestamp: message.timestamp,
          origin: 'background',
          modelId: 'claude-code',
          ...(message.error ? { error: message.content } : {}),
          ...(message.stopped ? { stopped: true } : {}),
          ...(message.trace?.length ? { trace: message.trace } : {}),
          ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
        };
        dispatch({ type: 'ADD_MESSAGE', payload: m });
        void ipcClient.saveMessage(m);
      }),
    [ipcClient],
  );

  // 把文件拖到桌面角色身上 → 主进程总结完成后推送到对话窗口
  useEffect(
    () =>
      desktopClient.onSummary((e) => {
        const userMessage: ChatMessage = {
          id: `desk-${e.at}`,
          role: 'user',
          content: t('ui.chat-settings.summarize-file', e.name),
          timestamp: e.at,
        };
        const aiMessage: ChatMessage = {
          id: `desk-${e.at}-a`,
          role: 'assistant',
          content: e.summary,
          timestamp: e.at + 1,
        };
        dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
        dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
        void ipcClient.saveMessage(userMessage).then(() => ipcClient.saveMessage(aiMessage));
      }),
    [ipcClient],
  );

  const { sendMessage, askKnowledge, sendStreamMessage } = useChatSends({
    stateRef,
    dispatch,
    activeStream,
    inflight,
    maybeIngest,
    notifyToolStart,
  });

  const resendFrom = useCallback(
    async (userMessageId: string, newText?: string) => {
      const s = stateRef.current;
      if (busyIn(s, s.ipcClient.currentConversationId?.())) return;
      const idx = s.messages.findIndex((m) => m.id === userMessageId && m.role === 'user');
      if (idx < 0) return;
      const target = s.messages[idx]!;
      const kept = s.messages.slice(0, idx);
      const store = s.ipcClient.conversationStore?.();
      const convoId = s.ipcClient.currentConversationId?.();
      if (store && convoId) store.setMessages(convoId, kept);
      dispatch({ type: 'SET_MESSAGES', payload: kept });
      // 知识库问答的消息重新生成 / 编辑重发时仍走带引用的问答，不能无提示降级成普通对话
      if (target.kb) await askKnowledge(newText ?? target.content, { history: kept });
      else await sendStreamMessage(newText ?? target.content, undefined, { history: kept });
    },
    [sendStreamMessage, askKnowledge],
  );

  const compactConversation = useCallback(async (instructions?: string) => {
    const s = stateRef.current;
    if (busyIn(s, s.ipcClient.currentConversationId?.())) return { status: 'busy' as const };
    const turn = openTurn(s.ipcClient);
    dispatch({ type: 'SET_LOADING', payload: true, convoId: turn.convoId });
    try {
      const r = await compactHistory(
        s.ipcClient,
        s.messages,
        '',
        turn,
        true,
        dispatch,
        instructions,
      );
      if (r.error) return { status: 'failed' as const, error: r.error };
      return { status: r.next ? ('done' as const) : ('nothing' as const) };
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false, convoId: turn.convoId });
    }
  }, []);

  const stopGeneration = useCallback(() => {
    // 只停当前展示的会话的那一轮（别的会话还在回复不受影响）
    const a = activeStream.current.get(
      convoKey(stateRef.current.ipcClient.currentConversationId?.()),
    );
    stopReplySpeech();
    if (!a || a.controller.signal.aborted) return;
    a.controller.abort();
    // 兜底：即便客户端实现没有处理 signal，也直接通知主进程中止上游
    stateRef.current.ipcClient.abortStream?.(a.reqId);
  }, []);

  const abortConversation = useCallback((convoId: string) => {
    const a = activeStream.current.get(convoKey(convoId));
    if (!a || a.controller.signal.aborted) return;
    a.controller.abort();
    stateRef.current.ipcClient.abortStream?.(a.reqId);
  }, []);

  // 加载对话历史
  const loadChatHistory = useCallback(async () => {
    startupBrandIntro.taskStart('nomi');
    const my = ++historySeq.current;
    // 切换会话：停止朗读上一个会话的回复
    stopReplySpeech();
    // 换了会话：上一个会话的错误提示不再适用（#78）
    dispatch({ type: 'SET_ERROR', payload: undefined });
    try {
      const client = stateRef.current.ipcClient;
      const history = await client.getChatHistory();
      // 期间又发起了新的加载 / 清空 / 新建会话：这次结果已过期
      if (my !== historySeq.current) return;
      const convoId = client.currentConversationId?.();
      // 回到正在回复的会话：这一轮还没落盘，把它的用户消息与已生成的部分补回来
      const f = inflight.current.get(convoKey(convoId));
      const payload = f ? upsertById(history, f.messages) : history;
      dispatch({ type: 'SET_MESSAGES', payload, convoId });
    } catch (error) {
      if (my !== historySeq.current) return;
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    } finally {
      if (my === historySeq.current) startupBrandIntro.taskDone('nomi');
    }
  }, []);

  // 清空对话历史
  const clearChatHistory = useCallback(async () => {
    historySeq.current++;
    dispatch({ type: 'SET_ERROR', payload: undefined });
    try {
      await stateRef.current.ipcClient.clearChatHistory();
      dispatch({
        type: 'CLEAR_MESSAGES',
        convoId: stateRef.current.ipcClient.currentConversationId?.(),
      });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, []);

  // 新建会话（旧会话保留在本地存储中；进行中的流继续写回旧会话）
  const newConversation = useCallback(
    async (opts?: { projectId?: string | null }) => {
      historySeq.current++;
      stopReplySpeech();
      dispatch({ type: 'SET_ERROR', payload: undefined });
      try {
        ingestCurrent();
        // 不能当空对话复用：当前会话界面上有消息；任何正在准备 / 生成回复的会话（含切到后台的）——
        // 这一轮结束才落盘，期间存储里它们是零消息，复用会把旧轮的回包写回「新」对话（#276）
        const { messages, isLoading, busyConvos, ipcClient } = stateRef.current;
        const current = ipcClient.currentConversationId?.();
        const notReuse = [
          ...(busyConvos ?? []),
          ...inflight.current.keys(),
          ...activeStream.current.keys(),
          ...(current && (messages.length || isLoading) ? [current] : []),
        ].filter(Boolean);
        await ipcClient.newConversation(undefined, { projectId: opts?.projectId, notReuse });
        historySeq.current++;
        dispatch({
          type: 'CLEAR_MESSAGES',
          convoId: stateRef.current.ipcClient.currentConversationId?.(),
        });
        notifyConversationsChanged();
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      }
    },
    [ingestCurrent],
  );

  // 加载配置
  const loadConfig = useCallback(async () => {
    try {
      const config = await stateRef.current.ipcClient.getConfig();
      dispatch({ type: 'SET_CONFIG', payload: config });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, []);

  // 更新配置
  const updateConfig = useCallback(async (config: Partial<ChatConfig>) => {
    try {
      await stateRef.current.ipcClient.updateConfig(config);
      dispatch({ type: 'SET_CONFIG', payload: { ...stateRef.current.config, ...config } });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, []);

  // 初始化数据（ipcClient 变化时重新加载，保证 SDK client 就绪后拉到最新数据）
  useEffect(() => {
    loadConfig();
    void loadChatHistory();
  }, [state.ipcClient, loadConfig, loadChatHistory]);

  const actions = useMemo(
    () => ({
      sendMessage,
      sendStreamMessage,
      resendFrom,
      compactConversation,
      stopGeneration,
      abortConversation,
      steerStream,
      nomiToolRunning,
      onNomiToolStart,
      askKnowledge,
      loadChatHistory,
      clearChatHistory,
      newConversation,
      loadConfig,
      updateConfig,
    }),
    [
      sendMessage,
      sendStreamMessage,
      resendFrom,
      compactConversation,
      stopGeneration,
      abortConversation,
      steerStream,
      nomiToolRunning,
      onNomiToolStart,
      askKnowledge,
      loadChatHistory,
      clearChatHistory,
      newConversation,
      loadConfig,
      updateConfig,
    ],
  );

  const contextValue = useMemo<AiChatContextType>(
    () => ({ state, dispatch, actions }),
    [state, actions],
  );
  // External store for selector subscribers (aiChatStore.tsx): published after commit
  const [store] = useState(() => createAiChatStore(state));
  useLayoutEffect(() => {
    store.set(state);
  }, [store, state]);
  const storeValue = useMemo(() => ({ store, dispatch, actions }), [store, actions]);

  return (
    <AiChatStoreContext.Provider value={storeValue}>
      <AiChatContext.Provider value={contextValue}>{children}</AiChatContext.Provider>
    </AiChatStoreContext.Provider>
  );
}

export function useAiChat() {
  const context = useContext(AiChatContext);
  if (context === undefined) {
    throw new Error('useAiChat must be used within an AiChatContextProvider');
  }
  return context;
}
