/**
 * D3 · 编程助手（docs/development/architecture.md）。
 *
 * 本文件只属于 D3：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：harness、cli、cliAccount、cliUpdate、delegate、agents、history（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:harness:*`（cli/harness/Orchestrator.ts + rendererSubscribers.ts）
 * - `ai:cli:*`（CliPluginHost）、`ai:cli-account:*`（AccountService / AccountLogin）、`ai:cli-update:*`
 * - `ai:delegate:*`、`ai:agents:*`、`ai:history:*`
 *
 * 约定见设计稿「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。旧通道都在 `window.aiIPC` 上（两个窗口都有），所以不写 surfaces。
 */

import { z } from 'zod';

import type { EventMap, ProcedureMap, Surface } from '../contract';

import {
  AgentWatchSettings,
  AgentWatchSettingsPatch,
  AgentWatchState,
  FleetState,
  ApprovePlanChoice,
  BackendModelCatalog,
  CliAccount,
  CliEnvironment,
  CliInstallInfo,
  CliInstallPlan,
  CliInstallScope,
  CliJob,
  CliPluginAddResult,
  CliRegistrySnapshot,
  CliRunResult,
  CliUpdateEvent,
  DelegateResult,
  DelegateSettings,
  DelegateSettingsView,
  ExternalCliSpec,
  ExternalTestResult,
  GeminiTrustResult,
  GitBranchList,
  GitBranchResult,
  GitDiffResult,
  GitOpResult,
  GitSyncStatus,
  GitWorktreeList,
  HarnessBackend,
  HarnessImageInput,
  HarnessLiveEvent,
  HarnessSendReply,
  HarnessState,
  HarnessTabMessage,
  HarnessTabMeta,
  HarnessTabsState,
  HistoryDeleteResult,
  HistoryOpenResult,
  HistoryPage,
  HistoryPageOptions,
  LoginEvent,
  PermissionMode,
  SlashDiscoveryResult,
  SlashExpansion,
  TabContext,
  TabSource,
  WorkspaceFileResult,
  WorkspaceTreeResult,
} from './coding/schemas';

const byId = z.object({ id: z.string() });
const cwd = z.object({ cwd: z.string() });
const cwdPaths = z.object({ cwd: z.string(), paths: z.array(z.string()) });
const cwdFile = z.object({ cwd: z.string(), path: z.string() });
const carry = { carry: z.boolean().optional() };
/** 内置 CLI id（未知值由主进程按原规则处理：更新退回 claude，账号报错） */
const cliKind = z.string();

