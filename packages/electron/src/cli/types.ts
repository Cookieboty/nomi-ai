/** 编程助手 CLI 接入 · 共享类型 */
import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
import type {
  HarnessEvent,
  HarnessPermissionMode,
  HarnessTraceEvent,
  HarnessUsage,
} from '@nomi-ai/cli-sdk';

/** 对话后端：Nomi 自己 + 内置编程助手（id 由 @nomi-ai/cli-plugins 按插件目录生成，P9.4） */
export type HarnessBackend = 'nomi' | BuiltinCliId | 'external';

/**
 * 编程助手权限模式（Nomi 统一五档，映射见 cli/permissionMode.ts）：
 * 计划（只读）/ 逐项确认 / 自动改文件 / 自动（模型判断）/ 完全放开
 */
export type { HarnessPermissionMode } from '@nomi-ai/cli-sdk';

export type CliKind = BuiltinCliId | 'cursor';

/** 旧版有独立第三方供应商存储的 CLI（迁移 / 撤销旧全局配置时用） */
export type CliProviderKind = BuiltinCliId;

/** 支持版本更新的 CLI */
export type UpdatableCli = BuiltinCliId;

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

// 一轮的界面事件与用量：定义搬到 @nomi-ai/cli-sdk（驱动与插件共用，docs/design/cli-plugin-architecture.md §5.4）
export type { HarnessEvent, HarnessUsage } from '@nomi-ai/cli-sdk';

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

/** 渲染层 → 主进程的用户附图（base64，不含 data: 前缀） */
export interface HarnessImageInput {
  mime: string;
  data: string;
  width?: number;
  height?: number;
  thumb?: string;
  source?: string;
}

// 标签消息与轨迹事件：定义搬到 @nomi-ai/cli-sdk（插件的历史转录解析也用）
export type { HarnessTabMessage, HarnessTraceEvent } from '@nomi-ai/cli-sdk';

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
  /**
   * backend 为 'external' 时：用哪个外部插件（「设置 → 编程助手 → 添加 CLI」里的 id，§5.9）。
   * 插件被删除后标签保留，发消息时报错。
   */
  pluginId?: string;
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
  /**
   * 官方来源下用哪个官方账号（docs/design/cli-plugin-architecture.md §5.10）：账号 id；
   * null / 缺省 = 跟随默认账号。账号被删除后自动回到默认账号。
   */
  accountId?: string | null;
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
