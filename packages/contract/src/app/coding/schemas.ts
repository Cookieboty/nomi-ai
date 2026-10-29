/**
 * D3 · 编程助手的 DTO schema（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 照主进程 `cli/types.ts`、`@nomi-ai/cli-sdk` 的事件类型与 ai-chat 各客户端模块的接口手写：
 * - 输出与事件的对象都用 `z.looseObject`（字段多、会演进；未知字段原样透传，与原 IPC 一致），
 *   只声明肯定存在的字段；持久化 / CLI 上报的枚举在输出里放宽成字符串；
 * - 视图传来的对象（新建标签选项、要写回的消息）也用 loose：主进程自己做校验与降级；
 * - 只用 JSON 值（时间是毫秒数）。
 */

import { z } from 'zod';

const loose = z.looseObject;

// ---------------------------------------------------------------------------
// harness（cli/harness/Orchestrator.ts、cli/types.ts）
// ---------------------------------------------------------------------------

/** 'nomi' | 内置 CLI id | 'external'；插件 id 会增加，按字符串收 */
export const HarnessBackend = z.string();
export const TabSource = z.enum(['official', 'thirdParty']);
export const PermissionMode = z.string();

export const HarnessState = loose({
  backend: z.string(),
  cwd: z.string(),
  cliSessionId: z.string().nullable(),
  busy: z.boolean(),
});

