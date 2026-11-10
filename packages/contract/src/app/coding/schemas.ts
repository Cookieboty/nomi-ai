/**
 * D3 · 编程助手的 DTO schema（docs/development/architecture.md「P1b 实施约定」）。
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
  /** 工作目录：项目的主文件夹（委派开的 worktree 标签是 worktree） */
  cwd: z.string(),
  /** 标签所在的项目 */
  projectId: z.string().optional(),
  cliSessionId: z.string().nullable(),
  status: z.string(),
  unread: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * 沙箱挡下、等用户授权的项（不落盘）：kind = category（按类别读写）/ folder / file（写入）/
   * protected（受保护文件夹，只能去设置里取消保护）；回答用 harness.sandboxReply
   */
  sandboxPending: z
    .array(
      z.looseObject({
        id: z.string(),
        kind: z.enum(['category', 'read', 'folder', 'file', 'protected']),
        value: z.string(),
        op: z.enum(['read', 'write']),
        path: z.string(),
        at: z.number(),
      }),
    )
    .optional(),
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
  /** 编程助手的系统沙箱：on / off（用户关了）/ unsupported（当前平台不支持） */
  sandbox: z.enum(['on', 'off', 'unsupported']).optional(),
  /**
   * 「全部自动」（默认开）：新标签与 Nomi 委派的编程助手默认完全放开，
   * Nomi 对话工作区里的文件 / 命令操作不确认；关掉后回到逐项询问
   */
  autoApprove: z.boolean().optional(),
  /** 命令自动审核（Nomi 跑命令前先让辅助模型判风险，低风险直接放行）；缺省 = 开 */
  aiReview: z.boolean().optional(),
  /** Nomi 工作区文件操作免确认；缺省 = 跟随 autoApprove */
  nomiAutoApprove: z.boolean().optional(),
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
  /** 原图存进素材库后的 chat-asset 地址（气泡预览用） */
  url: z.string().optional(),
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
  /** 仓库根目录（项目里多个文件夹同属一个仓库时，右栏按它合成一段） */
  gitRoot: z.string().optional(),
});

export const GitBranchResult = loose({ branch: z.string().nullable() });

/** 本地分支（按最近提交倒序，最多 200 个）；游离 HEAD 时 current 为 null、detached 是短提交号 */
export const GitBranchList = loose({
  current: z.string().nullable(),
  detached: z.string().optional(),
  branches: z.array(z.string()),
});

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

// ---------------------------------------------------------------------------
// 项目（core/projects）：有名字的一组文件夹，会话只引用 projectId，目录由内核实时解析
// ---------------------------------------------------------------------------

/**
 * 项目。primary 是主文件夹：会话的工作目录、相对路径的基准、git / worktree / AGENTS.md 的来源；
 * folders 是其余文件夹（顺序即显示顺序，不含 primary），Nomi 与编程助手在里面同样能读写。
 * missing：此刻不存在或不再允许当项目目录的文件夹（内核每次列出时重新检查），视图标红。
 */
