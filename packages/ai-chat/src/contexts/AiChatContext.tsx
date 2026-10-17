import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { t } from '@nomi-ai/ui';
import React, {
  createContext,
  useCallback,
  useContext,
  useReducer,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { desktopClient } from '../services/desktopClient';
import { extClient } from '../services/extClient';
import {
  harnessClient,
  type HarnessTraceEvent,
  type HarnessUsage,
} from '../services/harnessClient';
import { createIPCClient } from '../services/IPCClient';
import { kbClient } from '../services/kbClient';
import { ingestConversation, memoryContext } from '../services/memClient';
import { effectiveProviderLabel, providerClientAvailable } from '../services/providerClient';
import { schedClient } from '../services/schedClient';
import { screenClient, type ImageAttachment } from '../services/screenClient';
import { type ChatMessage, type ChatConfig } from '../types/chat';
import { type AIModelConfig } from '../types/config';
import { type IPCClient } from '../types/ipc';

/** 消息上的模型标签：主进程路由时显示当前生效 provider，否则沿用本地模型 id */
const messageModelTag = (currentModelId?: string): string | undefined =>
  providerClientAvailable() ? effectiveProviderLabel() : currentModelId;

interface AiChatState {
  messages: ChatMessage[];
  config: ChatConfig;
  models: AIModelConfig[];
  currentModelId?: string;
  isLoading: boolean;
  /** 正在流式生成且可中止（Nomi 后端；CLI 后端的整段转发不可中止） */
  streaming: boolean;
  error?: string;
  ipcClient: IPCClient;
}

type AiChatAction =
  | { type: 'SET_MESSAGES'; payload: ChatMessage[] }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'UPDATE_MESSAGE'; payload: { id: string; content: string } }
  /** 按 id 覆盖，不存在则追加（流式期间切走又切回来时，补回这一轮的消息） */
  | { type: 'UPSERT_MESSAGES'; payload: ChatMessage[] }
  | { type: 'SET_STREAMING'; payload: boolean }
  | { type: 'SET_CONFIG'; payload: ChatConfig }
  | { type: 'SET_MODELS'; payload: AIModelConfig[] }
  | { type: 'SET_CURRENT_MODEL'; payload: string }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | undefined }
  | { type: 'SET_IPC_CLIENT'; payload: IPCClient }
  | { type: 'CLEAR_MESSAGES' };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const LOCAL_CURRENT_MODEL_KEY = 'ai-chat:currentModel';

const readCurrentModelId = (): string | undefined => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return undefined;
    const raw = window.localStorage.getItem(LOCAL_CURRENT_MODEL_KEY);
    return raw ? (JSON.parse(raw) as string) : undefined;
  } catch {
    return undefined;
  }
};

const persistCurrentModelId = (id: string): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(LOCAL_CURRENT_MODEL_KEY, JSON.stringify(id));
  } catch {
    /* ignore */
  }
};

const buildInitialState = (): AiChatState => ({
  messages: [],
  config: {
    theme: 'light',
    language: 'zh-CN',
    fontSize: 14,
    autoSave: true,
    maxHistoryLength: 1000,
  },
  models: [],
  currentModelId: readCurrentModelId(),
  isLoading: false,
  streaming: false,
  ipcClient: createIPCClient(),
});

function aiChatReducer(state: AiChatState, action: AiChatAction): AiChatState {
  switch (action.type) {
    case 'SET_MESSAGES':
      return { ...state, messages: action.payload };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.payload] };
    case 'UPDATE_MESSAGE':
      return {
        ...state,
        messages: state.messages.map((msg) =>
          msg.id === action.payload.id ? { ...msg, content: action.payload.content } : msg,
        ),
      };
    case 'UPSERT_MESSAGES': {
      let messages = state.messages;
      for (const m of action.payload) {
        const i = messages.findIndex((x) => x.id === m.id);
        messages =
          i < 0 ? [...messages, m] : messages.map((x, idx) => (idx === i ? { ...x, ...m } : x));
      }
      return { ...state, messages };
    }
    case 'SET_STREAMING':
      return { ...state, streaming: action.payload };
    case 'SET_CONFIG':
      return { ...state, config: action.payload };
    case 'SET_MODELS':
      return { ...state, models: action.payload };
    case 'SET_CURRENT_MODEL':
      persistCurrentModelId(action.payload);
      return { ...state, currentModelId: action.payload };
    case 'SET_LOADING':
      return { ...state, isLoading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload };
    case 'SET_IPC_CLIENT':
      return { ...state, ipcClient: action.payload };
    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };
    default:
      return state;
  }
}

