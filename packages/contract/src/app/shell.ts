/**
 * D2 · 应用外壳（docs/development/architecture.md）。
 *
 * 本文件只属于 D2：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：theme、locale、startup、onboarding、providers、gateway、providerLink、usage、quality、updates、diagnostics、appIcon、
 * migration、conversations、chatWindow（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:theme:*`、`ai:locale:*`（packages/ui 的 theme.ts / i18n.ts）、`ai:startup:*`、`ai:onboarding:*`
 * - `ai:providers:*`（ai-runtime ProviderIpcServer，含事件 `ai:providers:changed` / `ai:providers:open-panel`）
 * - `ai:gateway:*`（含 TerminalCommands 的 `ai:gateway:terminal-*`）、`ai:usage:*`、`ai:quality:*`
 * - `updates:*`、`diagnostics:*`、`app-icon:*`（electronAPI.updates / diagnostics / appIcon）
 *
 * 约定见设计稿「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
 * 读用 query、写用 mutation、进度流用 stream；只给一个窗口用的过程写 `surfaces`，
 * 原来要用户确认的写 `dangerous: true`。
 *
 * 旧通道 → 过程：`ai:<ns>:<kebab>` → `<ns>.<camel>`；`ai:gateway:privacy-*` → `gateway.privacy*`，
 * `ai:gateway:terminal-*` → `gateway.terminal*`；`ai:quality:settings-get / -set` →
 * `quality.getSettings / setSettings`，`ai:quality:export` → `quality.exportCsv`；`app-icon:*` → `appIcon.*`。
 * 单个对象参数原样作为入参，标量参数包成具名对象（`ai:theme:set(id)` → `theme.set({ pref })`）。
 */

import { z } from 'zod';

import type { EventMap, ProcedureMap } from '../contract';

import * as S from './shell/schemas';

const v = z.void();

/** 原来只在对话窗口 preload（electronAPI.diagnostics / appIcon）里暴露 */
const CHAT = ['chat'] as const;

