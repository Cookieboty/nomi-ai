import type { HarnessTraceEvent, HarnessUsage } from '../services/harnessClient';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  modelId?: string;
  error?: string;
  /** 知识库问答：本条回答引用的来源（[n] 对应 n） */
  sources?: Array<{
    n: number;
    docId: string;
    chunkId: string;
    path: string;
    title: string;
    page?: number;
    snippet: string;
  }>;
  /** 来自知识库问答 */
  kb?: boolean;
  /** 用户点了「停止生成」：content 为中止前已生成的部分（可为空），界面追加灰色提示 */
  stopped?: boolean;
  /** 回答时参考了哪些长期记忆 */
  memories?: Array<{ id: string; kind: 'episode' | 'fact'; title: string }>;
  /** 本轮的工具调用 / 思考轨迹（与编程助手同一数据模型；Nomi 的 MCP / 知识库 / 搜索等工具调用） */
  trace?: HarnessTraceEvent[];
  /** 本轮耗时（ms，从发出到结束） */
  durationMs?: number;
  /** 本轮 token 用量（上游返回时才有） */
  usage?: HarnessUsage;
  /** 用户消息附带的图片：只保存缩略图（原图只随本轮发送，不进历史） */
  images?: Array<{ thumb: string; width: number; height: number; source?: string }>;
}

/** 对话所属后端：与 harness 后端一致；侧栏列表按此后端隔离 */
export type ConversationBackend = 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok';

export const CONVERSATION_BACKENDS: readonly ConversationBackend[] = [
  'nomi',
  'claude',
  'codex',
  'dsh',
  'grok',
] as const;

export function isConversationBackend(v: unknown): v is ConversationBackend {
  return typeof v === 'string' && (CONVERSATION_BACKENDS as readonly string[]).includes(v);
}

export interface ChatSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  modelId?: string;
  /** 该会话归属的后端；缺省迁移为 nomi */
  backend: ConversationBackend;
  /** CLI 标签 id：有值时消息在 harness，侧栏只存元信息 */
  tabId?: string;
}

export interface StreamResponse {
  delta: string;
  finished: boolean;
}

export interface ChatConfig {
  theme: 'light' | 'dark';
  language: 'zh-CN' | 'en-US';
  fontSize: number;
  autoSave: boolean;
  maxHistoryLength: number;
  /** 发送给模型的 system prompt（每次请求都会带上，不参与历史裁剪） */
  systemPrompt?: string;
}