export const Project = loose({
  id: z.string(),
  name: z.string(),
  primary: z.string(),
  folders: z.array(z.string()),
  missing: z.array(z.string()).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/** 新建项目：primary 必填，其余文件夹可选；name 为空时用主文件夹的目录名 */
export const ProjectCreateInput = z.object({
  name: z.string().optional(),
  primary: z.string(),
  folders: z.array(z.string()).optional(),
});

/** 编辑项目：给了哪项改哪项；folders 是完整的新列表（不含 primary） */
export const ProjectUpdateInput = z.object({
  id: z.string(),
  name: z.string().optional(),
  primary: z.string().optional(),
  folders: z.array(z.string()).optional(),
});

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

export const CliNetworkState = loose({
  useShellProxy: z.boolean(),
  shellProxy: z.string().nullable(),
});

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

/** 安装 / 更新编程助手所需的运行环境：PATH 上的 Node.js / npm，每个 CLI 的最低 Node 主版本与是否满足 */
export const CliEnvironment = loose({
  nodeVersion: z.string().nullable(),
  nodePath: z.string().nullable(),
  npmPath: z.string().nullable(),
  requirements: z.array(loose({ kind: z.string(), minNode: z.number(), ok: z.boolean() })),
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
  /** 委派结束后在子任务里接着跑的一轮（用户接着对话 / 沙箱授权后续跑）的结果，同样回到来源对话 */
  followUp: z.boolean().optional(),
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
// fleet：Agent 看板（core/fleet）。Nomi 自己、Nomi 派出的 / 工坊里的 CLI（纳管，可暂停），
// 用户在自己终端 / IDE 里开的 CLI（外部，只预警，不干扰）
// ---------------------------------------------------------------------------

/** 看板分列：待进行 / 暂停 / 进行中 / 已完成（不保留历史：已完成的归档后不再出现） */
export const FleetColumn = z.enum(['todo', 'paused', 'running', 'done']);

/** managed = 在 Nomi 里跑的，可以暂停；external = Nomi 之外启动的，只能预警 */
export const FleetScope = z.enum(['managed', 'external']);

/**
 * 来源：chat = 正在回答的 Nomi 对话；nomi = Nomi 的后台运行（agent）；conversation = 对话里委派的 CLI；
 * task = 任务看板派的 CLI；workbench = 工坊里直接用的 CLI；terminal = 用户自己在终端 / IDE 里开的
 */
export const FleetOrigin = z.enum([
  'chat',
  'nomi',
  'conversation',
  'task',
  'workbench',
  'terminal',
]);

/** 需要用户处理：permission 等授权 / sandbox 沙箱拦下 / accept 等验收 */
export const FleetNeedsYou = z.enum(['permission', 'sandbox', 'accept']);

/** 进程树的资源占用（整棵树：编程助手连同它起的子进程）；cpuPercent 100 = 占满一个核，第一次采样为 0 */
export const FleetUsage = loose({
  rssBytes: z.number(),
  cpuPercent: z.number(),
  processes: z.number(),
});

export const FleetAgent = loose({
  /** 'chat:<对话 id>' | 'tab:<标签 id>' | 'run:<任务 id>' | 'ext:<外部会话 id>' */
  id: z.string(),
  kind: z.enum(['nomi', 'cli']),
  /** nomi | claude | codex | gemini | dsh | grok | external（插件）… */
  backend: z.string(),
  scope: FleetScope,
  origin: FleetOrigin,
  /** 标签 / 任务标题；Nomi 本体与外部 CLI 为空，视图自己写 */
  title: z.string(),
  column: FleetColumn,
  needsYou: FleetNeedsYou.optional(),
  /** 上一轮出错（已完成列里标红） */
  failed: z.boolean().optional(),
  /** 调度树的上一级（预留：Nomi 后台运行派出的 CLI 指向那次运行） */
  parentId: z.string().optional(),
  taskId: z.string().optional(),
  tabId: z.string().optional(),
  conversationId: z.string().optional(),
  cwd: z.string().optional(),
  /** 量不到时没有（Nomi 后台运行跑在内核进程里，单独的内存量不出来） */
  usage: FleetUsage.optional(),
  updatedAt: z.number(),
  /** 暂停中（已暂停列）：by = memory 内存守护自动暂停 / user 手动暂停 / nomi Nomi 用 pause_agent 暂停；at = 暂停时间 */
  paused: loose({ by: z.enum(['memory', 'user', 'nomi']), at: z.number() }).optional(),
  /** 可以手动暂停：纳管、正在跑、有活着的进程、没在等审批的 CLI 标签 */
  pausable: z.boolean().optional(),
  /** 做完时的总结（标签最后一条回复、任务结果摘要、外部会话摘要），只给已完成的，最多 300 字 */
  summary: z.string().optional(),
  /**
   * 在待进行里为什么还没开始：memory 内存紧张被扣着（缓解后自动开始）/ cpu 「全速」调度策略下整机 CPU 太忙 / slot 等前面的任务（并发名额满或
   * 每小时启动次数到了）/ retry 上次失败、等重试（retryAt 毫秒）
   */
  queueReason: z.enum(['memory', 'cpu', 'slot', 'retry']).optional(),
  retryAt: z.number().optional(),
});

export const FleetSystem = loose({
  totalMemBytes: z.number(),
  cores: z.number(),
  /** 整机 CPU 占用：0–100，占全部核的比例（同活动监视器的「系统 + 用户」）；各 agent 的 cpuPercent 是 100 = 一个核 */
  cpuPercent: z.number(),
  /** 系统内存压力（macOS 取系统给的等级；Linux / Windows 按可用内存与 PSI 划） */
  pressure: z.enum(['normal', 'warn', 'critical', 'unknown']),
  /** 可用内存比例（0–100），读不到时没有 */
  availablePercent: z.number().optional(),
});

/**
 * 内存守护：autoPause = 内存紧张时自动处理（告警：回收空闲标签的进程；危险：暂停正在跑的标签，恢复正常后一个个恢复）；
 * last = 最近一次动作（reclaimed 回收 / paused 暂停 / resumed 恢复）
 */
export const FleetGovernor = loose({
  autoPause: z.boolean(),
  last: loose({
    kind: z.enum(['reclaimed', 'paused', 'resumed']),
    id: z.string().optional(),
    count: z.number().optional(),
    at: z.number(),
  }).optional(),
});

/**
 * 调度策略：Nomi 同时派出去跑的编程助手 / 后台任务的上限（用户在看板里选，存盘）。saver 省资源 / balanced 均衡（默认）/
 * max 全速；maxParallel = 委派与持续任务各自同时运行的上限，超出的排队；0 = 不设上限，按 CPU 与内存放行
 * （内存偏高或整机 CPU 很忙时新的排队，queueReason: memory / cpu）。
 */
export const FleetPolicyMode = z.enum(['saver', 'balanced', 'max']);
export const FleetPolicy = loose({
  mode: FleetPolicyMode,
  maxParallel: z.number(),
});

/** Nomi 本体（调度者）：不进分列，只给资源占用（自己的进程树减去各标签的树） */
export const FleetNomi = loose({ usage: FleetUsage.optional() });

/** Nomi 之外、对不上正在跑的会话的编程助手进程树（空闲的终端 / IDE 里的助手），按内存大的在前；用户可以手动关掉 */
export const FleetIdleItem = loose({
  pid: z.number(),
  backend: z.string(),
  cwd: z.string().optional(),
  processes: z.number(),
  rssBytes: z.number(),
  cpuPercent: z.number(),
});

export const FleetExternalIdle = loose({
  processes: z.number(),
  rssBytes: z.number(),
  items: z.array(FleetIdleItem),
});

export const FleetState = loose({
  /** 正在回答的 Nomi 对话、纳管的 agent 与外部会话；Nomi 本体不在这里 */
  agents: z.array(FleetAgent),
  nomi: FleetNomi,
  externalIdle: FleetExternalIdle,
  system: FleetSystem,
  governor: FleetGovernor,
  policy: FleetPolicy,
  /** 可选的几档（视图照着列） */
  policyOptions: z.array(FleetPolicy),
  /** 这份数据的采样时间（毫秒） */
  sampledAt: z.number(),
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
