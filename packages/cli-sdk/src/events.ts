/**
 * 会话事件（docs/design/cli-plugin-architecture.md §5.4）。
 *
 * - `HarnessEvent`：一轮里给界面的事件（原 electron `cli/types.ts`，搬到这里由驱动与插件共用）；
 * - `SessionEvent`：驱动的会话级事件流（轮次内外都有：ACP 轮次结束后的更新、命令列表、权限请求、进程退出）；
 * - `PermissionAnswer`：二元确认、ACP 的多选项、Claude 改写入参都能表达。
 */

/** Nomi 的五档权限模式（各 CLI 映射到自己的参数 / mode id） */
export type HarnessPermissionMode = 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypass';

export type HarnessEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      name: string;
      status: 'start' | 'done' | 'error';
      /** claude / dsh / grok：调用 id；codex：命令行 */
      detail?: string;
      /** 调用 id（codex 等 detail 不是 id 的后端） */
      id?: string;
      /** 参数（已裁剪的 JSON 或文本）；start 事件带，部分后端在结果事件里补 */
      input?: string;
      /** 工具输出（已裁剪） */
      output?: string;
      /** 子代理内部的调用：指向父工具调用 id */
      parentId?: string;
      /** 主进程收到该事件的时间（ms） */
      at?: number;
      /** 事件发生时助手正文的字符下标，用来把工具插回文字中间 */
      textAt?: number;
    }
  | { type: 'thinking'; text: string; at?: number; textAt?: number }
  | {
      type: 'permission';
      id: string;
      summary: string;
      /** 请求的工具调用 id（Claude can_use_tool.tool_use_id） */
      toolUseId?: string;
      /** 发起请求的子代理（描述 / 类型）；主代理自己的请求没有 */
      agent?: string;
      /** 超时自动拒绝的时间点（ms），界面显示倒计时 */
      expiresAt?: number;
    }
  /**
   * 子代理生命周期（docs/design/cli-subagents.md §3）：四个后端统一成这一种。
   * id：Claude task_id / Codex 子线程 id / dsh callId；callId：派生它的工具调用 id。
   */
  | {
      type: 'agent';
      op: 'start' | 'progress' | 'end';
      id: string;
      callId?: string;
      label?: string;
      agentType?: string;
      background?: boolean;
      status?: 'running' | 'completed' | 'failed' | 'stopped';
      progress?: string;
      summary?: string;
      usage?: { toolUses?: number; tokens?: number; durationMs?: number };
    }
  /** 权限请求已结束（用户允许 / 拒绝，或超时自动拒绝）：界面据此移除对应卡片 */
  | { type: 'permission-resolved'; id: string; reason: 'allowed' | 'denied' | 'timeout' }
  /** 非文本的等待 / 恢复状态：重试、重连、上下文压缩（clear 表示恢复正常） */
  | {
      type: 'status';
      kind: 'retry' | 'reconnect' | 'compact' | 'clear';
      text?: string;
      attempt?: number;
      max?: number;
    }
  /**
   * 一轮进行中的实时上下文占用：主线程每次模型请求的输入 + 输出（与 usage.contextTokens 同口径），
   * 以及上下文压缩后的新占用。一轮里可能多次请求、甚至自动压缩，只看轮末 usage 会一直停在旧值。
   * tokens 为 null：压缩了但 CLI 没给压缩后的大小，丢弃旧值、等下一次请求。
   * 各后端来源：Claude assistant.usage / compact_boundary；Codex thread/tokenUsage/updated；
   * Gemini·Grok(ACP) usage_update；Grok streaming-json 逐请求 usage 行；dsh status/step_end。
   * window：CLI 同时给了模型窗口时附带（Codex modelContextWindow、Gemini usage_update.size）。
   */
  | { type: 'context'; tokens: number | null; model?: string; window?: number }
  | { type: 'done'; sessionId?: string; text: string; usage?: HarnessUsage }
  | { type: 'error'; message: string };

/** 一轮的用量（有数据时才有字段） */
export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  /** CLI 自己上报的总耗时（ms） */
  durationMs?: number;
  /**
   * 当前上下文占用：这一轮**最后一次**模型请求的全部输入（含缓存读 / 写）+ 该次输出。
   * 上面几项是整轮累计（计费口径），一轮里多次请求时远大于真实上下文；CLI 给了逐请求用量才有此值。
   */
  contextTokens?: number;
  /** CLI 上报的模型上下文窗口（如 Claude modelUsage.contextWindow），优先于前端经验表 */
  contextWindow?: number;
  /** CLI 实际使用的主模型（标签没指定模型时，前端据此查窗口经验表） */
  model?: string;
}

/** CLI 报告的斜杠命令（ACP available_commands_update 等） */
export interface SlashCommand {
  name: string;
  description?: string;
  /** 参数提示（ACP input.hint） */
  hint?: string;
}

/** 权限请求里给用户选的一项（ACP options） */
export interface PermissionOption {
  id: string;
  /** allow_once / allow_always / reject_once / reject_always / 其它 */
  kind: string;
  name?: string;
}

/** 驱动发给编排层的权限请求（编排层决定弹卡片、按档位自动允许或超时拒绝） */
export interface PermissionRequest {
  /** 卡片摘要（工具 + 第一处路径 / 命令） */
  summary: string;
  /** 请求所属的工具调用 id */
  toolUseId?: string;
  /** 协议给出的可选项（ACP）；二元协议为空 */
  options?: PermissionOption[];
  /** 协议方法名（如 item/commandExecution/requestApproval），诊断用 */
  method?: string;
}

/** 权限应答：二元确认、ACP 的多选项、Claude 的改写入参 */
export type PermissionAnswer =
  | { decision: 'allow' | 'deny' | 'cancel' }
  | { optionId: string }
  | { decision: 'allow'; updatedInput: unknown };

/** 驱动的会话级事件流 */
export type SessionEvent =
  /** turnId 为空 = 轮次之外 */
  /** tail = 进程结束时才解析出的最后一行（不算实时输出） */
  | { kind: 'harness'; event: HarnessEvent; turnId?: string; tail?: boolean }
  | { kind: 'commands'; commands: SlashCommand[] }
  | { kind: 'permission'; id: string; request: PermissionRequest; turnId?: string }
  | {
      kind: 'health';
      state: 'ready' | 'degraded' | 'exited';
      code?: number | null;
      stderrTail?: string;
    };

/**
 * 应答 → 布尔（二元协议用）：null = 取消。选了某个选项时按选项的 kind 判断（allow_* / reject_*），
 * 找不到选项按允许处理（用户主动选的就是这一项）。
 */
export function answerAllows(
  a: PermissionAnswer,
  options: PermissionOption[] = [],
): boolean | null {
  if ('optionId' in a) {
    const kind = options.find((o) => o.id === a.optionId)?.kind ?? '';
    return !/^reject/.test(kind);
  }
  return a.decision === 'cancel' ? null : a.decision === 'allow';
}
