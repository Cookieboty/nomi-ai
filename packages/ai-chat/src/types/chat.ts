import type { BuiltinCliId } from '@nomi-ai/cli-catalog';

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
  /**
   * background：编程助手自发的一轮（后台子代理完成后主代理的跟进），不是对某条用户消息的回复；
   * compaction：Nomi 对话的上下文压缩，content 是较早对话的摘要（services/compaction.ts）
   */
  origin?: 'background' | 'compaction';
  /** 回答时参考了哪些长期记忆 */
  memories?: Array<{ id: string; kind: 'episode' | 'fact'; title: string }>;
  /** 本轮的工具调用 / 思考轨迹（与编程助手同一数据模型；Nomi 的 MCP / 知识库 / 搜索等工具调用） */
  trace?: HarnessTraceEvent[];
  /** 本轮耗时（ms，从发出到结束） */
  durationMs?: number;
  /** 本轮 token 用量（上游返回时才有） */
  usage?: HarnessUsage;
  /** 用户用 `/cli` 指定这条需求交给哪个编程助手（docs/design/nomi-delegate-cli.md §4.6） */
  delegateTo?: 'claude' | 'codex' | 'grok' | 'gemini' | 'dsh';
  /** 用户消息附带的图片：只保存缩略图（原图只随本轮发送，不进历史） */
  images?: Array<{ thumb: string; width: number; height: number; source?: string }>;
}

/** 对话所属后端：与 harness 后端一致；侧栏列表按此后端隔离 */
/** 对话后端：Nomi 自己 + 内置编程助手（id 由 @nomi-ai/cli-catalog 生成） */
/** 'external'：用户添加的外部 CLI（§5.9），具体是哪个插件看标签 / 对话的 pluginId */
export type ConversationBackend = 'nomi' | BuiltinCliId | 'external';

export const CONVERSATION_BACKENDS: readonly ConversationBackend[] = [
  'nomi',
  'claude',
  'codex',
  'dsh',
  'grok',
  'gemini',
] as const;

export function isConversationBackend(v: unknown): v is ConversationBackend {
  // 'external'（外部 CLI，§5.9）不在固定端点列表里（它要带 pluginId），但它的对话也是合法的
  return (
    typeof v === 'string' &&
    (v === 'external' || (CONVERSATION_BACKENDS as readonly string[]).includes(v))
  );
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
  /** CLI 原生会话 id：用于与本机历史按 backend + sessionId 去重 */
  cliSessionId?: string;
  /**
   * Nomi 对话的工作区（只用于 backend 'nomi'）：选了之后 Nomi 的文件 / 命令工具只能在这里面用，
   * 委派的编程助手也在这里开工。缺省 = 没有工作区（按已授权文件夹，原有行为）。
   */
  cwd?: string;
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