export const shellProcedures = {
  // ---- theme（ThemeService）----
  'theme.get': { kind: 'query', input: v, output: S.ThemeState },
  'theme.set': { kind: 'mutation', input: S.ThemeSetInput, output: S.ThemeState },
  // 自定义主题（设置 → 外观）：存储与主题包校验在内核
  'theme.customList': { kind: 'query', input: v, output: z.array(S.CustomTheme), surfaces: CHAT },
  'theme.customSave': {
    kind: 'mutation',
    input: S.CustomThemeSaveInput,
    output: S.CustomTheme,
    surfaces: CHAT,
  },
  /** 删的是正在用的主题时退回默认主题（推 theme.changed） */
  'theme.customDelete': {
    kind: 'mutation',
    input: S.CustomThemeIdInput,
    output: v,
    surfaces: CHAT,
  },
  /** 内核弹出选择框读主题包并校验；取消 → null */
  'theme.customImport': {
    kind: 'mutation',
    input: v,
    output: S.CustomTheme.nullable(),
    surfaces: CHAT,
  },
  /** 拖进导入框的主题包（视图读出的字节） */
  'theme.customImportData': {
    kind: 'mutation',
    input: S.CustomThemeImportDataInput,
    output: S.CustomTheme,
    surfaces: CHAT,
  },
  /** 内核弹出保存框写出主题包模板；取消 → null，否则返回路径 */
  'theme.customTemplate': {
    kind: 'mutation',
    input: v,
    output: z.string().nullable(),
    surfaces: CHAT,
  },
  /** 内核弹出选择框选背景图（暂存，保存主题时才归位）；取消 → null，否则返回图片地址 */
  'theme.customPickBackground': {
    kind: 'mutation',
    input: v,
    output: z.string().nullable(),
    surfaces: CHAT,
  },
  /** 内核弹出保存框写出主题包（有背景图写 zip）；取消 → null，否则返回路径 */
  'theme.customExport': {
    kind: 'mutation',
    input: S.CustomThemeIdInput,
    output: z.string().nullable(),
    surfaces: CHAT,
  },

  // ---- locale（i18n/LocaleService）----
  'locale.get': { kind: 'query', input: v, output: S.LocaleState },
  'locale.set': { kind: 'mutation', input: S.LocaleSetInput, output: S.LocaleState },
  'locale.dict': { kind: 'query', input: v, output: S.LocaleDict },

  // ---- startup（StartupService）----
  'startup.get': { kind: 'query', input: v, output: S.StartupState },
  'startup.set': { kind: 'mutation', input: S.StartupPatch, output: S.StartupState },

  // ---- onboarding（OnboardingService）----
  'onboarding.get': { kind: 'query', input: v, output: S.OnboardingState },
  'onboarding.complete': {
    kind: 'mutation',
    input: S.OnboardingCompleteInput,
    output: S.OnboardingState,
  },
  'onboarding.reopen': { kind: 'mutation', input: v, output: S.OnboardingState },
  'onboarding.mascot': { kind: 'mutation', input: S.OnboardingMascotCmd, output: z.boolean() },
  'onboarding.profile': { kind: 'query', input: v, output: S.UserProfile },
  'onboarding.setProfile': { kind: 'mutation', input: S.UserProfileInput, output: S.UserProfile },

  // ---- providers（ai-runtime ProviderService：预设、只读状态与 setActive 兼容垫片）----
  'providers.presets': { kind: 'query', input: v, output: z.array(S.ProviderPreset) },
  'providers.meta': { kind: 'query', input: v, output: S.ProviderMeta },
  'providers.state': { kind: 'query', input: v, output: S.ProviderState },
  'providers.setActive': {
    kind: 'mutation',
    input: S.ProviderSetActiveInput,
    output: S.ProviderState,
  },

  // ---- gateway（GatewayService / TerminalCommands）----
  'gateway.state': { kind: 'query', input: v, output: S.GatewayState },
  /** 内置模型目录（models.dev 快照 + 同步覆盖层）：第三方模型「按哪个已知模型处理」的选择列表 */
  'gateway.catalogModels': { kind: 'query', input: v, output: z.array(S.CatalogModel) },
  'gateway.detect': {
    kind: 'mutation',
    input: S.GatewayDetectInput,
    output: S.GatewayDetectResult,
  },
  'gateway.retry': { kind: 'mutation', input: v, output: v },
  'gateway.upsertProvider': {
    kind: 'mutation',
    input: S.GatewayProviderInput,
    output: S.GatewayProviderView,
  },
  'gateway.removeProvider': { kind: 'mutation', input: z.object({ id: z.string() }), output: v },
  /** 列表上快速启用 / 停用供应商；停用的不出候选，请求按列表顺序换到同一个模型的下一家 */
  'gateway.setProviderEnabled': {
    kind: 'mutation',
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: v,
  },
  /** 供应商列表的顺序：同一个模型的回退按这个顺序换供应商 */
  'gateway.reorderProviders': {
    kind: 'mutation',
    input: z.object({ ids: z.array(z.string()) }),
    output: v,
  },
  'gateway.setAssignment': { kind: 'mutation', input: S.GatewaySetAssignmentInput, output: v },
  'gateway.setOptions': {
    kind: 'mutation',
    input: S.GatewayOptionsPatch,
    output: S.GatewayState,
  },
  'gateway.resetToken': { kind: 'mutation', input: S.GatewayClientInput, output: v },
  'gateway.clearLearned': {
    kind: 'mutation',
    input: z.object({ providerId: z.string() }),
    output: v,
  },
  /** 用户确认后才允许网关访问本机 / 局域网地址 */
  'gateway.confirmPrivateHost': {
    kind: 'mutation',
    input: z.object({ hostPort: z.string() }),
    output: v,
    dangerous: true,
  },
  'gateway.privacyPreview': {
    kind: 'query',
    input: z.object({ text: z.string() }),
    output: S.PrivacyPreview,
  },
  'gateway.privacyLog': { kind: 'query', input: v, output: z.array(S.PrivacyLogEntry) },
  'gateway.privacyClearLog': { kind: 'mutation', input: v, output: v },
  'gateway.privacyAddAllow': {
    kind: 'mutation',
    input: S.PrivacyAllowInput,
    output: S.GatewayState,
  },
  'gateway.privacyRemoveAllow': {
    kind: 'mutation',
    input: z.object({ tag: z.string() }),
    output: S.GatewayState,
  },
  'gateway.privacyAddSecret': {
    kind: 'mutation',
    input: S.PrivacySecretInput,
    output: S.GatewayState,
  },
  'gateway.privacyRemoveSecret': {
    kind: 'mutation',
    input: z.object({ id: z.string() }),
    output: S.GatewayState,
  },
  'gateway.privacySetAction': {
    kind: 'mutation',
    input: S.PrivacySetActionInput,
    output: S.GatewayState,
  },
  'gateway.terminalState': { kind: 'query', input: v, output: S.TerminalState },
  'gateway.terminalSet': { kind: 'mutation', input: S.TerminalSetInput, output: S.TerminalState },
  /** Nomi 对话某个角色的上下文预算（按路由到的模型的窗口算）；没配模型时 null */
  'gateway.nomiContext': {
    kind: 'query',
    input: z.object({ role: z.enum(['chat', 'agent-tools', 'summary']).optional() }),
    output: S.NomiContextInfo.nullable(),
  },

  // ---- providerLink（第三方供应商链接 nomi://provider/*，docs/integrations/provider-link.md）----
  /** 等用户确认的链接（冷启动时链接先于窗口到达：窗口挂载后拉取） */
  'providerLink.list': {
    kind: 'query',
    input: v,
    output: z.array(S.ProviderLinkOffer),
    surfaces: CHAT,
  },
  /** 确认：authorize = 打开浏览器去授权；save = 写进网关 */
  'providerLink.accept': {
    kind: 'mutation',
    input: z.object({ id: z.string() }),
    output: S.ProviderLinkAcceptResult,
    surfaces: CHAT,
  },
  'providerLink.reject': {
    kind: 'mutation',
    input: z.object({ id: z.string() }),
    output: v,
    surfaces: CHAT,
  },
  /** 设置里填第三方供应商的域名发起授权（读它的授权清单后打开浏览器） */
  'providerLink.connect': {
    kind: 'mutation',
    input: z.object({ issuer: z.string() }),
    output: z.object({ name: z.string(), issuer: z.string() }),
    surfaces: CHAT,
  },

  // ---- usage（UsageService）----
  'usage.state': { kind: 'query', input: v, output: S.UsageState },
  'usage.setSettings': {
    kind: 'mutation',
    input: S.UsageSettingsPatch,
    output: S.UsageSettings,
  },
  'usage.query': {
    kind: 'query',
    input: z.object({ range: S.UsageRangeId }),
    output: S.UsageQueryResult,
  },
  'usage.details': { kind: 'query', input: S.UsageDetailQuery, output: S.UsageDetailResult },
  'usage.heatmap': { kind: 'query', input: v, output: S.UsageHeatmap },
  'usage.csv': { kind: 'query', input: S.UsageDetailQuery, output: z.string() },
  'usage.clear': { kind: 'mutation', input: v, output: S.UsageState },
  'usage.scan': {
    kind: 'mutation',
    input: v,
    output: S.UsageScanResult,
  },
  'usage.endpoint': {
    kind: 'query',
    input: z.object({ source: z.string() }),
    output: S.UsageEndpointInfo,
  },
  /** 只在用户点击时调用：只下载 models.dev 的公开价格表，不上传任何用量 */
  'usage.priceSync': {
    kind: 'mutation',
    input: v,
    output: S.UsagePriceSync,
  },
  'usage.quota': { kind: 'query', input: v, output: z.array(S.UsageQuotaEntry) },
  /** 不带 tool = 全部刷新 */
  'usage.quotaRefresh': {
    kind: 'mutation',
    input: z.object({ tool: S.UsageQuotaTool.optional() }),
    output: S.UsageQuotaRefresh,
  },
  'usage.quotaHook': { kind: 'query', input: v, output: S.UsageQuotaHook },
  'usage.quotaHookSet': {
    kind: 'mutation',
    input: z.object({ enabled: z.boolean() }),
    output: S.UsageQuotaHook,
  },

  // ---- quality（QualityService）----
  'quality.query': { kind: 'query', input: S.QualityQuery, output: S.QualityResult },
  'quality.series': { kind: 'query', input: S.QualitySeriesQuery, output: S.QualitySeries },
  'quality.requests': {
    kind: 'query',
    input: S.QualityRequestsQuery,
    output: S.QualityRequestsPage,
  },
  'quality.facets': { kind: 'query', input: S.QualityFacetsQuery, output: S.QualityFacets },
  'quality.getSettings': { kind: 'query', input: v, output: S.QualitySettings },
  'quality.setSettings': {
    kind: 'mutation',
    input: S.QualitySettingsPatch,
    output: S.QualitySettings,
  },
  'quality.clear': { kind: 'mutation', input: v, output: z.boolean() },
  /** 主进程弹保存对话框写 CSV */
  'quality.exportCsv': {
    kind: 'mutation',
    input: S.QualityExportInput,
    output: S.QualityExportResult,
  },

  // ---- updates（UpdateService；两个窗口的 electronAPI.updates）----
  'updates.get': { kind: 'query', input: v, output: S.UpdateState },
  'updates.check': { kind: 'mutation', input: v, output: S.UpdateState },
  'updates.download': { kind: 'mutation', input: v, output: S.UpdateState },
  'updates.install': { kind: 'mutation', input: v, output: S.UpdateState },
  'updates.setAutoCheck': {
    kind: 'mutation',
    input: z.object({ on: z.boolean() }),
    output: S.UpdateState,
  },
  /** 某个版本的更新说明（Release 的 docs/releases/vX.Y.Z.md，经该版本的 latest-go.json 下发）；缺省 = 当前版本 */
  'updates.releaseNotes': {
    kind: 'query',
    input: z.object({ version: z.string().max(64).optional() }),
    output: S.ReleaseNotesResult,
  },

  // ---- diagnostics（DiagnosticsService；只在对话窗口）----
  'diagnostics.get': { kind: 'query', input: v, output: S.DiagnosticsView, surfaces: CHAT },
  'diagnostics.set': {
    kind: 'mutation',
    input: z.object({ on: z.boolean() }),
    output: S.DiagnosticsView,
    surfaces: CHAT,
  },
  'diagnostics.openFolder': { kind: 'mutation', input: v, output: z.boolean(), surfaces: CHAT },
  'diagnostics.export': {
    kind: 'mutation',
    input: v,
    output: S.DiagnosticsExportResult,
    surfaces: CHAT,
  },
  /** 开发者工具：一轮里编程助手子进程的原始收发（读 logs/cli-*.jsonl） */
  'diagnostics.cliRecords': {
    kind: 'query',
    input: S.DiagnosticsCliRecordsQuery,
    output: S.DiagnosticsCliRecords,
    surfaces: CHAT,
  },
  /** 开发者工具：网关请求的请求体 / 响应正文（读 gateway/trace） */
  'diagnostics.gatewayTrace': {
    kind: 'query',
    input: z.object({ traceId: z.string().max(64) }),
    output: S.DiagnosticsGatewayTrace,
    surfaces: CHAT,
  },

  // ---- appIcon（core/appIcon；只在对话窗口）----
  'appIcon.get': { kind: 'query', input: v, output: S.AppIconState, surfaces: CHAT },
  'appIcon.set': {
    kind: 'mutation',
    input: z.object({ variant: z.string() }),
    output: S.IconVariant,
    surfaces: CHAT,
  },

  // ---- migration（旧版本数据迁移；只在对话窗口）----
  /**
   * Go 版首启抽出的旧 Electron 对话（localStorage 的 `ai-chat:*`，#181）。只读、可重复调用：
   * 视图在会话存储第一次构造前取一次、幂等合并并自己记完成标记；Node 版没有可迁移的，恒为 `none`。
   */
  'migration.chatHistory': {
    kind: 'query',
    input: v,
    output: S.ChatHistoryMigration,
    surfaces: CHAT,
  },

  // ---- conversations（Nomi 对话的会话存储，内核 userData/conversations/；只在对话窗口）----
  /** 索引：元信息、预览、条数、当前会话（启动时在第一次渲染前取） */
  'conversations.state': { kind: 'query', input: v, output: S.ConversationsState, surfaces: CHAT },
  /** 一个会话的消息（原样返回） */
  'conversations.messages': {
    kind: 'query',
    input: S.ConversationsMessagesInput,
    output: S.ConversationsMessages,
    surfaces: CHAT,
  },
  /** 追加消息（不重写已有的；会话不存在时 CONVERSATION_NOT_FOUND） */
  'conversations.append': {
    kind: 'mutation',
    input: S.ConversationsAppendInput,
    output: v,
    surfaces: CHAT,
  },
  /** 整份替换消息（编辑重发、清空；会话不存在时 CONVERSATION_NOT_FOUND） */
  'conversations.replace': {
    kind: 'mutation',
    input: S.ConversationsReplaceInput,
    output: v,
    surfaces: CHAT,
  },
  /** 新建会话或更新元信息（新建的排在末尾） */
  'conversations.put': {
    kind: 'mutation',
    input: S.ConversationsPutInput,
    output: v,
    surfaces: CHAT,
  },
  'conversations.delete': {
    kind: 'mutation',
    input: S.ConversationsDeleteInput,
    output: v,
    surfaces: CHAT,
  },
  /** 当前会话 / 最近的 Nomi 会话 */
  'conversations.setPointers': {
    kind: 'mutation',
    input: S.ConversationsPointersInput,
    output: v,
    surfaces: CHAT,
  },
  /** 迁移：导入一个旧会话（幂等，已有的 id 不覆盖） */
  'conversations.import': {
    kind: 'mutation',
    input: S.ConversationsImportInput,
    output: S.ConversationsImportResult,
    surfaces: CHAT,
  },
  /** 迁移：核对完成后记下已导入 */
  'conversations.markMigrated': {
    kind: 'mutation',
    input: S.ConversationsMarkMigratedInput,
    output: v,
    surfaces: CHAT,
  },
  // ---- 对话标签弹出到独立窗口（docs/design/side-tabs-workspace.md）----
  /**
   * 把对话旁标签区的一个标签（子任务 / 文件预览）弹到独立的原生窗口；同一个 id 已经弹出去时把那个窗口提到最前
   * （focused = true）。spec 是视图自己解析的不透明 JSON（宿主只限长度、原样放进新窗口地址的 ?detached=）。
   */
  'chatWindow.detachTab': {
    kind: 'mutation',
    input: S.DetachTabInput,
    output: S.DetachTabResult,
    surfaces: CHAT,
  },
  /** 当前开着的弹出窗口的 id（主窗口据此在标签栏里隐藏这些标签） */
  'chatWindow.detachedTabs': {
    kind: 'query',
    input: v,
    output: z.array(z.string()),
    surfaces: CHAT,
  },
  /** 弹出窗口里「放回主窗口」：关掉这个窗口，并通知主窗口切到这个标签（chatWindow.tabDocked） */
  'chatWindow.dockTab': {
    kind: 'mutation',
    input: z.object({ id: z.string().min(1).max(2048) }),
    output: z.boolean(),
    surfaces: CHAT,
  },
} as const satisfies ProcedureMap;