export const HarnessTabMeta = loose({
  id: z.string(),
  title: z.string(),
  backend: z.string(),
  cwd: z.string(),
  cliSessionId: z.string().nullable(),
  status: z.string(),
  unread: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const HarnessTabsState = loose({
  tabs: z.array(HarnessTabMeta),
  activeTabId: z.string(),
  running: z.number(),
  queued: z.number(),
  /** 新标签默认权限模式（不会是「完全放开」） */
  defaultPermissionMode: z.string().optional(),
  /** Codex 在自动改文件档允许联网 */
  codexNetwork: z.boolean().optional(),
  /**
   * 「全部自动」（默认开）：新标签与 Nomi 委派的编程助手默认完全放开，
   * Nomi 对话工作区里的文件 / 命令操作不确认；关掉后回到逐项询问
   */
  autoApprove: z.boolean().optional(),
});

/** 标签消息（cli-sdk HarnessTabMessage）：视图写回（seed / createTab）时也用它 */
export const HarnessTabMessage = loose({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  timestamp: z.number(),
});

export const HarnessImageInput = loose({
  mime: z.string(),
  data: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumb: z.string().optional(),
  source: z.string().optional(),
});

/** 经 IPC 返回的发送结果（不含逐条事件） */
export const HarnessSendReply = loose({
  text: z.string(),
  sessionId: z.string().nullable(),
});

/** 实时事件（按帧合批；相邻 text-delta 已拼接） */
export const HarnessLiveEvent = loose({ tabId: z.string(), type: z.string() });

export const BackendModelCatalog = loose({
  backend: z.string(),
  models: z.array(loose({ id: z.string() })),
});

export const SlashDiscoveryResult = loose({
  backend: z.string(),
  entries: z.array(loose({ id: z.string(), name: z.string() })),
  supported: z.boolean(),
});

export const SlashExpansion = loose({ text: z.string(), shellInjection: z.boolean() });

export const GitDiffResult = loose({
  ok: z.boolean(),
  status: z.string(),
  stat: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});

export const GitBranchResult = loose({ branch: z.string().nullable() });

/** 右栏「改动」写操作的结果；失败原因在 code（busy / auth / no-model …） */
export const GitOpResult = loose({ ok: z.boolean(), code: z.string().optional() });

export const GitSyncStatus = loose({
  branch: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  remotes: z.array(z.string()),
});

export const GitWorktreeList = loose({
  linked: z.boolean(),
  worktrees: z.array(loose({ path: z.string() })),
});

export const WorkspaceFileResult = loose({ ok: z.boolean(), code: z.string().optional() });
export const WorkspaceTreeResult = loose({ ok: z.boolean(), code: z.string().optional() });

export const TabContext = loose({ contextTokens: z.number() });

export const GeminiTrustResult = loose({
  folder: z.string(),
  file: z.string(),
  previous: z.string().nullable(),
});

export const ApprovePlanChoice = z.enum(['acceptEdits', 'manual', 'deny']);

// ---------------------------------------------------------------------------
// cli：插件注册表与外部插件（cli/CliPluginHost.ts）
// ---------------------------------------------------------------------------

/** 外部插件清单（cli-sdk ExternalCliSpec）；主进程自己校验，校验失败按 `{ ok: false, errors }` 返回 */
export const ExternalCliSpec = loose({});

export const CliRegistryEntry = loose({
  id: z.string(),
  displayName: z.string(),
  builtin: z.boolean(),
  status: z.string(),
  errors: z.array(z.string()),
  version: z.string().nullable(),
});

export const CliRegistrySnapshot = loose({ plugins: z.array(CliRegistryEntry) });

export const CliPluginAddResult = z.union([
  loose({ ok: z.literal(true), entry: CliRegistryEntry }),
  loose({ ok: z.literal(false), errors: z.array(z.string()) }),
]);

export const ExternalTestResult = z.union([
  loose({ ok: z.literal(true) }),
  loose({ ok: z.literal(false), errors: z.array(z.string()) }),
]);

// ---------------------------------------------------------------------------
// cliAccount：官方账号与登录（cli/accounts/AccountService.ts、AccountLogin.ts）
// ---------------------------------------------------------------------------

export const CliAccount = loose({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  active: z.boolean(),
  local: z.boolean(),
  loggedIn: z.boolean(),
  inUse: z.number(),
  createdAt: z.number(),
});

export const LoginEvent = loose({ id: z.string(), kind: z.string(), state: z.string() });

// ---------------------------------------------------------------------------
// cliUpdate：CLI 安装 / 更新（cli/CliUpdateService.ts）
// ---------------------------------------------------------------------------

export const CliInstallScope = z.enum(['global', 'user']);

export const CliInstallInfo = loose({
  kind: z.string(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  updateSupported: z.boolean(),
});

export const CliInstallPlan = loose({
  kind: z.string(),
  mode: z.string(),
  scope: z.string(),
  argv: z.array(z.string()),
  command: z.string(),
  blockers: z.array(z.string()),
});

export const CliRunResult = loose({
  ok: z.boolean(),
  log: z.string(),
  version: z.string().nullable(),
});

export const CliJob = loose({
  kind: z.string(),
  status: z.string(),
  lines: z.array(z.string()),
  startedAt: z.number(),
});

export const CliUpdateEvent = loose({ kind: z.string(), phase: z.string() });

// ---------------------------------------------------------------------------
// delegate：Nomi 把编程助手当子代理（cli/delegate/DelegateService.ts）
// ---------------------------------------------------------------------------

export const DelegateSettings = loose({
  enabled: z.boolean(),
  defaults: z.record(z.string(), z.string()),
});

export const DelegateSettingsView = loose({
  enabled: z.boolean(),
  defaults: z.record(z.string(), z.string()),
  installed: z.array(z.string()),
  pinned: z.string().nullable(),
});

export const DelegateResult = loose({
  taskId: z.string(),
  cli: z.string(),
  status: z.string(),
  summary: z.string(),
});

// ---------------------------------------------------------------------------
// agents：编程助手进度监视（agents/AgentProgressService.ts）
// ---------------------------------------------------------------------------

export const AgentWatchSettings = loose({
  enabled: z.boolean(),
  stallMs: z.number(),
  cooldownMs: z.number(),
  tools: z.record(z.string(), z.boolean()),
});

export const AgentWatchState = loose({
  settings: AgentWatchSettings,
  sessions: z.array(loose({ id: z.string(), kind: z.string(), status: z.string() })),
  detected: z.array(z.string()),
  lastRemindAt: z.number(),
});

/** 设置补丁：只写给出的字段（tools 按项合并） */
export const AgentWatchSettingsPatch = z.looseObject({
  enabled: z.boolean().optional(),
  stallMs: z.number().optional(),
  cooldownMs: z.number().optional(),
  summaryEnabled: z.boolean().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
});

// ---------------------------------------------------------------------------
// history：CLI 自己的会话记录（cli/SessionHistoryService.ts）
// ---------------------------------------------------------------------------

export const HistoryPageOptions = z.object({
  offset: z.number().optional(),
  limit: z.number().optional(),
  force: z.boolean().optional(),
});

export const HistoryPage = loose({
  items: z.array(loose({ key: z.string(), backend: z.string(), sessionId: z.string() })),
  nextOffset: z.number().nullable(),
  hasMore: z.boolean(),
});

export const HistoryOpenResult = loose({ ok: z.boolean() });
export const HistoryDeleteResult = loose({ ok: z.boolean() });
