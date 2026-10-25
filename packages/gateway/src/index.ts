/**
 * @nomi-ai/gateway：统一网关内核（docs/design/unified-gateway.md）。
 * 纯 Node 实现，不依赖 Electron；主进程的本地路由服务与将来的网关进程共用这里的转换逻辑。
 */
export * from './ingress';
export * from './ir';
export * from './learn';
export * from './request';
export * from './transforms';
export * from './stream';
export * from './affinity';
export * from './reasoning';
export * from './sessions';
export * from './config';
export * from './cooldown';
export * from './customTools';
export * from './errors';
export * from './fixes';
export {
  BUILTIN_SPECS,
  mergeQuirks,
  ProviderStage,
  providerSpecById,
  quirksOf,
  registerProviderSpec,
  specOf,
  type ProviderAdapterHooks,
  type ProviderSpec,
} from './providers/index';
export {
  BUILTIN_CLIENT_SPECS,
  ClientConformer,
  clientSpecOf,
  legacyClientOf,
  registerClientSpec,
  registeredClientIds,
  type ClientAdapterHooks,
  type ClientSpec,
  type ModelResolution,
} from './clients/index';
export {
  BINDING_WAIT_MS,
  BindingTable,
  hashTabToken,
  isTabToken,
  TAB_TOKEN_PREFIX,
  type BindingAck,
  type BindingMessage,
  type TabBinding,
} from './route/binding';
export { Limiter, limitsOf, type Limits } from './limits';
export {
  bareModelId,
  CATALOG_VERSION,
  catalogEntry,
  catalogOverlayVersion,
  catalogSize,
  readCatalogFile,
  setCatalogOverlay,
  type CatalogDoc,
} from './models/catalog';
export { buildCatalog } from './models/buildCatalog';
export { effectiveModel, LEARNED_TTL_MS } from './models/effective';
export { FAMILIES, familyOf } from './models/families';
export { fitLevel, UnsupportedParamError } from './models/rules/request/index';
export type { Effort, EffectiveModel, ModelSpecData, ReasoningControl } from './models/types';
export { makePlan, type Loss, type RoutePlan } from './route/plan';
export { applyRectifiers, rectifierFor, type RectifyFix } from './route/rectifiers';
export { modelsBody } from './models';
export * from './net/address';
export * from './net/loopback';
export * from './net/upstreamGuard';
export * from './net/upstreamFetch';
export * from './probe/detect';
export * from './route/native';
export * from './route/resolve';
export * from './server';
export * from './tokens';
export * from './upstream';
export * from './worker';
export { UsageTap, usageOfJson } from './usageTap';
export * from './trace';
// 模型质量：每次请求的结果分类、时间点与尝试（docs/design/model-quality.md §4.1）
export * from './quality';
export * from './metrics';