const harnessProcedures = {
  'harness.state': { kind: 'query', input: z.void(), output: HarnessState },
  'harness.setBackend': {
    kind: 'mutation',
    input: z.object({ backend: HarnessBackend }),
    output: HarnessState,
  },
  /** carry：把当前对话作为前文带进新目录的新会话 */
  'harness.setCwd': {
    kind: 'mutation',
    input: z.object({ cwd: z.string(), ...carry }),
    output: HarnessState,
  },
  'harness.pickCwd': { kind: 'mutation', input: z.void(), output: HarnessState },
  'harness.send': {
    kind: 'mutation',
    input: z.object({ prompt: z.string() }),
    output: HarnessSendReply,
  },
  'harness.tabs': { kind: 'query', input: z.void(), output: HarnessTabsState },
  'harness.tabCreate': {
    kind: 'mutation',
    input: z.looseObject({
      backend: HarnessBackend.optional(),
      cwd: z.string().optional(),
      title: z.string().optional(),
      messages: z.array(HarnessTabMessage).optional(),
      permissionMode: PermissionMode.optional(),
      /** backend = 'external' 时：外部插件 id */
      pluginId: z.string().optional(),
    }),
    output: HarnessTabMeta,
  },
  'harness.tabSeed': {
    kind: 'mutation',
    input: z.object({ id: z.string(), messages: z.array(HarnessTabMessage) }),
    output: HarnessTabMeta,
  },
  'harness.tabClose': { kind: 'mutation', input: byId, output: HarnessTabsState },
  'harness.tabRename': {
    kind: 'mutation',
    input: z.object({ id: z.string(), title: z.string() }),
    output: HarnessTabMeta,
  },
  'harness.tabApplyAutoTitle': {
    kind: 'mutation',
    input: z.object({ id: z.string(), title: z.string() }),
    output: HarnessTabMeta.nullable(),
  },
  'harness.tabActivate': { kind: 'mutation', input: byId, output: HarnessTabsState },
  'harness.tabBackend': {
    kind: 'mutation',
    input: z.object({ id: z.string(), backend: HarnessBackend }),
    output: HarnessTabMeta,
  },
  'harness.tabCwd': {
    kind: 'mutation',
    input: z.object({ id: z.string(), cwd: z.string(), ...carry }),
    output: HarnessTabMeta,
  },
  /**
   * 标签权限模式；「完全放开」必须带 confirmed（界面先弹确认框），expect 是确认时看到的后端 / 目录，
   * 主进程核对不一致则拒绝。回答用户确认 → dangerous。
   */
  'harness.tabPermissionMode': {
    kind: 'mutation',
    dangerous: true,
    input: z.object({
      id: z.string(),
      mode: PermissionMode,
      confirmed: z.boolean().optional(),
      expect: z.object({ backend: z.string().optional(), cwd: z.string().optional() }).optional(),
    }),
    output: HarnessTabMeta,
  },
  'harness.permissionDefaults': {
    kind: 'mutation',
    input: z.object({
      defaultPermissionMode: PermissionMode.optional(),
      codexNetwork: z.boolean().optional(),
      autoApprove: z.boolean().optional(),
      aiReview: z.boolean().optional(),
      nomiAutoApprove: z.boolean().optional(),
    }),
    output: HarnessTabsState,
  },
  /** 官方来源从 CLI 读（主进程缓存），第三方是网关的模型；不支持切换模型的后端返回 null */
  'harness.modelCatalog': {
    kind: 'query',
    input: z.object({
      backend: HarnessBackend,
      refresh: z.boolean().optional(),
      source: TabSource.optional(),
    }),
    output: BackendModelCatalog.nullable(),
  },
  'harness.tabSource': {
    kind: 'mutation',
    input: z.object({ id: z.string(), source: TabSource, model: z.string().optional() }),
    output: HarnessTabMeta,
  },
  'harness.tabModel': {
    kind: 'mutation',
    input: z.object({ id: z.string(), model: z.string(), expectSource: TabSource.optional() }),
    output: HarnessTabMeta,
  },
  'harness.tabAccount': {
    kind: 'mutation',
    input: z.object({ id: z.string(), accountId: z.string().nullable() }),
    output: HarnessTabMeta,
  },
  'harness.tabLongContext': {
    kind: 'mutation',
    input: z.object({ id: z.string(), on: z.boolean().nullable() }),
    output: HarnessTabMeta,
  },
  'harness.tabEffort': {
    kind: 'mutation',
    input: z.object({ id: z.string(), effort: z.string().nullable() }),
    output: HarnessTabMeta,
  },
  'harness.tabPickCwd': { kind: 'mutation', input: byId, output: HarnessTabMeta },
  'harness.tabCarryClear': { kind: 'mutation', input: byId, output: HarnessTabMeta },
  /** 删掉这条用户消息及之后的全部消息并丢弃 CLI 会话；返回截断后的消息 */
  'harness.tabRewind': {
    kind: 'mutation',
    input: z.object({ id: z.string(), messageId: z.string() }),
    output: z.array(HarnessTabMessage),
  },
  /** 原生文件夹选择器（不绑定标签）；取消返回 null */
  'harness.pickDir': {
    kind: 'mutation',
    input: z.object({ defaultPath: z.string().optional() }),
    output: z.string().nullable(),
  },
  'harness.recentCwds': { kind: 'query', input: z.void(), output: z.array(z.string()) },
  'harness.tabMessages': { kind: 'query', input: byId, output: z.array(HarnessTabMessage) },
  'harness.tabSend': {
    kind: 'mutation',
    input: z.object({
      id: z.string(),
      prompt: z.string(),
      images: z.array(HarnessImageInput).optional(),
    }),
    output: HarnessSendReply,
  },
  'harness.tabCancel': { kind: 'mutation', input: byId, output: z.boolean() },
  /**
   * 一轮进行中插入一条用户消息（不打断这一轮，CLI 在下一个工具 / 模型步骤取走）。
   * 没有进行中的轮次或后端不支持时 false：视图改为排队到这一轮结束。
   */
  'harness.tabSteer': {
    kind: 'mutation',
    input: z.object({ id: z.string(), text: z.string().max(200_000) }),
    output: z.boolean(),
  },
  /** 单独停止一个后台子代理（Claude stop_task）；不支持时 false */
  'harness.stopAgent': {
    kind: 'mutation',
    input: z.object({ id: z.string(), agentId: z.string() }),
    output: z.boolean(),
  },
  /** Claude 标签：从 CLI 自己的会话记录读当前上下文；没有时 null */
  'harness.tabContext': { kind: 'query', input: byId, output: TabContext.nullable() },

  // 斜杠命令（只读发现 / 按 id 展开，见 cli/slashDiscovery.ts）
  'harness.slashDiscover': {
    kind: 'query',
    input: z.object({ backend: z.string(), cwd: z.string() }),
    output: SlashDiscoveryResult,
  },
  'harness.slashExpand': {
    kind: 'query',
    input: z.object({ backend: z.string(), cwd: z.string(), id: z.string(), args: z.string() }),
    output: SlashExpansion.nullable(),
  },

  // 右栏「改动」（cli/gitOps.ts）：cwd 必须是已知工作区，主进程核对
  'harness.gitDiff': { kind: 'query', input: cwd, output: GitDiffResult },
  'harness.gitBranch': { kind: 'query', input: cwd, output: GitBranchResult.nullable() },
  /** 分支切换下拉：本地分支列表；不是 git 仓库时 null */
  'harness.gitBranches': { kind: 'query', input: cwd, output: GitBranchList.nullable() },
  /** 切到已有分支，或 create 时从当前 HEAD 新建并切过去；有会被覆盖的改动时 code dirty（不丢改动） */
  'harness.gitCheckout': {
    kind: 'mutation',
    input: z.object({
      cwd: z.string(),
      branch: z.string().max(255),
      create: z.boolean().optional(),
    }),
    output: GitOpResult,
  },
  'harness.gitSyncStatus': { kind: 'query', input: cwd, output: GitSyncStatus.nullable() },
  'harness.gitStage': { kind: 'mutation', input: cwdPaths, output: GitOpResult },
  'harness.gitUnstage': { kind: 'mutation', input: cwdPaths, output: GitOpResult },
  /** 给了 paths 就先暂存它们再提交，否则只提交已暂存的 */
  'harness.gitCommit': {
    kind: 'mutation',
    input: z.object({
      cwd: z.string(),
      message: z.string(),
      paths: z.array(z.string()).nullable().optional(),
    }),
    output: GitOpResult,
  },
  'harness.gitCommitUndo': {
    kind: 'mutation',
    input: z.object({ cwd: z.string(), sha: z.string() }),
    output: GitOpResult,
  },
  'harness.gitFetch': { kind: 'mutation', input: cwd, output: GitOpResult },
  'harness.gitPull': { kind: 'mutation', input: cwd, output: GitOpResult },
  'harness.gitPush': { kind: 'mutation', input: cwd, output: GitOpResult },
  /** 放弃未暂存的改动（存进 stash，可撤销） */
  'harness.gitDiscard': { kind: 'mutation', input: cwdPaths, output: GitOpResult },
  'harness.gitDiscardUndo': {
    kind: 'mutation',
    input: z.object({ cwd: z.string(), stashes: z.array(z.string()) }),
    output: GitOpResult,
  },
  /** 辅助模型根据要提交的 diff 写提交信息（经网关，受外发保护） */
  'harness.gitSuggestMessage': {
    kind: 'mutation',
    input: z.object({ cwd: z.string(), paths: z.array(z.string()).nullable().optional() }),
    output: GitOpResult,
  },
  /** 同一仓库的 worktree；列出来的目录之后也算已知工作区（所以是 mutation） */
  'harness.gitWorktrees': { kind: 'mutation', input: cwd, output: GitWorktreeList.nullable() },

  // 工作区文件（cli/workspaceFiles.ts）
  'harness.workspaceList': { kind: 'query', input: cwd, output: WorkspaceTreeResult },
  'harness.workspaceRead': { kind: 'query', input: cwdFile, output: WorkspaceFileResult },
  'harness.workspaceWrite': {
    kind: 'mutation',
    input: z.object({ cwd: z.string(), path: z.string(), content: z.string() }),
    output: WorkspaceFileResult,
  },
  'harness.workspaceDelete': { kind: 'mutation', input: cwdFile, output: WorkspaceFileResult },
  'harness.workspaceGitCheckout': {
    kind: 'mutation',
    input: cwdFile,
    output: WorkspaceFileResult,
  },

  // 回答用户确认 / 授予权限
  /** 用户确认后，把这条错误消息记录的文件夹加入 Gemini 的受信任文件夹（文件夹由主进程按消息查出） */
  'harness.geminiTrustFolder': {
    kind: 'mutation',
    dangerous: true,
    input: z.object({
      tabId: z.string(),
      messageId: z.string(),
      confirmed: z.boolean().optional(),
    }),
    output: GeminiTrustResult,
  },
  /** 允许 / 拒绝工具权限请求；带 approvePlan 时按「批准计划」三选一处理 */
  'harness.replyPermission': {
    kind: 'mutation',
    dangerous: true,
    input: z.object({
      tabId: z.string(),
      requestId: z.string(),
      allow: z.boolean(),
      approvePlan: ApprovePlanChoice.optional(),
    }),
    output: z.boolean(),
  },
  /**
   * 回答沙箱挡下后挂在标签上的授权请求（标签状态的 sandboxPending）：session = 本会话允许、
   * always = 始终允许（记进桌面设置）、deny = 不允许（本会话不再问）；允许后这个标签的 CLI 重开并接着做
   */
  'harness.sandboxReply': {
    kind: 'mutation',
    dangerous: true,
    input: z.object({
      tabId: z.string(),
      requestId: z.string(),
      choice: z.enum(['session', 'always', 'deny']),
    }),
    output: z.boolean(),
  },
  'harness.replyApprovePlan': {
    kind: 'mutation',
    dangerous: true,
    input: z.object({ tabId: z.string(), requestId: z.string(), choice: ApprovePlanChoice }),
    output: z.boolean(),
  },
} as const satisfies ProcedureMap;

