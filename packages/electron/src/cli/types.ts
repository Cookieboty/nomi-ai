/** 编程助手 CLI 接入 · 共享类型 */

export type HarnessBackend = 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini';

/**
 * 编程助手权限模式（Nomi 统一五档，映射见 cli/permissionMode.ts）：
 * 计划（只读）/ 逐项确认 / 自动改文件 / 自动（模型判断）/ 完全放开
 */
export type HarnessPermissionMode = 'plan' | 'manual' | 'acceptEdits' | 'auto' | 'bypass';

export type CliKind = 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini' | 'cursor';

/** 旧版有独立第三方供应商存储的 CLI（迁移 / 撤销旧全局配置时用） */
export type CliProviderKind = 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini';

/** 支持版本更新的 CLI */
export type UpdatableCli = 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini';

export interface CliInstallInfo {
  kind: CliKind;
  path: string | null;
  version: string | null;
  latest: string | null;
  installMethod: 'npm' | 'native' | 'unknown';
  updateAvailable: boolean;
  updateSupported: boolean;
  /** 可在应用内一键安装（未安装时）：Claude Code / Codex / dsh / Grok */
  installSupported?: boolean;
  /** 运行时问题（目前仅 dsh：PATH 上的 Node 低于 24） */
  runtimeWarning?: { nodeVersion: string | null; required: number } | null;
}

export interface HarnessSessionState {
  backend: HarnessBackend;
  cwd: string;
  cliSessionId: string | null;
  busy: boolean;
}

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
}

export interface HarnessSendResult {
  text: string;
  sessionId: string | null;
  events: HarnessEvent[];
  /** 正文分段起点，与 text 一起落盘 */
  textBreaks?: number[];
  /** 本轮轨迹 / 耗时 / 用量（sendTab 填充；IPC 只返回这些，不返回 events） */
  trace?: HarnessTraceEvent[];
  durationMs?: number;
  usage?: HarnessUsage;
}

/** 经 IPC 返回渲染层的发送结果（不含逐条事件） */
export type HarnessSendReply = Omit<HarnessSendResult, 'events'>;

/** 标签运行状态 */
export type HarnessTabStatus = 'idle' | 'queued' | 'running' | 'error';

export interface HarnessTabMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  error?: boolean;
  tools?: string[];
  /** 本轮工具调用 / 思考的结构化轨迹（会话视图据此渲染分组、diff、耗时） */
  trace?: HarnessTraceEvent[];
  /** 助手正文里后一段消息的起始下标 */
  textBreaks?: number[];
  /** 本轮耗时（ms，从发出到结束） */
  durationMs?: number;
  /** 本轮用量（CLI 上报时才有） */
  usage?: HarnessUsage;
  /** 被用户中断 */
  stopped?: true;
  /** CLI 在没有用户消息的情况下自发的一轮（后台子代理完成后主代理的跟进） */
  origin?: 'background';
  /** Gemini 因为不信任这个文件夹而拒绝运行（错误卡片上提供「信任此文件夹」） */
  geminiTrust?: {
    folder: string;
    /** 范围很大的文件夹（主目录、文稿、默认对话目录等），确认时额外提醒 */
    broad?: boolean;
  };
}

/** 持久化到消息里的轨迹事件：HarnessEvent 里的 tool / thinking */
export type HarnessTraceEvent = Extract<HarnessEvent, { type: 'tool' | 'thinking' }>;

/**
 * 对话标签：绑定后端 + CLI 会话 + 工作目录。
 * id 为 'main' 的标签即原有对话（可为 Nomi 或任一 CLI，消息存于 Nomi 历史）；
 * 其它标签只绑定 CLI 后端，消息存于 harness/tabs/<id>.json。
 */
/** 标签来源：官方账号（CLI 自带配置）/ 第三方模型（经 Nomi 统一网关，§4.3） */
export type HarnessTabSource = 'official' | 'thirdParty';

