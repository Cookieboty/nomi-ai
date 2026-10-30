/**
 * D2 · 应用外壳的 zod schema（只属于 D2，见 ../shell.ts）。
 *
 * 照主进程服务的返回类型与视图客户端模块的接口写：
 * - 入参：单个对象参数原样作为入参（字段照旧），标量参数包成具名对象；服务里的逐项校验保持不变，
 *   这里只拦下类型明显不对的值；
 * - 返回值与事件：字段多、会演进的用 `z.looseObject`（未知字段透传，与原 IPC 一致），只约束关键字段。
 */

import { z } from 'zod';

import { AvatarSemanticName } from '../schemas';

type Shape = Record<string, z.ZodType>;

/**
 * 运行时是 `z.looseObject`（未知字段透传，与原 IPC 一致）；类型按声明的字段推导、不带索引签名，
 * 主进程服务返回的 interface 可以直接交给处理函数，视图拿到的类型也不会混进 `unknown` 字段。
 */
export function loose<T extends Shape>(
  shape: T,
): z.ZodType<z.output<z.ZodObject<T>>, z.input<z.ZodObject<T>>> {
  return z.looseObject(shape) as unknown as z.ZodType<
    z.output<z.ZodObject<T>>,
    z.input<z.ZodObject<T>>
  >;
}

/** 形状不约束的对象（透传）：类型为 `object`，主进程的 interface 可直接返回 */
export const opaqueObject = z.custom<object>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  { message: 'Expected an object' },
);

// ---------------------------------------------------------------------------
// theme / locale
// ---------------------------------------------------------------------------

export const ThemeId = z.enum(['mist', 'graphite', 'ink', 'cream', 'sunset']);
export const ThemePref = z.union([ThemeId, z.literal('system'), z.literal('image')]);
export const ThemeState = loose({ pref: ThemePref, resolved: ThemeId });
/** 旧 id（如 `paper`）由主进程归一，所以这里只要求字符串 */
export const ThemeSetInput = z.object({ pref: z.string() });

export const Locale = z.enum(['zh-CN', 'en']);
export const LocalePref = z.union([Locale, z.literal('system')]);
export const LocaleState = loose({ pref: LocalePref, locale: Locale });
export const LocaleSetInput = z.object({ pref: z.string() });
/** 英文词典：稳定 key → 译文 */
export const LocaleDict = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// startup / onboarding
// ---------------------------------------------------------------------------

export const StartupView = z.enum(['mascot', 'main']);
export const CloseMainAction = z.enum(['hide', 'quit']);
export const StartupState = loose({
  defaultView: StartupView,
  closeMain: CloseMainAction,
  showMascot: z.boolean(),
});
/** 部分更新；字段值由 StartupService 逐项校验（非法整体拒绝） */
export const StartupPatch = z.object({
  defaultView: z.string().optional(),
  closeMain: z.string().optional(),
  showMascot: z.boolean().optional(),
});

/** 职业与兴趣（主进程 normalizeUserProfile 丢掉未知 id） */
export const UserProfile = loose({
  role: z.string().nullable(),
  interests: z.array(z.string()),
});
export const UserProfileInput = loose({
  role: z.string().nullish(),
  interests: z.array(z.string()).optional(),
});

export const OnboardingState = loose({
  done: z.boolean(),
  skipped: z.boolean().optional(),
  completedAt: z.number().optional(),
  profile: UserProfile.optional(),
});
export const OnboardingCompleteInput = z.object({ skipped: z.boolean().optional() });
/** 引导里转发给桌面角色的指令：只开放 say / motion（主进程再校验一次） */
/** 对话窗口 → 桌面角色：说一句（可带语义手势）、语义手势、正在等回复（§10.5，只有语义名） */
export const OnboardingMascotCmd = z.discriminatedUnion('type', [
  z.object({ type: z.literal('say'), text: z.string(), gesture: AvatarSemanticName.optional() }),
  z.object({ type: z.literal('gesture'), name: AvatarSemanticName }),
  z.object({ type: z.literal('reply'), phase: z.enum(['waiting', 'settled']) }),
]);

// ---------------------------------------------------------------------------
// providers（ai-runtime ProviderService 的只读视图；Key 只有掩码）
// ---------------------------------------------------------------------------