const cliProcedures = {
  'cli.registry': { kind: 'query', input: z.void(), output: CliRegistrySnapshot },
  /** 外部插件（用户添加的说 ACP 的 CLI）：清单不合格时 `{ ok: false, errors }` */
  'cli.pluginAdd': {
    kind: 'mutation',
    input: z.object({ spec: ExternalCliSpec }),
    output: CliPluginAddResult,
  },
  'cli.pluginRemove': { kind: 'mutation', input: byId, output: z.boolean() },
  /** 试运行（在临时目录里握手），不保存 */
  'cli.pluginTest': {
    kind: 'mutation',
    input: z.object({ spec: ExternalCliSpec }),
    output: ExternalTestResult,
  },
} as const satisfies ProcedureMap;

const cliAccountProcedures = {
  /** kind 缺省 = 所有编程助手的账号 */
  'cliAccount.list': {
    kind: 'query',
    input: z.object({ kind: cliKind.optional() }),
    output: z.array(CliAccount),
  },
  /** 用 CLI 自己的状态命令重新读各账号的身份（不读凭据） */
  'cliAccount.refresh': {
    kind: 'mutation',
    input: z.object({ kind: cliKind }),
    output: z.array(CliAccount),
  },
  'cliAccount.setDefault': {
    kind: 'mutation',
    input: z.object({ kind: cliKind, id: z.string() }),
    output: CliAccount,
  },
  'cliAccount.rename': {
    kind: 'mutation',
    input: z.object({ id: z.string(), label: z.string() }),
    output: CliAccount,
  },
  /** force：有标签在用时也删除（界面先确认） */
  'cliAccount.remove': {
    kind: 'mutation',
    input: z.object({ id: z.string(), force: z.boolean().optional() }),
    output: z.void(),
  },
  /** accountId 为空：新建账号并登录；否则在这个账号的目录里（重新）登录 */
  'cliAccount.loginStart': {
    kind: 'mutation',
    input: z.object({ kind: cliKind, accountId: z.string().optional() }),
    output: LoginEvent,
  },
  'cliAccount.loginInput': {
    kind: 'mutation',
    input: z.object({ id: z.string(), text: z.string() }),
    output: z.boolean(),
  },
  'cliAccount.loginCancel': { kind: 'mutation', input: byId, output: z.boolean() },
  /** 只能打开官方登录页（主进程校验）；不是登录页时 false */
  'cliAccount.openUrl': {
    kind: 'mutation',
    input: z.object({ url: z.string() }),
    output: z.boolean(),
  },
} as const satisfies ProcedureMap;