export interface HarnessTabMeta {
  id: string;
  title: string;
  backend: HarnessBackend;
  cwd: string;
  cliSessionId: string | null;
  status: HarnessTabStatus;
  unread: number;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  /** 权限模式（已按后端降级）；「完全放开」不跨重启保留 */
  permissionMode: HarnessPermissionMode;
  /** 历史会话未记录权限时，首次握手从 CLI 当前会话模式同步；同步后清除。 */
  permissionModeSource?: 'history-cli';
  /**
   * 标签级模型覆盖（仅对带模型目录的官方账号后端生效：codex / claude / grok）。
   * null / 缺省 = 沿用 CLI 自己的默认模型；空串清除覆盖。
   * 以进程级参数注入（codex `-c model=` / grok `-m` / claude `--model`），
   * 不改写用户的全局 CLI 配置。
   */
  modelOverride?: string | null;
  /**
   * 标签级思考深度覆盖（仅推理模型；见 modelCatalog.ts）。
   * null = 沿用 CLI 默认档位；切换到非推理模型时由主进程清除。
   */
  reasoningEffort?: string | null;
  /**
   * 上面两项属于哪个模型来源：第三方供应商 id；null / 缺省 = 官方账号（CLI 自带配置）。
   * 换供应商时把当前选择收进 modelByScope、取出新来源上次的选择，模型名不会跨来源发出去。
   */
  modelScope?: string | null;
  /** 其它模型来源下这个标签上次的选择（key：供应商 id，官方账号为 "official"） */
  modelByScope?: Record<string, { model: string | null; effort: string | null }>;
  /** 来源；缺省 = 官方。第三方时 modelOverride 是 `供应商/模型`（null = 「模型」页给这个编程助手分配的） */
  source?: HarnessTabSource;
  /** 仍在运行的后台子代理 / 后台任务数（仅内存、仅广播；> 0 时不回收进程，关闭 / 停止前提示） */
  background?: number;
  /** 仍在运行的后台子代理（仅内存、仅广播）；stoppable = CLI 支持单独停止（Claude stop_task） */
  backgroundAgents?: Array<{ id: string; label?: string; startedAt: number; stoppable: boolean }>;
  /** 长驻 CLI 进程因空闲被回收（仅广播用，不落盘）；下一条消息会 --resume 自动续接 */
  dormant?: boolean;
  /**
   * 换工作目录 / 分叉后待带入新会话的消息条数：下一条消息会连同这段前文一起发给 CLI，
   * 成功一轮后清除。前文本身只在主进程（不广播）。
   */
  carriedMessages?: number;
}

export interface HarnessTabsState {
  tabs: HarnessTabMeta[];
  activeTabId: string;
  maxConcurrent: number;
  running: number;
  queued: number;
  /** 新标签默认权限模式（不会是 bypass） */
  defaultPermissionMode: HarnessPermissionMode;
  /** Codex 在 workspace-write 下允许联网 */
  codexNetwork: boolean;
}

/** 安装 / 更新位置：global = npm 全局目录；user = 用户目录（~/.local，不需要管理员权限） */
export type CliInstallScope = 'global' | 'user';

export interface CliRequirement {
  id: 'node' | 'npm' | 'write';
  ok: boolean;
  label: string;
  detail: string;
}

/** 点「安装 / 更新」确认框里展示的计划：确切命令、前置检查、阻塞原因 */
export interface CliInstallPlan {
  kind: UpdatableCli;
  mode: 'install' | 'update';
  scope: CliInstallScope;
  argv: string[];
  /** 展示用的完整命令行 */
  command: string;
  requirements: CliRequirement[];
  /** 非空表示不能执行（原因已本地化） */
  blockers: string[];
  /** 全局目录没有写权限时，可改用的用户目录方案（不用 sudo） */
  userScopeCommand?: string;
}

export interface CliRunResult {
  ok: boolean;
  log: string;
  version: string | null;
  path?: string | null;
  /** 补充提示（例如装到了 ~/.local/bin 但它不在 PATH 上） */
  note?: string;
}

/** 安装 / 更新任务快照（主进程按端点持有；界面重新挂载时先取它） */
export interface CliJobSnapshot {
  kind: UpdatableCli;
  mode: 'install' | 'update';
  scope: 'global' | 'user';
  status: 'running' | 'done' | 'error';
  argv: string[];
  command: string;
  lines: string[];
  startedAt: number;
  finishedAt?: number;
  result?: CliRunResult;
}
