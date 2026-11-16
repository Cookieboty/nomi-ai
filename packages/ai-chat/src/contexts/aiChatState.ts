/**
 * Nomi 对话的 state / action / reducer（从 AiChatContext 拆出）。
 * 这里只有纯数据与纯函数，不依赖 React 渲染。
 */
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';

import { createIPCClient } from '../services/IPCClient';
import type { ChatConfig, ChatMessage } from '../types/chat';
import type { IPCClient } from '../types/ipc';

export interface AiChatState {
  messages: ChatMessage[];
  config: ChatConfig;
  /** 有任意会话在回复（桌面角色的思考姿势、侧栏主标签状态用）；当前会话看 selectBusyHere */
  isLoading: boolean;
  /** 有任意会话在流式生成（可中止）；当前会话看 selectStreamingHere */
  streaming: boolean;
  /** 正在回复的会话（发起这一轮的会话 id；没有会话 id 的旧实现记为 ''）：不同会话可以同时回复 */
  busyConvos: string[];
  /** 正在流式生成、可以停止的会话 */
  streamingConvos: string[];
  error?: string;
  ipcClient: IPCClient;
  /** messages 当前展示的是哪个会话 */
  viewConvoId?: string;
}

export type AiChatAction =
  /** convoId：这批消息属于哪个会话（切换会话时带上；不带则沿用当前展示的会话） */
  | { type: 'SET_MESSAGES'; payload: ChatMessage[]; convoId?: string }
  | { type: 'ADD_MESSAGE'; payload: ChatMessage }
  | { type: 'UPDATE_MESSAGE'; payload: { id: string; content: string } }
  /** 按 id 覆盖，不存在则追加（流式期间切走又切回来时，补回这一轮的消息） */
  | { type: 'UPSERT_MESSAGES'; payload: ChatMessage[] }
  | { type: 'SET_STREAMING'; payload: boolean; convoId?: string }
  | { type: 'SET_CONFIG'; payload: ChatConfig }
  /** convoId：这次忙碌属于哪个会话（切走后别的会话不显示「回复中」） */
  | { type: 'SET_LOADING'; payload: boolean; convoId?: string }
  | { type: 'SET_ERROR'; payload: string | undefined }
  | { type: 'SET_IPC_CLIENT'; payload: IPCClient }
  | { type: 'CLEAR_MESSAGES'; convoId?: string };

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 首屏状态。有外层 <AIProvider> 的 client 时直接绑定它：不再另建一个自带 ClientAIClient 的
 * IPCClient（那会在同一窗口多开一个契约会话，见 contract 的 maxSessionsPerSender）。
 */
export const buildInitialState = (client?: ClientAIClient): AiChatState => ({
  messages: [],
  config: {
    theme: 'light',
    language: 'zh-CN',
    fontSize: 14,
    autoSave: true,
    maxHistoryLength: 1000,
  },
  isLoading: false,
  streaming: false,
  busyConvos: [],
  streamingConvos: [],
  ipcClient: createIPCClient(client),
});

/** Every field of `patch` is already identical on `cur`. */
function sameFields(cur: ChatMessage, patch: ChatMessage): boolean {
  for (const k of Object.keys(patch) as Array<keyof ChatMessage>)
    if (cur[k] !== patch[k]) return false;
  return true;
}

/** 会话 → 回复中列表的键：没有会话 id 的旧实现记为 '' */
export const convoKey = (convoId: string | undefined): string => convoId ?? '';

function toggleKey(list: string[] | undefined, convoId: string | undefined, on: boolean): string[] {
  const k = convoKey(convoId);
  list ??= [];
  if (on) return list.includes(k) ? list : [...list, k];
  return list.includes(k) ? list.filter((x) => x !== k) : list;
}

/** 某个会话是否在回复（'' 表示旧实现没有会话 id，视为当前会话） */
export function busyIn(
  s: Pick<AiChatState, 'busyConvos' | 'isLoading'>,
  convoId: string | undefined,
): boolean {
  if (!s.busyConvos) return s.isLoading;
  return s.busyConvos.includes('') || s.busyConvos.includes(convoKey(convoId));
}

export function aiChatReducer(state: AiChatState, action: AiChatAction): AiChatState {
  switch (action.type) {
    case 'SET_MESSAGES':
      return {
        ...state,
        messages: action.payload,
        ...('convoId' in action ? { viewConvoId: action.convoId } : {}),
      };
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
        if (i >= 0 && sameFields(messages[i]!, m)) continue; // unchanged: keep identity (memoized rows)
        messages =
          i < 0 ? [...messages, m] : messages.map((x, idx) => (idx === i ? { ...x, ...m } : x));
      }
      return { ...state, messages };
    }
    case 'SET_STREAMING': {
      const streamingConvos = toggleKey(state.streamingConvos, action.convoId, action.payload);
      return { ...state, streamingConvos, streaming: streamingConvos.length > 0 };
    }
    case 'SET_CONFIG':
      return { ...state, config: action.payload };
    case 'SET_LOADING':
      return {
        ...state,
        busyConvos: toggleKey(state.busyConvos, action.convoId, action.payload),
        isLoading: toggleKey(state.busyConvos, action.convoId, action.payload).length > 0,
        // 一轮总是从当前展示的会话发起：新对话的 id 在发送时才生成（ensureConversationId），
        // 这时 viewConvoId 还没有，认领它，否则首个对话被当成「别的会话在回复」（没有状态行）
        ...(action.payload && action.convoId && state.viewConvoId === undefined
          ? { viewConvoId: action.convoId }
          : {}),
      };
    case 'SET_ERROR':
      // 同值不换引用：切换会话时每次都会清一次错误，新 state 会让所有选择器重跑
      if (action.payload === state.error) return state;
      return { ...state, error: action.payload };
    case 'SET_IPC_CLIENT':
      return { ...state, ipcClient: action.payload };
    case 'CLEAR_MESSAGES':
      return {
        ...state,
        messages: [],
        ...('convoId' in action ? { viewConvoId: action.convoId } : {}),
      };
    default:
      return state;
  }
}