const cliUpdateProcedures = {
  'cliUpdate.inspect': {
    kind: 'query',
    input: z.object({ refresh: z.boolean().optional() }),
    output: z.array(CliInstallInfo),
  },
  'cliUpdate.preview': {
    kind: 'query',
    input: z.object({ kind: cliKind, scope: CliInstallScope.optional() }),
    output: CliInstallPlan,
  },
  /** 安装 / 更新所需的运行环境（Node.js / npm），编程助手页顶部展示 */
  'cliUpdate.environment': { kind: 'query', input: z.void(), output: CliEnvironment },
  /** 安装 / 更新；进度经事件 `cliUpdate.event` 推给所有订阅的窗口（任务快照见 `cliUpdate.job`） */
  'cliUpdate.run': {
    kind: 'mutation',
    input: z.object({ kind: cliKind, scope: CliInstallScope.optional() }),
    output: CliRunResult,
  },
  'cliUpdate.job': {
    kind: 'query',
    input: z.object({ kind: cliKind }),
    output: CliJob.nullable(),
  },
  'cliUpdate.busy': { kind: 'query', input: z.void(), output: z.array(z.string()) },
  'cliUpdate.dismiss': {
    kind: 'mutation',
    input: z.object({ kind: cliKind }),
    output: z.boolean(),
  },
} as const satisfies ProcedureMap;

