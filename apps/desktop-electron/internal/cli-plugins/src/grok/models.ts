/** Grok 的模型目录：ACP session/new 返回的 models（从主进程 cli/modelCatalog.ts 搬来） */
import {
  isReasoningEffort,
  normalizeEfforts,
  type BackendModelCatalog,
  type CatalogModel,
  type ReasoningEffort,
} from '@nomi-ai/cli-sdk';

import { asObj, asStr, parsePermissionModes } from '../shared/models';

/**
 * Grok：ACP `session/new` 的 `models`（availableModels + currentModelId）。
 * 档位在 `_meta.reasoningEfforts`（带 default 标记）；currentModelId 即不传参数时的默认模型。
 */
export function parseGrokModels(sessionResult: unknown): BackendModelCatalog {
  const root = asObj(sessionResult);
  const rawModels = root.models;
  const ms = asObj(rawModels);
  // ACP returns `availableModels`; Grok also persists the same model metadata in
  // models_cache.json as a map keyed by model id. Accept both shapes so a CLI
  // version that returns only the cache form does not silently produce an empty list.
  const available = Array.isArray(ms.availableModels)
    ? ms.availableModels
    : Array.isArray(rawModels)
      ? rawModels
      : Object.entries(ms).map(([key, value]) => {
          const info = asObj(asObj(value).info);
          return {
            ...info,
            modelId: asStr(info.id) ?? asStr(info.model) ?? key,
            name: asStr(info.name) ?? asStr(info.display_name),
            _meta: info,
          };
        });
  const models: CatalogModel[] = [];
  for (const item of available) {
    const o = asObj(item);
    const id = asStr(o.modelId) ?? asStr(o.id) ?? asStr(o.model);
    if (!id) continue;
    const meta = asObj(o._meta);
    const rawEfforts = meta.reasoningEfforts ?? meta.reasoning_efforts ?? o.reasoningEfforts;
    const list = Array.isArray(rawEfforts) ? rawEfforts.map(asObj) : [];
    const efforts = normalizeEfforts(list.map((e) => e.value ?? e.id));
    const def = list.find((e) => e.default === true);
    const defaultEffort = def
      ? (def.value ?? def.id)
      : (meta.reasoningEffort ?? meta.reasoning_effort ?? o.reasoningEffort);
    models.push({
      id,
      label: asStr(o.name) ?? asStr(o.displayName) ?? asStr(o.display_name),
      description: asStr(o.description),
      reasoning:
        (meta.supportsReasoningEffort ?? meta.supports_reasoning_effort) !== false &&
        efforts.length > 0,
      efforts,
      ...(isReasoningEffort(defaultEffort) ? { defaultEffort } : {}),
    });
  }
  const current =
    asStr(ms.currentModelId) ??
    asStr(root.currentModelId) ??
    asStr(root.defaultModel) ??
    asStr(root.default_model);
  const defaultModel = (current && models.find((m) => m.id === current)) || null;
  const permissionModes = parsePermissionModes(sessionResult);
  return {
    backend: 'grok',
    models,
    defaultModel,
    ...(permissionModes?.length ? { permissionModes } : {}),
  };
}

/** 标签级覆盖的进程参数：`-m <id> --reasoning-effort <level>`（-p 每轮新进程） */
export function modelArgs(o: { model?: string | null; effort?: ReasoningEffort | null }): string[] {
  const model = o.model?.trim();
  return [...(model ? ['-m', model] : []), ...(o.effort ? ['--reasoning-effort', o.effort] : [])];
}
