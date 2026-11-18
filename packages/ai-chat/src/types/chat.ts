import { BUILTIN_CLI_ORDER } from '@nomi-ai/cli-catalog';
import type { BuiltinCliId } from '@nomi-ai/cli-catalog';

import type { DelegateChanges } from '../services/delegateChanges';
import type { HarnessTraceEvent, HarnessUsage } from '../services/harnessClient';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  modelId?: string;
  /**
   * 上游响应里的模型名，和这一轮请求的不是同一个时才有（中继换成了别的模型）。
   * 原始字符串，页脚原样显示，说明在提示里。
   */
  responseModel?: string;
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
   * background：agent 自发的一轮（后台子代理完成后主代理的跟进），不是对某条用户消息的回复；
   * compaction：Nomi 对话的上下文压缩，content 是较早对话的摘要（services/compaction.ts）
   */
  origin?: 'background' | 'compaction';
  /** 回答时参考了哪些长期记忆 */
  memories?: Array<{ id: string; kind: 'episode' | 'fact'; title: string }>;
  /**
   * 带给模型的长期记忆（services/history.ts）：用户消息上是这一轮新召回的（放在用户原话前面发），
   * 压缩消息上是压缩前已经带过的全部（压缩后照样带着，不丢）。ids 用来排除已在上下文里的条目
   */
  memory?: { text: string; ids: string[] };
  /**
   * Nomi 回复：这一轮工具循环实际发给模型的消息（内核 steps 块，ModelMessage[] 的 JSON），
   * 下一轮原样发回（含工具调用与结果，前缀不变才能命中提示缓存）；没有工具调用时不存
   */
  steps?: string;
  /** 本轮的工具调用 / 思考轨迹（与 agent 同一数据模型；Nomi 的 MCP / 知识库 / 搜索等工具调用） */
  trace?: HarnessTraceEvent[];
  /** 仅流式占位消息：模型的思考阶段是否正在执行。定稿消息不保存该状态。 */
  thinking?: boolean;
  /** 本轮耗时（ms，从发出到结束） */
  durationMs?: number;
  /** 本轮 token 用量（上游返回时才有） */
  usage?: HarnessUsage;
  /** 用户用 `/cli` 指定这条需求交给哪个 agent（docs/development/coding-agents.md） */
  delegateTo?: BuiltinCliId;
  /**
   * 委派结果消息（origin background）：子任务改了哪些文件、各增删多少行，
   * 对话里用「已编辑 N 个文件」卡片打开每个文件的 Diff（services/delegateChanges.ts）
   */
  delegateChanges?: DelegateChanges;
  /** 用户消息附带的图片：只保存缩略图（原图只随本轮发送，不进历史） */
  images?: Array<{
    thumb: string;
    width: number;
    height: number;
    source?: string;
    /** 原图存进素材库后的地址（chat-asset://images/user-…）：可放大、复制，模型改图 / 参考时引用 */
    url?: string;
  }>;
  /**
   * 一轮进行中插入、已经交给模型的消息（Enter 插入，见 contexts/nomiSteer）：界面上只在回复的时间线里
   * （不另起用户气泡），上下文里跟着回复走。临时补进对话记录的那条：
   * 回复结束前应用被重启时它在对话里（不丢）；这一轮正常结束时按 id 删掉（它只在回复的轨迹里）。
   * 正文以「你加入了」标记开头（services/history.STEER_TAG）。
   */
  steer?: boolean;
}

/** 对话所属后端：与 harness 后端一致；侧栏列表按此后端隔离 */
/** 对话后端：Nomi 自己 + 内置 agent（id 由 @nomi-ai/cli-catalog 生成） */
export type ConversationBackend = 'nomi' | BuiltinCliId;

export const CONVERSATION_BACKENDS: readonly ConversationBackend[] = ['nomi', ...BUILTIN_CLI_ORDER];

export function isConversationBackend(v: unknown): v is ConversationBackend {
  // 旧版本「外部 CLI」的对话（backend 'external'）不再认，按非法 backend 回退 Nomi
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
  /**
   * Nomi 对话的思考深度（这个模型档位列表里的一档）。缺省用该模型的第二档。
   * 模型不支持时选择器不出现，请求也不带这个字段。
   */
  reasoningEffort?: string;
  /** CLI 标签 id：有值时消息在 harness，侧栏只存元信息 */
  tabId?: string;
  /** CLI 原生会话 id：用于与本机历史按 backend + sessionId 去重 */
  cliSessionId?: string;
  /**
   * Nomi 对话所在的项目（只用于 backend 'nomi'；CLI 会话的项目记在标签上）。项目的文件夹由内核实时取：
   * Nomi 的文件工具在这些文件夹里用、命令在主文件夹里启动，委派的 agent 也在这个项目里开工。
   * 缺省 = 没有项目（按已授权文件夹）。
   */
  projectId?: string;
  /** 归档时间：归档的对话不在侧栏显示，可在「设置 → Nomi → 已归档的对话」里恢复或删除 */
  archivedAt?: number;
  /** 置顶时间：置顶的会话在侧栏最上面的「置顶」里，按置顶先后排 */
  pinnedAt?: number;
  /** 迁移时换了 id 的会话（旧 id 不能当文件名）：原来的 id */
  legacyId?: string;
  /** 内核按消息文件重建索引时找回的会话（元信息是按消息补的） */
  recovered?: boolean;
  /**
   * 待发列表里还没交出去的消息（回复期间 Enter 插入 / Ctrl+Enter 排队）：存在元信息里（内核原样保存），
   * 应用中途重启（如更新）后挂回这个会话的待发列表。交出去 / 删除 / 撤回 / 合成发送之后同步改这里；
   * 空了就删掉这个字段。见 services/pendingSendsStore。
   */
  pendingSends?: Array<{ id: string; text: string; mode: 'steer' | 'queue'; kb?: true }>;
  /**
   * 已经交给这一轮、回复还没结束的插入消息（存在元信息里，中途重启后补成用户消息）。
   * 正常结束时清掉，它们只留在回复的轨迹里。见 contexts/chatTurn。
   */
  deliveredSteers?: {
    reqId: string;
    afterId: string;
    items: Array<{ id: string; text: string; marker?: string }>;
  };
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