export const shellEvents = {
  'theme.changed': S.ThemeState,
  'locale.changed': S.LocaleState,
  'startup.changed': S.StartupState,
  /** 设置里「重新打开新手引导」 */
  'onboarding.show': S.OnboardingState,
  'onboarding.profileChanged': S.UserProfile,
  'providers.changed': S.ProviderState,
  /** 托盘 / 菜单请对话窗口打开供应商面板 */
  'providers.openPanel': S.opaqueObject,
  /** 网关配置或状态变了：视图重新拉 `gateway.state` */
  'gateway.changed': z.null(),
  /** Nomi 对话的请求在提交点之前重连 / 换供应商（等待回复时的提示） */
  'gateway.retrying': S.GatewayRetrying,
  /** 等确认的第三方供应商链接变了（整份列表） */
  'providerLink.changed': z.array(S.ProviderLinkOffer),
  'usage.changed': z.null(),
  'quality.changed': z.null(),
  'updates.changed': S.UpdateState,
  /** 会话存储变了（`source` 是写入方传的标记）：其他窗口重新取索引、丢掉这些会话的消息缓存 */
  'conversations.changed': S.ConversationsChanged,
  /** 弹出窗口开 / 关之后的整份 id 列表 */
  'chatWindow.detachedChanged': z.array(z.string()),
  /** 弹出窗口里点了「放回主窗口」：主窗口切到这个标签 */
  'chatWindow.tabDocked': z.object({ id: z.string() }),
} as const satisfies EventMap;

/** 只推给对话窗口的事件 */
export const shellEventSurfaces = {
  'conversations.changed': ['chat'],
  'chatWindow.detachedChanged': ['chat'],
  'chatWindow.tabDocked': ['chat'],
} as const;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const shellErrors = [
  /** 链接无法处理 / 授权失败；message 是错误码（bad_issuer、bad_manifest、network 等，见 docs/integrations/provider-link.md） */
  'PROVIDER_LINK_FAILED',
  /** 会话存储里没有这个会话（已删除） */
  'CONVERSATION_NOT_FOUND',
] as const satisfies readonly string[];

export type ShellProcedureName = keyof typeof shellProcedures & string;
export type ShellEventName = keyof typeof shellEvents & string;