interface AiChatContextType {
  state: AiChatState;
  dispatch: React.Dispatch<AiChatAction>;
  actions: {
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
    /** 停止当前流式生成：中止上游请求，已生成的内容落盘；没有进行中的流时无操作 */
    stopGeneration: () => void;
    askKnowledge: (content: string) => Promise<void>;
    loadChatHistory: () => Promise<void>;
    clearChatHistory: () => Promise<void>;
    newConversation: () => Promise<void>;
    loadConfig: () => Promise<void>;
    updateConfig: (config: Partial<ChatConfig>) => Promise<void>;
    loadModels: () => Promise<void>;
    updateModel: (modelId: string, updates: Partial<AIModelConfig>) => Promise<void>;
    setCurrentModel: (modelId: string) => void;
  };
}

const AiChatContext = createContext<AiChatContextType | undefined>(undefined);

export interface AiChatContextProviderProps {
  children: ReactNode;
  /** 由外层 <AIProvider> 提供的 ClientAIClient；若未提供则内部退化为 Mock。 */
  client?: ClientAIClient;
}

/**
 * 固定「一轮对话」所属的会话：流式回复要等很久，期间用户可能切换 / 新建会话，
 * 落盘必须写回发起这一轮的会话，界面更新也只在该会话仍在显示时进行。
 */
export interface ConversationTurn {
  convoId: string | undefined;
  /** 发起这一轮的会话是否仍是当前展示的会话 */
  isActive: () => boolean;
  save: (message: ChatMessage) => Promise<void>;
}

export function openTurn(client: IPCClient): ConversationTurn {
  const convoId = client.ensureConversationId?.() ?? client.currentConversationId?.();
  return {
    convoId,
    isActive: () => {
      const cur = client.currentConversationId?.();
      return !convoId || !cur || cur === convoId;
    },
    save: (message) =>
      convoId && client.saveMessageTo
        ? client.saveMessageTo(message, convoId)
        : client.saveMessage(message),
  };
}