export const ProviderPreset = loose({
  id: z.string(),
  name: z.string(),
});
export const ProviderMeta = loose({
  categories: z.record(z.string(), z.string()),
  protocols: z.record(z.string(), z.string()),
});
export const ProviderState = loose({
  providers: z.array(loose({ id: z.string(), name: z.string() })),
  envProviders: z.array(loose({ id: z.string(), name: z.string() })),
  activeProviderId: z.string().optional(),
  effectiveProviderId: z.string().optional(),
  effectiveModel: z.string().optional(),
  overrideId: z.string().optional(),
});
export const ProviderSetActiveInput = z.object({
  id: z.string().nullable(),
  model: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// gateway（统一网关，主进程 GatewayService / TerminalCommands）
// ---------------------------------------------------------------------------

export const Wire = z.enum(['messages', 'responses', 'chat', 'gemini']);
/** 每种协议一个地址；键不限于已知协议（预设缺地址时界面可能带上别的键，由主进程忽略） */
const WireUrls = z.record(z.string(), z.string().optional());

export const GatewayStatus = z.union([
  loose({ state: z.literal('stopped') }),
  loose({ state: z.literal('starting') }),
  loose({ state: z.literal('running'), port: z.number(), url: z.string() }),
  loose({ state: z.literal('failed'), error: z.string() }),
]);

export const GatewayProviderView = loose({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  urls: WireUrls,
  keys: z.array(loose({ id: z.string() })),
  models: z.array(loose({ id: z.string() })),
});

export const GatewayState = loose({
  status: GatewayStatus,
  providers: z.array(GatewayProviderView),
  clients: z.partialRecord(z.string(), loose({ models: opaqueObject })),
  allowedPrivateHosts: z.array(z.string()),
  port: z.number(),
});

/** Nomi 对话的上下文预算（core gateway/nomiContext.ts） */
export const NomiContextInfo = loose({
  model: z.string(),
  window: z.number(),
  outputReserve: z.number(),
  budget: z.number(),
  compactAt: z.number(),
  source: z.string(),
});

const KeyLimit = z.number().nullable().optional();
export const GatewayProviderInput = loose({
  id: z.string().optional(),
  name: z.string(),
  presetId: z.string().optional(),
  enabled: z.boolean().optional(),
  urls: WireUrls,
  /** 明文 Key 只在这里单向进入主进程 */
  newKeys: z
    .array(
      loose({
        value: z.string(),
        name: z.string().optional(),
        wire: Wire.optional(),
        position: z.number().optional(),
        enabled: z.boolean().optional(),
        maxConcurrency: KeyLimit,
        rpm: KeyLimit,
      }),
    )
    .optional(),
  keys: z
    .array(
      loose({
        id: z.string(),
        name: z.string().optional(),
        enabled: z.boolean(),
        wire: Wire.optional(),
        maxConcurrency: KeyLimit,
        rpm: KeyLimit,
      }),
    )
    .optional(),
  models: z.array(loose({ id: z.string(), enabled: z.boolean() })).optional(),
  modelMap: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  userAgent: z.string().optional(),
  fallback: z.array(z.string()).optional(),
  detected: z.partialRecord(Wire, loose({ ok: z.boolean(), at: z.number() })).optional(),
  quirks: opaqueObject.optional(),
});

export const GatewayDetectInput = z.object({
  providerId: z.string().optional(),
  url: z.string().optional(),
  urls: WireUrls.optional(),
  keys: z.array(z.string()).optional(),
  savedKeyIds: z.array(z.string()).optional(),
  fallbackModel: z.string().optional(),
});
export const GatewayDetectResult = loose({
  wires: z.partialRecord(Wire, loose({ wire: Wire, ok: z.boolean() })),
  byKey: z.record(z.string(), z.partialRecord(Wire, loose({ ok: z.boolean() }))),
  models: z.array(z.string()),
  urls: WireUrls,
});

export const GatewaySetAssignmentInput = z.object({
  /** 'nomi' 或内置 CLI id（主进程校验，未知客户端报错） */
  client: z.string(),
  patch: loose({
    models: z.record(z.string(), z.unknown()).optional(),
    newTabSource: z.enum(['official', 'thirdParty']).optional(),
    newTabAccountId: z.string().nullish(),
  }),
});
export const GatewayClientInput = z.object({ client: z.string() });
export const GatewayOptionsPatch = z.object({
  strictParams: z.boolean().optional(),
  maxRequestBodyBytes: z.number().optional(),
  privacyMode: z.boolean().optional(),
  privacyStrict: z.boolean().optional(),
  privacyLocal: z.boolean().optional(),
  privacyShape: z.boolean().optional(),
});

export const PrivacyPreview = loose({
  text: z.string(),
  hits: z.array(loose({ kind: z.string(), action: z.string(), len: z.number(), head: z.string() })),
});
export const PrivacyLogEntry = loose({
  placeholder: z.string(),
  kind: z.string(),
  len: z.number(),
  head: z.string(),
  firstAt: z.number(),
  lastAt: z.number(),
});
/** 从最近记录放行给标记；手动放行给原文（主进程算出标记后丢掉原文） */
export const PrivacyAllowInput = z.union([
  z.object({ value: z.string() }),
  z.object({ tag: z.string(), kind: z.string(), len: z.number(), head: z.string() }),
]);
export const PrivacySecretInput = z.object({ name: z.string(), value: z.string() });
export const PrivacySetActionInput = z.object({ kind: z.string(), action: z.string() });

export const TerminalState = loose({
  enabled: z.boolean(),
  pathAdded: z.boolean(),
  binDir: z.string(),
  rcFiles: z.array(z.string()),
  pathSupported: z.boolean(),
  pathKind: z.enum(['user-path', 'shell-rc']).optional(),
  commands: z.array(z.string()),
});
export const TerminalSetInput = z.object({
  enabled: z.boolean(),
  /** true 加 PATH 段（界面已确认），false 去掉，省略保持现状 */
  addToPath: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// usage（主进程 usage/UsageService）
// ---------------------------------------------------------------------------

export const UsageRangeId = z.enum(['today', '7d', '30d', '90d']);
export const UsageSettings = loose({
  enabled: z.boolean(),
  currency: z.string(),
});
export const UsageSettingsPatch = opaqueObject;
const usageStateShape = {
  settings: UsageSettings,
  detected: z.array(z.string()),
  records: z.number(),
  lastScanAt: z.number(),
  pricing: loose({ date: z.string(), builtin: z.array(opaqueObject) }),
};
export const UsageState = loose(usageStateShape);
const UsageSummary = loose({ costUsd: z.number(), total: z.number(), calls: z.number() });
export const UsageQueryResult = loose({
  range: loose({ id: UsageRangeId, from: z.number(), to: z.number() }),
  summary: UsageSummary,
  prev: UsageSummary,
  series: z.array(loose({ t: z.number() })),
  bySource: z.array(loose({ key: z.string() })),
  byProvider: z.array(loose({ key: z.string() })),
  byModel: z.array(loose({ key: z.string() })),
});
/** 明细筛选：缺省字段由主进程补默认值（近 90 天、按时间倒序、100 条） */
export const UsageDetailQuery = z.object({
  from: z.number().optional(),
  to: z.number().optional(),
  source: z.string().optional(),
  model: z.string().optional(),
  session: z.string().optional(),
  sort: z.enum(['ts', 'tokens', 'cost', 'model', 'source']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export const UsageDetailResult = loose({
  rows: z.array(loose({ key: z.string(), ts: z.number() })),
  total: z.number(),
  summary: UsageSummary,
  facets: opaqueObject,
});
export const UsageHeatmap = loose({
  days: z.array(loose({ date: z.string() })),
  today: z.string(),
});
export const UsageEndpointInfo = loose({
  source: z.string(),
  today: UsageSummary,
  week: UsageSummary,
  series: z.array(opaqueObject),
  lastActivityAt: z.number().nullable(),
});
export const UsageQuotaEntry = loose({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'unavailable', 'api']),
  windows: z.array(loose({ id: z.string(), usedPercent: z.number() })),
});
export const UsageQuotaTool = z.enum(['claude', 'codex', 'grok']);
export const UsageQuotaRefresh = loose({
  entries: z.array(UsageQuotaEntry),
  tools: z.partialRecord(UsageQuotaTool, loose({ state: z.string() })),
});
export const UsageQuotaHook = loose({
  supported: z.boolean(),
  enabled: z.boolean(),
  hadOwnStatusLine: z.boolean(),
  hasSnapshot: z.boolean(),
});
export const UsagePriceSyncResult = loose({ ok: z.boolean() });
/** 「重新扫描」：扫描结果 + 最新状态 */
export const UsageScanResult = loose({
  ...usageStateShape,
  added: z.number(),
  files: z.number(),
});
/** 「立即同步」：同步结果 + 最新状态 */
export const UsagePriceSync = loose({ ...usageStateShape, result: UsagePriceSyncResult });

// ---------------------------------------------------------------------------
// quality（主进程 usage/quality/QualityService；类型见 @nomi-ai/types quality.ts）
// ---------------------------------------------------------------------------

export const QualityLayer = z.enum(['gateway', 'cli']);
const QualityFilters = z.record(z.string(), z.array(z.string()));
const qualityQueryShape = {
  from: z.number(),
  to: z.number(),
  layer: QualityLayer.optional(),
  filters: QualityFilters.optional(),
  groupBy: z.string().optional(),
  groupPath: z.array(z.string()).optional(),
};
export const QualityQuery = loose(qualityQueryShape);
export const QualitySeriesQuery = loose({
  ...qualityQueryShape,
  bucket: z.enum(['hour', 'day']),
  metric: z.string(),
});
export const QualityRequestsQuery = loose({
  from: z.number(),
  to: z.number(),
  layer: QualityLayer.optional(),
  filters: QualityFilters.optional(),
  limit: z.number(),
  offset: z.number().optional(),
});
export const QualityFacetsQuery = loose({
  from: z.number(),
  to: z.number(),
  layer: QualityLayer.optional(),
});
const QualityStats = loose({ key: z.string(), label: z.string() });
export const QualityResult = loose({
  total: QualityStats,
  groups: z.array(QualityStats),
  minSamples: z.number(),
});
export const QualitySeries = loose({
  buckets: z.array(z.number()),
  series: z.array(
    loose({
      key: z.string(),
      label: z.string(),
      /** 没有样本的桶为 null（指标不适用时可能是 undefined） */
      values: z.array(z.number().nullish()),
    }),
  ),
});
export const QualityRequestsPage = loose({
  items: z.array(loose({ id: z.string(), ts: z.number() })),
  total: z.number(),
});
export const QualityFacets = opaqueObject;
export const QualitySettings = loose({ retentionDays: z.number() });
export const QualitySettingsPatch = loose({ retentionDays: z.number().optional() });
export const QualityExportInput = z.object({
  kind: z.enum(['requests', 'table']),
  query: loose({ from: z.number(), to: z.number() }),
});
export const QualityExportResult = loose({
  /** 用户取消保存时为 false */
  ok: z.boolean(),
  path: z.string().optional(),
  rows: z.number(),
});

// ---------------------------------------------------------------------------
// updates / diagnostics / appIcon
// ---------------------------------------------------------------------------

export const UpdateState = loose({
  status: z.enum([
    'idle',
    'checking',
    'available',
    'not-available',
    'downloading',
    'downloaded',
    'error',
    'unavailable',
  ]),
  currentVersion: z.string(),
  availableVersion: z.string().optional(),
  releaseName: z.string().nullish(),
  releaseNotes: z.string().nullish(),
  percent: z.number().optional(),
  error: z.string().optional(),
  errorStage: z.enum(['check', 'download', 'install']).optional(),
  checkedAt: z.number().optional(),
  autoCheck: z.boolean(),
  releasePending: z.boolean().optional(),
});

export const DiagnosticsView = loose({
  enabled: z.boolean(),
  forced: z.boolean(),
  saveLogs: z.boolean(),
  dir: z.string(),
  bodyTrace: z.boolean(),
});
export const DiagnosticsExportResult = loose({
  ok: z.boolean(),
  path: z.string().optional(),
  files: z.array(z.string()).optional(),
  error: z.string().optional(),
});

export const IconVariant = z.enum(['ink', 'cream', 'sunset']);
export const AppIconState = loose({
  variant: IconVariant,
  platform: z.string(),
  /** 每个变体的预览（data URL） */
  previews: z.record(z.string(), z.string()),
});
