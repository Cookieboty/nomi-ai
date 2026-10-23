import { t } from '@nomi-ai/ui';

import type { PermissionMode } from '../utils/permissionModes';

export type HarnessBackend = 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini';

export interface HarnessState {
  backend: HarnessBackend;
  cwd: string;
  cliSessionId: string | null;
  busy: boolean;
  toolsDisabled: boolean;
  bins: Record<string, string | null>;
}

export type HarnessTabStatus = 'idle' | 'queued' | 'running' | 'error';

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
  /** 编程助手进程因空闲被回收；下一条消息会自动续接会话 */
  dormant?: boolean;
  /** 换工作目录 / 分叉后，下一条消息会连同这么多条之前的对话一起发给新会话 */
  carriedMessages?: number;
  /** 权限模式（主进程已按后端降级）；「完全放开」不跨重启保留 */
  permissionMode?: PermissionMode;
  /**
   * 标签的来源（docs/design/unified-gateway.md §4.3）：官方账号 / 第三方（经网关）；缺省 = 官方。
   * 切换走 setTabSource，规则由主进程执行（空标签直接切；官方 → 第三方续接；第三方 → 官方带上下文新开）。
   */
  source?: TabSource;
  /**
   * 标签级模型覆盖。官方来源：CLI 的模型 id，null/缺省 = 沿用 CLI 默认模型（进程级参数注入，不改全局配置）；
   * 第三方来源：网关的 `供应商/模型`，null = 这个 CLI 在「模型」页分配的默认模型。
   */
  modelOverride?: string | null;
  /** 标签级思考深度覆盖（仅推理模型）；null = 沿用 CLI 默认档位 */
  reasoningEffort?: string | null;
  /** 仍在运行的后台子代理 / 后台任务数 */
  background?: number;
  /** 仍在运行的后台子代理；stoppable = 可以单独停止（Claude） */
  backgroundAgents?: Array<{ id: string; label?: string; startedAt: number; stoppable: boolean }>;
}

export interface HarnessTabsState {
  tabs: HarnessTabMeta[];
  activeTabId: string;
  maxConcurrent: number;
  running: number;
  queued: number;
  /** 新标签默认权限模式（不会是「完全放开」） */
  defaultPermissionMode?: PermissionMode;
  /** Codex 在自动改文件档允许联网 */
  codexNetwork?: boolean;
}

export interface HarnessImageInput {
  mime: string;
  data: string;
  width?: number;
  height?: number;
  thumb?: string;
  source?: string;
}

export interface HarnessTabMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 用户附图缩略图 */
  images?: Array<{ thumb: string; width: number; height: number; source?: string }>;
  timestamp: number;
  error?: boolean;
  tools?: string[];
  /** 本轮工具调用 / 思考的结构化轨迹 */
  trace?: HarnessTraceEvent[];
  /** 助手正文里后一段消息的起始下标 */
  textBreaks?: number[];
  durationMs?: number;
  usage?: HarnessUsage;
  stopped?: true;
  /** CLI 自发的一轮（后台子代理完成后主代理的跟进） */
  origin?: 'background';
  /** Gemini 不信任这个文件夹（错误卡片上提供「信任此文件夹」） */
  geminiTrust?: { folder: string; broad?: boolean };
}

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/** 工具调用 / 思考事件（主进程 stampEvent 带 at 时间戳；detail 为调用 id，codex 为命令行） */
export type HarnessTraceEvent =
  | {
      type: 'tool';
      name: string;
      status: 'start' | 'done' | 'error';
      detail?: string;
      id?: string;
      input?: string;
      output?: string;
      parentId?: string;
      at?: number;
      /** 事件发生时助手正文的字符下标 */
      textAt?: number;
    }
  | { type: 'thinking'; text: string; at?: number; textAt?: number };