const newReqId = (): string =>
  `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface ActiveStream {
  reqId: string;
  convoId: string | undefined;
  controller: AbortController;
}

export function AiChatContextProvider({ children, client }: AiChatContextProviderProps) {
  const [state, dispatch] = useReducer(aiChatReducer, undefined, buildInitialState);
  // actions 保持引用稳定（useCallback）：读最新 state 一律走 ref，避免每次渲染重建 value
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const activeStream = useRef<ActiveStream | null>(null);
  /** 历史加载序号：切换会话时后发起的加载为准，先发起的晚到结果直接丢弃 */
  const historySeq = useRef(0);

  // 当外部提供 ClientAIClient 时，构造一个绑定该 client 的 IPCClient；
  // 否则沿用初始化时通过工厂函数产出的实例（可能是 Mock）。
  const ipcClient = useMemo(() => {
    if (!client) return state.ipcClient;
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
  const ingestCurrent = useCallback((msgs?: ChatMessage[], convoId?: string) => {
    const s = stateRef.current;
    ingestConversation(
      convoId ?? s.ipcClient.currentConversationId?.(),
      (msgs ?? s.messages)
        .filter((m) => !m.error && !m.stopped)
        .map((m) => ({ role: m.role, content: m.content })),
    );
  }, []);
  useEffect(() => {
    // 对话窗口被隐藏 / 关闭 → 把这段对话整理进记忆（主进程会跳过没有新内容的会话）
    const onHide = () => document.visibilityState === 'hidden' && ingestCurrent();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [ingestCurrent]);
  /** 每积累 10 条消息自动摘要一次 */
  const maybeIngest = useCallback(
    (msgs: ChatMessage[], convoId?: string) => {
      if (msgs.length >= 4 && msgs.length % 10 < 2) ingestCurrent(msgs, convoId);
    },
    [ingestCurrent],
  );

  // 卸载时放弃仍在进行的流
  useEffect(
    () => () => {
      activeStream.current?.controller.abort();
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
          content: t('**{0}**{1}\n\n{2}', r.name, r.catchUp ? t('（补上）') : '', r.text),
          timestamp: r.at,
        };
        dispatch({ type: 'ADD_MESSAGE', payload: m });
        void ipcClient.saveMessage(m);
      }),
    [ipcClient],
  );

  // 把文件拖到看板娘身上 → 主进程总结完成后推送到对话窗口
  useEffect(
    () =>
      desktopClient.onSummary((e) => {
        const userMessage: ChatMessage = {
          id: `desk-${e.at}`,
          role: 'user',
          content: t('总结文件：{0}', e.name),
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

  // 发送普通消息
  const sendMessage = useCallback(
    async (content: string) => {
      const s = stateRef.current;
      const turn = openTurn(s.ipcClient);
      try {
        dispatch({ type: 'SET_LOADING', payload: true });
        dispatch({ type: 'SET_ERROR', payload: undefined });

        const userMessage: ChatMessage = {
          id: Date.now().toString(),
          role: 'user',
          content,
          timestamp: Date.now(),
          modelId: messageModelTag(s.currentModelId),
        };
        // 本轮之前的会话消息作为多轮上下文（state.messages 尚未包含本轮 userMessage）
        const history = s.messages;
        dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
        schedClient.activity();

        // CLI 后端：全部转发，禁用 Nomi 工具 / 记忆注入
        if (harnessClient.available()) {
          const hs = await harnessClient.state();
          if (hs.backend !== 'nomi') {
            const r = await harnessClient.send(content);
            const aiMessage: ChatMessage = {
              id: (Date.now() + 1).toString(),
              role: 'assistant',
              content: r.text,
              timestamp: Date.now(),
              modelId: hs.backend === 'claude' ? 'claude-code' : hs.backend,
            };
            if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
            await turn.save(userMessage);
            await turn.save(aiMessage);
            return;
          }
        }

        const mem = await memoryContext(content);
        const response = await s.ipcClient.sendMessage(
          content,
          s.currentModelId,
          history,
          mem.text,
        );

        const aiMessage: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: response,
          timestamp: Date.now(),
          modelId: messageModelTag(s.currentModelId),
          ...(mem.used.length ? { memories: mem.used } : {}),
        };
        if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });

        await turn.save(userMessage);
        await turn.save(aiMessage);
        maybeIngest([...history, userMessage, aiMessage], turn.convoId);
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    },
    [maybeIngest],
  );

  // 知识库问答：主进程检索本地索引 → 模型带引用回答
  const askKnowledge = useCallback(async (content: string) => {
    const s = stateRef.current;
    const turn = openTurn(s.ipcClient);
    try {
      dispatch({ type: 'SET_LOADING', payload: true });
      dispatch({ type: 'SET_ERROR', payload: undefined });
      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: Date.now(),
        kb: true,
      };
      const history = s.messages
        .filter((m) => !m.error && (m.role === 'user' || m.role === 'assistant'))
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));
      dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
      const r = await kbClient.ask(content, history);
      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: r.answer,
        timestamp: Date.now(),
        modelId: messageModelTag(s.currentModelId),
        sources: r.sources,
        kb: true,
      };
      if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
      await turn.save(userMessage);
      await turn.save(aiMessage);
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  // 发送流式消息
  const sendStreamMessage = useCallback(
    async (content: string, images?: ImageAttachment[], override?: { history: ChatMessage[] }) => {
      const s = stateRef.current;
      const client = s.ipcClient;
      // 发起时固定会话：之后无论用户切到哪个会话，这一轮都写回这里
      const turn = openTurn(client);
      const reqId = newReqId();
      const controller = new AbortController();
      let owned = false;
      try {
        dispatch({ type: 'SET_LOADING', payload: true });
        dispatch({ type: 'SET_ERROR', payload: undefined });

        // 图片要离开本机前：云端模型首次告知 / 仅本地模式拦截
        if (images?.length && screenClient.available()) {
          const r = await screenClient.checkSend();
          if (r === 'local_only')
            throw new Error(
              t(
                '已开启「仅本地模型」，当前对话模型在云端，不能发送图片。可切换到本地视觉模型（如 Ollama）',
              ),
            );
          if (r === 'user_denied') throw new Error(t('已取消：图片没有发送给云端模型'));
        }

        const userMessage: ChatMessage = {
          id: Date.now().toString(),
          role: 'user',
          content,
          timestamp: Date.now(),
          modelId: messageModelTag(s.currentModelId),
          ...(images?.length
            ? {
                images: images.map((i) => ({
                  thumb: i.thumb,
                  width: i.width,
                  height: i.height,
                  source: i.source,
                })),
              }
            : {}),
        };
        const history = override?.history ?? s.messages;
        dispatch({ type: 'ADD_MESSAGE', payload: userMessage });
        schedClient.activity();

        if (harnessClient.available()) {
          const hs = await harnessClient.state();
          if (hs.backend !== 'nomi') {
            if (images?.length) throw new Error(t('编程助手后端暂不支持图片，请切回 Nomi'));
            const r = await harnessClient.send(content);
            const done: ChatMessage = {
              id: (Date.now() + 1).toString(),
              role: 'assistant',
              content: r.text,
              timestamp: Date.now(),
              modelId: hs.backend === 'claude' ? 'claude-code' : hs.backend,
              ...(r.trace?.length ? { trace: r.trace } : {}),
              ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
              ...(r.usage ? { usage: r.usage } : {}),
            };
            if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: done });
            await turn.save(userMessage);
            await turn.save(done);
            return;
          }
        }

        const [mem, skills] = await Promise.all([memoryContext(content), extClient.context()]);
        const aiMessageId = (Date.now() + 1).toString();
        const aiMessage: ChatMessage = {
          id: aiMessageId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          modelId: messageModelTag(s.currentModelId),
          ...(mem.used.length ? { memories: mem.used } : {}),
        };
        if (turn.isActive()) dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });

        activeStream.current = { reqId, convoId: turn.convoId, controller };
        owned = true;
        dispatch({ type: 'SET_STREAMING', payload: true });

        let accumulated = '';
        const startedAt = Date.now();
        const trace: HarnessTraceEvent[] = [];
        let usage: HarnessUsage | undefined;
        // 流式 UI 更新按帧合批：一帧内到达的文本 / 工具事件只 dispatch 一次（逐 chunk dispatch 会让整条消息列表重渲染）
        let raf = 0;
        let timer = 0;
        const flushUi = () => {
          if (raf) cancelAnimationFrame(raf);
          if (timer) window.clearTimeout(timer);
          raf = 0;
          timer = 0;
          // 用户已切到别的会话：只累积，不动当前界面；回到本会话时补回整轮消息
          if (!turn.isActive()) return;
          dispatch({
            type: 'UPSERT_MESSAGES',
            payload: [
              userMessage,
              {
                ...aiMessage,
                content: accumulated,
                ...(trace.length ? { trace: [...trace] } : {}),
              },
            ],
          });
        };
        const scheduleUi = () => {
          if (raf || timer) return;
          raf = requestAnimationFrame(flushUi);
          timer = window.setTimeout(flushUi, 100);
        };
        try {
          await client.sendStreamMessage(
            content,
            s.currentModelId,
            (chunk: string) => {
              accumulated += chunk;
              scheduleUi();
            },
            history,
            [mem.text, skills].filter(Boolean).join('\n\n'),
            images?.map((i) => ({ mime: i.mime, data: i.data })),
            {
              reqId,
              signal: controller.signal,
              onTrace: (ev) => {
                trace.push(ev);
                scheduleUi();
              },
              onUsage: (u) => {
                usage = { ...usage, ...u };
              },
            },
          );
        } catch (err) {
          flushUi();
          // 这一轮失败：保留已生成的部分与轨迹，作为「错误卡片」留在对话里（可重试），不进模型上下文
          const failed: ChatMessage = {
            ...aiMessage,
            content: accumulated,
            error: errorMessage(err),
            durationMs: Date.now() - startedAt,
            ...(trace.length ? { trace: [...trace] } : {}),
          };
          if (turn.isActive())
            dispatch({ type: 'UPSERT_MESSAGES', payload: [userMessage, failed] });
          await turn.save(userMessage);
          await turn.save(failed);
          throw err;
        }
        flushUi();

        const stopped = controller.signal.aborted;
        const finalAiMessage: ChatMessage = {
          ...aiMessage,
          content: accumulated,
          durationMs: Date.now() - startedAt,
          ...(trace.length ? { trace: [...trace] } : {}),
          ...(usage ? { usage } : {}),
          ...(stopped ? { stopped: true } : {}),
        };
        if (turn.isActive()) {
          dispatch({ type: 'UPSERT_MESSAGES', payload: [userMessage, finalAiMessage] });
        }
        await turn.save(userMessage);
        await turn.save(finalAiMessage);
        if (!stopped) maybeIngest([...history, userMessage, finalAiMessage], turn.convoId);
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
      } finally {
        if (owned && activeStream.current?.reqId === reqId) activeStream.current = null;
        dispatch({ type: 'SET_STREAMING', payload: false });
        dispatch({ type: 'SET_LOADING', payload: false });
      }
    },
    [maybeIngest],
  );

  const resendFrom = useCallback(
    async (userMessageId: string, newText?: string) => {
      const s = stateRef.current;
      if (s.isLoading) return;
      const idx = s.messages.findIndex((m) => m.id === userMessageId && m.role === 'user');
      if (idx < 0) return;
      const target = s.messages[idx]!;
      const kept = s.messages.slice(0, idx);
      const store = s.ipcClient.conversationStore?.();
      const convoId = s.ipcClient.currentConversationId?.();
      if (store && convoId) store.setMessages(convoId, kept);
      dispatch({ type: 'SET_MESSAGES', payload: kept });
      await sendStreamMessage(newText ?? target.content, undefined, { history: kept });
    },
    [sendStreamMessage],
  );

  const stopGeneration = useCallback(() => {
    const a = activeStream.current;
    if (!a || a.controller.signal.aborted) return;
    a.controller.abort();
    // 兜底：即便客户端实现没有处理 signal，也直接通知主进程中止上游
    stateRef.current.ipcClient.abortStream?.(a.reqId);
  }, []);

  // 加载对话历史
  const loadChatHistory = useCallback(async () => {
    const my = ++historySeq.current;
    try {
      const history = await stateRef.current.ipcClient.getChatHistory();
      // 期间又发起了新的加载 / 清空 / 新建会话：这次结果已过期
      if (my !== historySeq.current) return;
      dispatch({ type: 'SET_MESSAGES', payload: history });
    } catch (error) {
      if (my !== historySeq.current) return;
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, []);

  // 清空对话历史
  const clearChatHistory = useCallback(async () => {
    historySeq.current++;
    try {
      await stateRef.current.ipcClient.clearChatHistory();
      dispatch({ type: 'CLEAR_MESSAGES' });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, []);

  // 新建会话（旧会话保留在本地存储中；进行中的流继续写回旧会话）
  const newConversation = useCallback(async () => {
    historySeq.current++;
    try {
      ingestCurrent();
      await stateRef.current.ipcClient.newConversation();
      historySeq.current++;
      dispatch({ type: 'CLEAR_MESSAGES' });
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, [ingestCurrent]);

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

  // 加载模型列表
  const loadModels = useCallback(async () => {
    try {
      const models = await stateRef.current.ipcClient.getAvailableModels();
      dispatch({ type: 'SET_MODELS', payload: models });

      if (!stateRef.current.currentModelId && models.length > 0) {
        const enabledModel = models.find((m: AIModelConfig) => m.enabled) || models[0];
        dispatch({ type: 'SET_CURRENT_MODEL', payload: enabledModel.id });
      }
    } catch (error) {
      dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
    }
  }, []);

  // 更新模型配置
  const updateModel = useCallback(
    async (modelId: string, updates: Partial<AIModelConfig>) => {
      try {
        await stateRef.current.ipcClient.updateModel(modelId, updates);
        await loadModels();
      } catch (error) {
        dispatch({ type: 'SET_ERROR', payload: errorMessage(error) });
        throw error;
      }
    },
    [loadModels],
  );

  // 设置当前模型
  const setCurrentModel = useCallback((modelId: string) => {
    dispatch({ type: 'SET_CURRENT_MODEL', payload: modelId });
  }, []);

  // 初始化数据（ipcClient 变化时重新加载，保证 SDK client 就绪后拉到最新数据）
  useEffect(() => {
    loadConfig();
    loadModels();
    loadChatHistory();
  }, [state.ipcClient, loadConfig, loadModels, loadChatHistory]);

  const actions = useMemo(
    () => ({
      sendMessage,
      sendStreamMessage,
      resendFrom,
      stopGeneration,
      askKnowledge,
      loadChatHistory,
      clearChatHistory,
      newConversation,
      loadConfig,
      updateConfig,
      loadModels,
      updateModel,
      setCurrentModel,
    }),
    [
      sendMessage,
      sendStreamMessage,
      resendFrom,
      stopGeneration,
      askKnowledge,
      loadChatHistory,
      clearChatHistory,
      newConversation,
      loadConfig,
      updateConfig,
      loadModels,
      updateModel,
      setCurrentModel,
    ],
  );

  const contextValue = useMemo<AiChatContextType>(
    () => ({ state, dispatch, actions }),
    [state, actions],
  );

  return <AiChatContext.Provider value={contextValue}>{children}</AiChatContext.Provider>;
}

export function useAiChat() {
  const context = useContext(AiChatContext);
  if (context === undefined) {
    throw new Error('useAiChat must be used within an AiChatContextProvider');
  }
  return context;
}