const delegateProcedures = {
  'delegate.settings': { kind: 'query', input: z.void(), output: DelegateSettingsView },
  /** 设置补丁（主进程逐项校验） */
  'delegate.setSettings': {
    kind: 'mutation',
    input: z.object({ settings: z.looseObject({}) }),
    output: DelegateSettings,
  },
  /** 按 turnId 把下一个需求钉给某个编程助手（cli = null 清除）；名字认不出时报错 */
  'delegate.pin': {
    kind: 'mutation',
    input: z.object({ cli: z.string().nullable(), turnId: z.string() }),
    output: z.string().nullable(),
  },
  'delegate.clearPin': {
    kind: 'mutation',
    input: z.object({ turnId: z.string() }),
    output: z.boolean(),
  },
  /** 后台委派任务的状态；没有时 null */
  'delegate.status': {
    kind: 'query',
    input: z.object({ taskId: z.string() }),
    output: DelegateResult.nullable(),
  },
} as const satisfies ProcedureMap;

const agentsProcedures = {
  'agents.state': { kind: 'query', input: z.void(), output: AgentWatchState },
  /** 立刻扫描一轮再返回状态 */
  'agents.scan': { kind: 'mutation', input: z.void(), output: AgentWatchState },
  'agents.setSettings': {
    kind: 'mutation',
    input: AgentWatchSettingsPatch,
    output: AgentWatchSettings,
  },
} as const satisfies ProcedureMap;

const fleetProcedures = {
  /** 看板数据：资源占用最多 1 秒前采的（打开看板时视图每几秒拉一次刷新占用） */
  'fleet.state': {
    kind: 'query',
    input: z.void(),
    output: FleetState,
  },
  /** 归档已完成的一项：从看板上拿掉（标签与会话不动，再跑起来会重新出现）；不在已完成列时不动 */
  'fleet.archive': {
    kind: 'mutation',
    input: z.object({ id: z.string() }),
    output: FleetState,
  },
  /**
   * 用户手动关闭一棵空闲的外部编程助手进程树（externalIdle.items 里的）：内核先确认它此刻仍是同一种助手的空闲树、
   * 不在 Nomi 的进程树里，再 SIGTERM，过几秒还在的 SIGKILL；对不上时 FLEET_NOT_IDLE。调度从不调用。
   */
  'fleet.closeIdle': {
    kind: 'mutation',
    input: z.object({ pid: z.number(), backend: z.string() }),
    output: FleetState,
    dangerous: true,
  },
  /** 暂停一个纳管的、正在跑的 CLI 标签（冻结它的进程树，不占 CPU；恢复后这一轮从原处接着跑）；不能暂停时 FLEET_NOT_PAUSABLE */
  'fleet.pause': { kind: 'mutation', input: z.object({ id: z.string() }), output: FleetState },
  /** 恢复一个暂停中的标签（自动或手动暂停的都行）；不在暂停中时 FLEET_NOT_PAUSABLE */
  'fleet.resume': { kind: 'mutation', input: z.object({ id: z.string() }), output: FleetState },
  /** 打开 / 关闭内存紧张时的自动处理（存盘）；关掉时恢复内存守护暂停的标签 */
  'fleet.setAutoPause': {
    kind: 'mutation',
    input: z.object({ enabled: z.boolean() }),
    output: FleetState,
  },
} as const satisfies ProcedureMap;

