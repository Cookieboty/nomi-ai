/**
 * D2 · 应用外壳（docs/design/core-host-decoupling.md §12 P1b）。
 *
 * 本文件只属于 D2：过程、事件、业务错误码都在这里声明，`app/index.ts` 负责汇总。
 * 命名空间：theme、locale、startup、onboarding、providers、gateway、usage、quality、updates、diagnostics、appIcon、
 * migration（过程 / 事件名 `<命名空间>.<方法>`，驼峰，不用连字符）。
 *
 * 旧面（迁入后由收尾批次删除）：
 * - `ai:theme:*`、`ai:locale:*`（packages/ui 的 theme.ts / i18n.ts）、`ai:startup:*`、`ai:onboarding:*`
 * - `ai:providers:*`（ai-runtime ProviderIpcServer，含事件 `ai:providers:changed` / `ai:providers:open-panel`）
 * - `ai:gateway:*`（含 TerminalCommands 的 `ai:gateway:terminal-*`）、`ai:usage:*`、`ai:quality:*`
 * - `updates:*`、`diagnostics:*`、`app-icon:*`（electronAPI.updates / diagnostics / appIcon）
 *
 * 约定见设计稿 §12「P1b 实施约定」：zod schema 从现有类型写、只用可序列化值；
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
  /** 用户确认后才允许网关访问本机 / 局域网地址（§15） */
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
  'usage.changed': z.null(),
  'quality.changed': z.null(),
  'updates.changed': S.UpdateState,
} as const satisfies EventMap;

/** 业务错误码（UPPER_SNAKE_CASE，不得与其他域重名）；处理函数用 `ctx.fail(code, message)` 抛出 */
export const shellErrors = [] as const satisfies readonly string[];

export type ShellProcedureName = keyof typeof shellProcedures & string;
export type ShellEventName = keyof typeof shellEvents & string;
