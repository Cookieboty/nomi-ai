/** Codex 的模型目录：codex debug models（从主进程 cli/modelCatalog.ts 搬来） */
import {
  isReasoningEffort,
  normalizeEfforts,
  type BackendModelCatalog,
  type CatalogModel,
  type ReasoningEffort,
} from '@nomi-ai/cli-sdk';

import { asObj, asStr, parsePermissionModes } from '../shared/models';

/**
 * Codex：`codex debug models` 的 JSON。只列 visibility = "list" 的模型（与 `/model` 一致）。
 * 不传参数时 Codex 用 config.toml 顶层的 `model` / `model_reasoning_effort`：
 * 默认模型在目录里找得到才认，默认档位以 config 为准（没写时用目录给的模型默认档位）。
 */
export function parseCodexModels(
  json: unknown,
  config: { model?: string | null; effort?: string | null } = {},
): BackendModelCatalog {
  const raw = asObj(json).models;
  const rows: Array<{ m: CatalogModel; priority: number }> = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const o = asObj(item);
    const id = asStr(o.slug);
    if (!id || (o.visibility !== undefined && o.visibility !== 'list')) continue;
    const levels = Array.isArray(o.supported_reasoning_levels) ? o.supported_reasoning_levels : [];
    const efforts = normalizeEfforts(levels.map((l) => asObj(l).effort));
    const def = o.default_reasoning_level;
    // input_modalities: ["text", "image"]（0.163 实测）；没给时不判断
    const modalities = Array.isArray(o.input_modalities) ? o.input_modalities : null;
    rows.push({
      m: {
        id,
        label: asStr(o.display_name),
        description: asStr(o.description),
        reasoning: efforts.length > 0,
        efforts,
        ...(isReasoningEffort(def) ? { defaultEffort: def } : {}),
        ...(modalities ? { vision: modalities.includes('image') } : {}),
      },
      // Codex 按 priority 升序展示
      priority: typeof o.priority === 'number' ? o.priority : Number.MAX_SAFE_INTEGER,
    });
  }
  const models = rows.sort((a, b) => a.priority - b.priority).map((r) => r.m);
  const cfg = config.model?.trim();
  const found = (cfg && models.find((m) => m.id === cfg)) || null;
  const defaultModel =
    found && isReasoningEffort(config.effort) && found.efforts.includes(config.effort)
      ? { ...found, defaultEffort: config.effort }
      : found;
  const permissionModes = parsePermissionModes(json);
  return {
    backend: 'codex',
    models,
    defaultModel,
    ...(permissionModes?.length ? { permissionModes } : {}),
  };
}

/** 读 Codex config.toml 顶层（第一个表头之前）的 `model` 与 `model_reasoning_effort` */
export function readCodexConfigDefaults(toml: string): {
  model: string | null;
  effort: string | null;
} {
  const out = { model: null as string | null, effort: null as string | null };
  for (const line of toml.split(/\r?\n/)) {
    const s = line.trim();
    if (s.startsWith('[')) break;
    const m = /^(model|model_reasoning_effort)\s*=\s*(["'])(.*?)\2/.exec(s);
    if (!m) continue;
    const v = m[3]!.trim() || null;
    if (m[1] === 'model') out.model = v;
    else out.effort = v;
  }
  return out;
}

function tomlQuoted(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 标签级覆盖的进程参数：`-c model="…" -c model_reasoning_effort="…"`（exec 每轮新进程） */
export function modelArgs(o: { model?: string | null; effort?: ReasoningEffort | null }): string[] {
  const model = o.model?.trim();
  return [
    ...(model ? ['-c', `model=${tomlQuoted(model)}`] : []),
    ...(o.effort ? ['-c', `model_reasoning_effort=${tomlQuoted(o.effort)}`] : []),
  ];
}
