/**
 * 模型目录（官方账号 / CLI 自带配置下，标签级覆盖用，§5.7）：各 CLI 的插件把 CLI 自己报告的模型列表
 * 解析成这里的形状；宿主据此校正思考档位。不写死任何模型或档位集。
 */

/** 思考深度档位（与 @nomi-ai/types 的 ReasoningEffort 相同；契约包不依赖其它包） */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v);
}

/** 只保留认识的档位，去重并按由浅到深排序（CLI 返回顺序不一，如 Grok 是由深到浅） */
export function normalizeEfforts(values: readonly unknown[]): ReasoningEffort[] {
  const set = new Set(values.filter(isReasoningEffort));
  return REASONING_EFFORTS.filter((e) => set.has(e));
}

export interface CatalogModel {
  /** 发给 CLI 的模型值（`--model` / `-m` / `-c model=`） */
  id: string;
  /** CLI 给的显示名（缺省用 id） */
  label?: string;
  description?: string;
  /** 支持思考深度（CLI 明确说不支持时为 false，界面隐藏滑杆） */
  reasoning: boolean;
  /** 该模型支持的档位（CLI 返回，由浅到深） */
  efforts: ReasoningEffort[];
  /** CLI 对该模型的默认档位（仅显示用：没选档位时不发参数） */
  defaultEffort?: ReasoningEffort;
  /**
   * 能不能看图：CLI / 网关明确说了才有（Codex input_modalities、网关模型的 vision）；
   * 没有 = 不知道，界面不拦，交给 CLI / 网关自己处理。
   */
  vision?: boolean;
}

export interface BackendModelCatalog {
  /** CLI id */
  backend: string;
  /** CLI 列出的可选模型（顺序与 CLI 一致） */
  models: CatalogModel[];
  /** 不传模型参数时 CLI 实际使用的模型（CLI 能告诉我们时才有） */
  defaultModel: CatalogModel | null;
  /** CLI 声明的权限 / 安全模式（原生 id）；缺省时界面使用兼容档位集。 */
  permissionModes?: string[];
  /** 读取失败的原因（此时 models 为空，界面只保留「默认模型」与自定义 id） */
  error?: string;
  /**
   * 目录来自启用中的第三方供应商（它的 `/models` 列表，默认模型 = 供应商里配置的模型）。
   * 这时没有思考深度（上游不告诉我们哪些模型支持）。
   */
  provider?: { id: string; name: string };
}

/** 厂商模型 id 字符集（字母数字 . _ - : / [ ]），不能以 - 开头，不含空白与引号，最长 128 */
export function isValidModelId(model: string): boolean {
  const id = model.trim();
  if (!id || id.length > 128) return false;
  return /^[A-Za-z0-9_][A-Za-z0-9._:/[\]-]*$/.test(id);
}

/**
 * 第三方供应商的模型目录：上游 `/models` 列出的 id，供应商里配置的模型排第一并作默认模型。
 * 上游不告诉我们哪些模型支持思考深度，一律不给档位。
 */
export function providerCatalog(
  backend: string,
  provider: { id: string; name: string; model: string },
  listed: readonly string[],
  error?: string,
): BackendModelCatalog {
  const ids = [...new Set([provider.model, ...listed].map((x) => x.trim()).filter(isValidModelId))];
  const models: CatalogModel[] = ids.map((id) => ({ id, reasoning: false, efforts: [] }));
  return {
    backend,
    models,
    defaultModel:
      (provider.model.trim() && models.find((m) => m.id === provider.model.trim())) || null,
    provider: { id: provider.id, name: provider.name },
    ...(error ? { error } : {}),
  };
}

/** 目录里所有模型档位的并集（未知的自定义模型用它） */
function catalogEfforts(catalog: BackendModelCatalog): ReasoningEffort[] {
  return normalizeEfforts(catalog.models.flatMap((m) => m.efforts));
}

/**
 * 某个模型（null = 不传模型参数，用 CLI 默认）支持的档位：
 * - 数组：支持的档位（由 CLI 返回）
 * - null：CLI 明确说该模型不支持思考深度
 * - undefined：不知道（目录还没读到 / 读取失败）
 * 自定义的未知模型给目录并集，让新上线的推理模型在 CLI 目录更新前也能调档位。
 */
export function effortsForModel(
  catalog: BackendModelCatalog | null | undefined,
  model: string | null | undefined,
): ReasoningEffort[] | null | undefined {
  if (!catalog || catalog.error) return undefined;
  const id = model?.trim();
  const m = id ? catalog.models.find((x) => x.id === id) : catalog.defaultModel;
  if (m) return m.reasoning && m.efforts.length ? m.efforts : null;
  const all = catalogEfforts(catalog);
  return all.length ? all : undefined;
}

/** 换模型 / 还原时把档位校正到该模型支持的范围；不支持或未设置时返回 null（不发参数） */
export function sanitizeEffort(
  catalog: BackendModelCatalog | null | undefined,
  model: string | null | undefined,
  effort: unknown,
): ReasoningEffort | null {
  if (!isReasoningEffort(effort)) return null;
  const levels = effortsForModel(catalog, model);
  if (levels === null) return null;
  if (levels && !levels.includes(effort)) return null;
  return effort;
}