export type HarnessLiveEvent =
  | { tabId: string; type: 'text-delta' | 'text'; text: string }
  | ({ tabId: string } & Extract<HarnessTraceEvent, { type: 'tool' }>)
  | ({ tabId: string } & Extract<HarnessTraceEvent, { type: 'thinking' }>)
  | {
      tabId: string;
      type: 'status';
      kind: 'retry' | 'reconnect' | 'compact' | 'clear';
      text?: string;
      attempt?: number;
      max?: number;
    }
  | { tabId: string; type: 'done'; text: string; sessionId?: string; usage?: HarnessUsage }
  | { tabId: string; type: 'error'; message: string }
  | {
      tabId: string;
      type: 'permission';
      id: string;
      summary: string;
      toolUseId?: string;
      /** 发起请求的子代理（描述）；主代理自己的请求没有 */
      agent?: string;
      /** 超时自动拒绝的时间点（ms） */
      expiresAt?: number;
    }
  | ({ tabId: string } & LiveAgentEvent)
  | {
      tabId: string;
      type: 'permission-resolved';
      id: string;
      reason: 'allowed' | 'denied' | 'timeout';
    };

/** 子代理生命周期（主进程统一的 agent 事件，见 docs/design/cli-subagents.md §3） */
export interface LiveAgentEvent {
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

export const MAIN_TAB_ID = 'main';

/** CLI 标签的来源：官方账号（CLI 直连）/ 第三方（经网关） */
export type TabSource = 'official' | 'thirdParty';

/** 思考深度档位（官方枚举并集，由浅到深；不含 ultra）；某个模型支持哪些以 CLI 返回的目录为准 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 从 CLI 读到的可选模型 */
export interface ModelCatalogModel {
  /** 传给 CLI 的模型值 */
  id: string;
  label?: string;
  description?: string;
  /** CLI 声明支持思考深度 */
  reasoning: boolean;
  efforts: ReasoningEffort[];
  /** CLI 对该模型的默认档位（仅显示） */
  defaultEffort?: ReasoningEffort;
}
/** 主进程从 CLI 读到的模型目录（不写死） */
export interface BackendModelCatalog {
  backend: HarnessBackend;
  models: ModelCatalogModel[];
  /** 不传模型参数时 CLI 实际使用的模型（CLI 能告诉我们时才有） */
  defaultModel: ModelCatalogModel | null;
  /** CLI 返回的原生安全模式 id；缺省时由兼容层提供默认集合。 */
  permissionModes?: string[];
  /** 读取失败的原因（此时 models 为空） */
  error?: string;
  /** 目录来自第三方（网关的模型，id 是 `供应商/模型`；没有思考深度） */
  provider?: { id: string; name: string };
}

export interface HarnessSendResult {
  text: string;
  sessionId: string | null;
  /** 本轮轨迹 / 耗时 / 用量（主进程 sendTab 填充） */
  trace?: HarnessTraceEvent[];
  durationMs?: number;
  usage?: HarnessUsage;
}

interface AiBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  on: (channel: string, fn: (payload: unknown) => void) => () => void;
}
const bridge = (): AiBridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const b = (window as unknown as { aiIPC?: AiBridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};

async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bridge();
  if (!b) throw new Error(t('编程助手接入需要在桌面应用中使用'));
  const r = (await b.invoke(`ai:harness:${method}`, ...args)) as T & {
    __error?: { message: string };
  };
  if (r && typeof r === 'object' && '__error' in r && r.__error) throw new Error(r.__error.message);
  return r;
}

/** 斜杠命令 / skill / 插件的只读发现结果（主进程只读文件名与 frontmatter；见 cli/slashDiscovery） */
export interface SlashDiscoveryEntry {
  id: string;
  name: string;
  kind: 'command' | 'skill' | 'agent' | 'plugin' | 'mcp';
  scope: 'project' | 'user' | 'plugin' | 'bundled';
  description: string;
  argumentHint?: string;
  userInvocable: boolean;
  plugin?: string;
  /** 相对项目 / 用户目录的位置，用于展示（不含绝对路径） */
  where: string;
  transport?: string;
}
export interface SlashDiscoveryResult {
  backend: string;
  entries: SlashDiscoveryEntry[];
  supported: boolean;
}
export interface SlashExpansion {
  text: string;
  /** 模板里含 !`cmd` 动态注入：Nomi 不执行，原样保留并提示 */
  shellInjection: boolean;
}
export interface GitDiffResult {
  ok: boolean;
  status: string;
  stat: string;
  diff: string;
  truncated: boolean;
  error?: string;
}
export interface WorkspaceFileResult {
  ok: boolean;
  path?: string;
  rel?: string;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
  size?: number;
  mtimeMs?: number;
  error?: string;
  code?: 'outside' | 'not-found' | 'is-dir' | 'too-large' | 'io' | 'invalid' | 'not-git';
}