const historySession = z.object({ backend: z.string(), sessionId: z.string() });
const historyPage = z.object({ backend: z.string(), options: HistoryPageOptions.optional() });

const historyProcedures = {
  'history.list': { kind: 'query', input: historyPage, output: HistoryPage },
  /** 搜索用的紧凑索引（主进程增量解析，分块返回） */
  'history.index': { kind: 'query', input: historyPage, output: HistoryPage },
  'history.open': { kind: 'mutation', input: historySession, output: HistoryOpenResult },
  /** 把 CLI 的会话记录移到系统废纸篓；会话还开在标签里时拒绝 */
  'history.delete': { kind: 'mutation', input: historySession, output: HistoryDeleteResult },
} as const satisfies ProcedureMap;

export const codingProcedures = {
  ...harnessProcedures,
  ...cliProcedures,
  ...cliAccountProcedures,
  ...cliUpdateProcedures,
  ...delegateProcedures,
  ...agentsProcedures,
  ...fleetProcedures,
  ...historyProcedures,
} as const satisfies ProcedureMap;

export const codingEvents = {
  /** 主标签状态（ai:harness:changed） */
  'harness.changed': HarnessState,
  /** 标签列表（ai:harness:tabs） */
  'harness.tabsChanged': HarnessTabsState,
  /** 实时事件，按帧合批（ai:harness:events） */
  'harness.events': z.array(HarnessLiveEvent),
  /** 某个标签新增 / 更新了一条消息（ai:harness:tab-message） */
  'harness.tabMessage': z.looseObject({ tabId: z.string(), message: HarnessTabMessage }),
  /** 插件注册表变化（ai:cli:registry-changed） */
  'cli.registryChanged': CliRegistrySnapshot,
  /** 账号列表变化，不带数据（ai:cli-account:changed） */
  'cliAccount.changed': z.null(),
  /** 登录进度（ai:cli-account:login） */
  'cliAccount.login': LoginEvent,
  /** 安装 / 更新进度（ai:cli-update:event） */
  'cliUpdate.event': CliUpdateEvent,
  /** 后台委派完成（ai:delegate:completed） */
  'delegate.completed': DelegateResult,
  /** 监视状态变化，不带数据（ai:agents:changed） */
  'agents.changed': z.null(),
  /** Agent 看板的成员或状态变了（标签、任务变化时推；资源占用不推，视图打开看板时自己拉） */
  'fleet.changed': FleetState,
} as const satisfies EventMap;

/** 事件的订阅白名单：编程助手的会话内容（标签、消息、实时事件）只给对话窗口 */
export const codingEventSurfaces = {
  'harness.changed': ['chat', 'settings'],
  'harness.tabsChanged': ['chat', 'settings'],
  'harness.events': ['chat', 'settings'],
  'harness.tabMessage': ['chat', 'settings'],
  'fleet.changed': ['chat', 'settings'],
} as const satisfies Partial<Record<keyof typeof codingEvents, readonly Surface[]>>;

/**
 * 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出。
 * 账号操作（AccountError 的 kebab code）：not-found / in-use / local / unsupported / unknown-live。
 */
export const codingErrors = [
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_IN_USE',
  'ACCOUNT_LOCAL',
  'ACCOUNT_UNSUPPORTED',
  'ACCOUNT_UNKNOWN_LIVE',
  /** fleet.closeIdle：要关的进程已经不是空闲的外部编程助手 */
  'FLEET_NOT_IDLE',
  /** fleet.pause / resume：不能暂停或恢复（外部的、内核里跑的、没在跑、或已经是这个状态） */
  'FLEET_NOT_PAUSABLE',
] as const satisfies readonly string[];

export type CodingProcedureName = keyof typeof codingProcedures & string;
export type CodingEventName = keyof typeof codingEvents & string;
