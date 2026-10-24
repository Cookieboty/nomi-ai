/** Claude Code 的模型目录：stream-json initialize 控制响应里的 models（从主进程 cli/modelCatalog.ts 搬来） */
import {
  isReasoningEffort,
  normalizeEfforts,
  type BackendModelCatalog,
  type CatalogModel,
  type ReasoningEffort,
} from '@nomi-ai/cli-sdk';

import { asObj, asStr, parsePermissionModes } from '../shared/models';

/**
 * Claude Code：`initialize` 控制响应里的 `models`（与 `/model` 选择器同一份数据）。
 * value 是传给 `--model` 的值；value = "default" 的那项就是不传参数时的默认模型。
 */
export function parseClaudeModels(response: unknown): BackendModelCatalog {
  const raw = asObj(response).models;
  const models: CatalogModel[] = [];
  /** 模型值 → CLI 实际解析到的模型 id（别名按账号解析，如 opus → claude-opus-5-5） */
  const resolved = new Map<string, string | undefined>();
  let defaultModel: CatalogModel | null = null;
  for (const item of Array.isArray(raw) ? raw : []) {
    const o = asObj(item);
    const id = asStr(o.value);
    if (!id) continue;
    resolved.set(id, asStr(o.resolvedModel));
    const efforts = normalizeEfforts(
      Array.isArray(o.supportedEffortLevels) ? o.supportedEffortLevels : [],
    );
    const defaultEffort = o.defaultEffortLevel ?? o.defaultEffort ?? o.default_effort ?? o.effort;
    const m: CatalogModel = {
      id,
      label: asStr(o.displayName),
      description: asStr(o.description),
      reasoning: o.supportsEffort === true && efforts.length > 0,
      efforts,
      ...(isReasoningEffort(defaultEffort) ? { defaultEffort } : {}),
    };
    if (id === 'default') defaultModel = m;
    else models.push(m);
  }
  // 「Default (recommended)」不是模型名：显示名换成它实际解析到的那个模型
  if (defaultModel) {
    const target = resolved.get('default');
    const same = target ? models.find((m) => resolved.get(m.id) === target) : undefined;
    defaultModel = { ...defaultModel, label: same?.label ?? target ?? defaultModel.label };
  }
  const permissionModes = parsePermissionModes(response);
  return {
    backend: 'claude',
    models,
    defaultModel,
    ...(permissionModes?.length ? { permissionModes } : {}),
  };
}

/** 标签级覆盖的进程参数：`--model <id> --effort <level>`（长驻进程，切换后重启复用） */
export function modelArgs(o: { model?: string | null; effort?: ReasoningEffort | null }): string[] {
  const model = o.model?.trim();
  return [...(model ? ['--model', model] : []), ...(o.effort ? ['--effort', o.effort] : [])];
}