export interface WorkspaceTreeNode {
  kind: 'file' | 'dir';
  name: string;
  path: string;
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceTreeResult {
  ok: boolean;
  entries?: WorkspaceTreeNode[];
  truncated?: boolean;
  error?: string;
  code?: WorkspaceFileResult['code'] | 'too-many';
}

export const harnessClient = {
  available: () => !!bridge(),
  state: () => call<HarnessState>('state'),
  slashDiscover: (backend: string, cwd: string) =>
    call<SlashDiscoveryResult>('slash-discover', backend, cwd),
  slashExpand: (backend: string, cwd: string, id: string, args: string) =>
    call<SlashExpansion | null>('slash-expand', backend, cwd, id, args),
  gitDiff: (cwd: string) => call<GitDiffResult>('git-diff', cwd),
  workspaceRead: (cwd: string, filePath: string) =>
    call<WorkspaceFileResult>('workspace-read', cwd, filePath),
  workspaceWrite: (cwd: string, filePath: string, content: string) =>
    call<WorkspaceFileResult>('workspace-write', cwd, filePath, content),
  workspaceDelete: (cwd: string, filePath: string) =>
    call<WorkspaceFileResult>('workspace-delete', cwd, filePath),
  workspaceGitCheckout: (cwd: string, filePath: string) =>
    call<WorkspaceFileResult>('workspace-git-checkout', cwd, filePath),
  workspaceList: (cwd: string) => call<WorkspaceTreeResult>('workspace-list', cwd),
  setBackend: (b: HarnessBackend) => call<HarnessState>('set-backend', b),
  /** carry=true：把当前对话作为前文带进新目录的新会话 */
  setCwd: (c: string, opts: { carry?: boolean } = {}) => call<HarnessState>('set-cwd', c, opts),
  pickCwd: () => call<HarnessState>('pick-cwd'),
  send: (prompt: string) => call<HarnessSendResult>('send', prompt),
  onChanged: (fn: (s: HarnessState) => void) =>
    bridge()?.on('ai:harness:changed', (p) => fn(p as HarnessState)) ?? (() => undefined),
  onEvent: (fn: (e: unknown) => void) => bridge()?.on('ai:harness:event', fn) ?? (() => undefined),
  /** 主进程按帧合批后的实时事件（相邻 text-delta 已拼接） */
  onEvents: (fn: (batch: unknown[]) => void) =>
    bridge()?.on('ai:harness:events', (p) => {
      if (Array.isArray(p)) fn(p);
    }) ?? (() => undefined),
  tabs: () => call<HarnessTabsState>('tabs'),
  createTab: (o: {
    backend: HarnessBackend;
    cwd?: string;
    title?: string;
    messages?: HarnessTabMessage[];
  }) => call<HarnessTabMeta>('tab-create', o),
  seedTabMessages: (id: string, messages: HarnessTabMessage[]) =>
    call<HarnessTabMeta>('tab-seed', id, messages),
  closeTab: (id: string) => call<HarnessTabsState>('tab-close', id),
  renameTab: (id: string, title: string) => call<HarnessTabMeta>('tab-rename', id, title),
  /** 切换标签权限模式；「完全放开」必须带 confirmed（界面先弹确认框）。degraded = 后端不支持、已降级 */
  /** expect：「完全放开」确认时的标签后端 / 目录；主进程核对不一致则拒绝（确认不能漂移到别处） */
  setTabPermissionMode: (
    id: string,
    mode: PermissionMode,
    opts: { confirmed?: boolean; expect?: { backend: HarnessBackend; cwd: string } } = {},
  ) => call<HarnessTabMeta & { degraded?: boolean }>('tab-permission-mode', id, mode, opts),
  setPermissionDefaults: (o: { defaultPermissionMode?: PermissionMode; codexNetwork?: boolean }) =>
    call<HarnessTabsState>('permission-defaults', o),
  /**
   * 模型目录：官方来源从 CLI 读（主进程缓存），第三方来源（source: 'thirdParty'）是网关里能给编程助手用的模型；
   * 不支持切换模型的后端返回 null；refresh 强制重读
   */
  modelCatalog: (backend: HarnessBackend, opts: { refresh?: boolean; source?: TabSource } = {}) =>
    call<BackendModelCatalog | null>('model-catalog', backend, opts),
  /** 切换标签来源；第三方时 model 是网关的 `供应商/模型`（省略 = 这个 CLI 分配的默认模型） */
  setTabSource: (id: string, source: TabSource, model?: string) =>
    call<HarnessTabMeta>('tab-source', id, source, ...(model ? [model] : [])),
  /** 设置标签模型覆盖；传空串清除（沿用 CLI 默认模型），非推理模型会同步清除思考深度 */
  /** expectSource：选模型时看到的目录来源；主进程发现标签来源已变就拒绝（#83） */
  setTabModel: (id: string, model: string, opts: { expectSource?: TabSource } = {}) =>
    call<HarnessTabMeta>('tab-model', id, model, opts),
  /** 设置标签思考深度；传 null 清除（沿用 CLI 默认档位） */
  setTabEffort: (id: string, effort: ReasoningEffort | null) =>
    call<HarnessTabMeta>('tab-effort', id, effort),
  activateTab: (id: string) => call<HarnessTabsState>('tab-activate', id),
  setTabBackend: (id: string, b: HarnessBackend) => call<HarnessTabMeta>('tab-backend', id, b),
  setTabCwd: (id: string, cwd: string, opts: { carry?: boolean } = {}) =>
    call<HarnessTabMeta>('tab-cwd', id, cwd, opts),
  clearTabCarry: (id: string) => call<HarnessTabMeta>('tab-carry-clear', id),
  /** 原生文件夹选择器（不绑定标签）；取消返回 null */
  pickDir: (defaultPath?: string) => call<string | null>('pick-dir', defaultPath),
  recentCwds: () => call<string[]>('recent-cwds'),
  pickTabCwd: (id: string) => call<HarnessTabMeta>('tab-pick-cwd', id),
  tabMessages: (id: string) => call<HarnessTabMessage[]>('tab-messages', id),
  sendTab: (id: string, prompt: string, images?: HarnessImageInput[]) =>
    call<HarnessSendResult>('tab-send', id, prompt, images),
  cancelTab: (id: string) => call<boolean>('tab-cancel', id),
  /** 单独停止一个后台子代理（Claude stop_task）；不支持时返回 false */
  stopAgent: (tabId: string, agentId: string) => call<boolean>('stop-agent', tabId, agentId),
  setMaxConcurrent: (n: number) => call<HarnessTabsState>('set-max-concurrent', n),
  /**
   * 用户确认后，把这条错误消息记录的文件夹（只此一个）加入 Gemini 的受信任文件夹列表。
   * 文件夹由主进程按消息查出，界面不传路径。
   */
  trustGeminiFolder: (tabId: string, messageId: string) =>
    call<{ folder: string; file: string; previous: string | null }>(
      'gemini-trust-folder',
      tabId,
      messageId,
      { confirmed: true },
    ),
  /** 允许/拒绝 Claude 工具权限请求 */
  replyPermission: (tabId: string, requestId: string, allow: boolean) =>
    call<boolean>('reply-permission', tabId, requestId, allow),
  onTabs: (fn: (s: HarnessTabsState) => void) =>
    bridge()?.on('ai:harness:tabs', (p) => fn(p as HarnessTabsState)) ?? (() => undefined),
  onTabMessage: (fn: (e: { tabId: string; message: HarnessTabMessage }) => void) =>
    bridge()?.on('ai:harness:tab-message', (p) =>
      fn(p as { tabId: string; message: HarnessTabMessage }),
    ) ?? (() => undefined),
};
