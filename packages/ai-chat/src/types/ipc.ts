import type { HarnessTraceEvent } from '../services/harnessClient';
import type { StreamUsage } from '../utils/chunkTrace';

import {
  type ChatMessage,
  type ChatConfig,
  type ChatSession,
  type ConversationBackend,
} from './chat';

/** 流式发送的附加选项 */
export interface StreamSendOptions {
  /** 调用方预先生成的请求 id：用于「停止生成」时精确中止这一轮（透传给主进程） */
  reqId?: string;
  /** 中止信号：aborted 后尽快结束循环，并通知主进程中止上游请求；已收到的内容照常交给调用方 */
  signal?: AbortSignal;
  /** 工具调用 / 思考事件（Nomi 自己的 MCP / 知识库 / 搜索等工具）：与编程助手同一种轨迹事件 */
  onTrace?: (event: HarnessTraceEvent) => void;
  /** 思考执行状态，独立于明细；开始 / 增量为 true，结束 / 恢复输出为 false。 */
  onThinking?: (active: boolean) => void;
  /** 本轮 token 用量（上游返回时） */
  onUsage?: (usage: StreamUsage) => void;
  /**
   * 这一轮所属的会话与工作区，发起时（openTurn）就固定下来。给了就只用它，不再读「当前会话」：
   * 发送前的准备（压缩 / 记忆召回等）期间用户可能切到别的会话，请求不能带上那个会话的 id 与工作区。
   * 会话已被删除则拒绝发送。缺省时沿用当前会话（旧调用方）。
   */
  conversation?: { id: string | undefined; cwd?: string };
  /** 这一轮新召回的长期记忆：放在本轮用户原话前面发（不进 system，system 每轮不变才能命中提示缓存） */
  memory?: string;
  /** 这一轮工具循环的消息（内核 steps 块）：存进回复的 steps，下一轮原样带回 */
  onSteps?: (steps: string) => void;
}

export interface IPCClient {
  // 消息相关：history 为本轮之前的会话消息，与本轮输入一起发给模型（多轮上下文）
  /** memory：这一轮新召回的长期记忆（放在本轮用户原话前面发） */
  sendMessage(
    message: string,
    history?: ChatMessage[],
    extraSystem?: string,
    memory?: string,
  ): Promise<string>;
  /** 上下文压缩：用 summary 角色的模型生成摘要（可选：测试桩 / 旧实现没有时不压缩） */
  summarize?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<string>;
  /** 短补全：按 chat 路由（当前已选 Nomi 模型），用于会话标题等后台短提示 */
  completeChatText?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<string>;
  /** extraSystem：追加在 system prompt 后的上下文（技能目录等每轮不变的内容） */
  sendStreamMessage(
    message: string,
    onChunk?: (chunk: string) => void,
    history?: ChatMessage[],
    extraSystem?: string,
    /** 本轮附带的图片（base64） */
    images?: Array<{ mime: string; data: string }>,
    opts?: StreamSendOptions,
  ): Promise<void>;
  /** 中止某一轮流式请求（等价于 chat.abort(reqId)） */
  abortStream?(reqId: string): void;
  /** 一轮进行中插入用户消息（下一步并进上下文）；请求已结束 / 不能插入时 false */
  steerStream?(reqId: string, text: string): Promise<boolean>;
  /** 当前会话 id（长期记忆按会话摘要） */
  currentConversationId?(): string | undefined;
  /** 当前会话的消息 */
  getChatHistory(): Promise<ChatMessage[]>;
  /** 清空当前会话 */
  clearChatHistory(): Promise<void>;
  saveMessage(message: ChatMessage): Promise<void>;
  /**
   * 写入指定会话（不读「当前会话」）：流式回复期间用户可能切换 / 新建会话，
   * 落盘必须落在发起这一轮的会话里。会话已被删除则静默丢弃。
   */
  saveMessageTo?(message: ChatMessage, conversationId: string): Promise<void>;
  /** 取当前会话 id，没有则新建（发起一轮对话时固定下来） */
  ensureConversationId?(): string;

  // 会话相关
  listConversations(): Promise<Array<Omit<ChatSession, 'messages'>>>;
  newConversation(
    name?: string,
    /**
     * cwd：Nomi 对话的工作区；缺省时 Nomi 对话用主标签当前的目录（默认 文稿/nomi）。
     * 同一工作区已有空的 Nomi 对话时切过去不新建；notReuse 是不能复用的会话（界面上有消息 / 正在回复）
     */
    opts?: { backend?: ConversationBackend; tabId?: string; cwd?: string; notReuse?: string },
  ): Promise<string>;
  switchConversation(id: string): Promise<void>;
  /** 更新会话元信息（标题 / 后端 / tabId / CLI session id） */
  updateConversation?(
    id: string,
    patch: Partial<
      Pick<ChatSession, 'name' | 'backend' | 'tabId' | 'cliSessionId' | 'updatedAt' | 'cwd'>
    >,
  ): Promise<Omit<ChatSession, 'messages'>>;
  /** 同端或跨端分叉（复制可见消息） */
  forkConversation?(
    id: string,
    opts?: {
      backend?: ConversationBackend;
      tabId?: string;
      name?: string;
      cwd?: string;
      messages?: ChatMessage[];
    },
  ): Promise<Omit<ChatSession, 'messages'>>;
  deleteConversation?(id: string): Promise<void>;
  /** 暴露底层 store，供 CLI 标签同步侧栏（可选） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 避免 types↔services 循环
  conversationStore?(): any;

  // 配置相关
  getConfig(): Promise<ChatConfig>;
  updateConfig(config: Partial<ChatConfig>): Promise<void>;
}

export interface UpdateStateView {
  status: string;
  currentVersion: string;
  availableVersion?: string;
  releaseName?: string | null;
  releaseNotes?: string | null;
  percent?: number;
  error?: string;
  checkedAt?: number;
  autoCheck: boolean;
}
