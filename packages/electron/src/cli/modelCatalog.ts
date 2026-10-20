/**
 * 官方账号 / CLI 自带配置路径下的模型目录与覆盖参数。
 *
 * 模型列表、每个模型支持的思考档位、默认档位一律从 CLI 自己读取（见 modelDiscovery.ts），
 * 这里不写死任何模型或档位集：
 * - Claude Code：stream-json `initialize` 控制请求的 `models`（与 `/model` 选择器同源）
 * - Codex：`codex debug models`（随当前生效的配置 / 供应商刷新）
 * - Grok：`grok agent stdio`（ACP）`session/new` 返回的 `models`
 * Gemini（ACP）/ dsh 暂不支持标签级覆盖。
 *
 * 与「第三方供应商」（改写 CLI 配置）互斥：这里只提供「标签级覆盖」的元数据，
 * 覆盖参数在每轮启动时以进程级参数（`-c` / `--model` / `-m` …）注入，不改写用户的
 * 全局 CLI 配置，因此终端里直接运行的 CLI 不受影响。
 */
import type { HarnessBackend } from './types';

/** 编程助手后端（排除 Nomi 自有） */
export type CliBackend = Exclude<HarnessBackend, 'nomi'>;

/**
 * 思考深度档位（各 CLI 取值的并集，顺序即由浅到深）。
 * 只用于识别 / 排序 CLI 返回的值；某个模型实际支持哪些档位以 CLI 返回为准。
 */
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
}

export interface BackendModelCatalog {
  backend: CliBackend;
  /** CLI 列出的可选模型（顺序与 CLI 一致） */
  models: CatalogModel[];
  /** 不传模型参数时 CLI 实际使用的模型（CLI 能告诉我们时才有） */
  defaultModel: CatalogModel | null;
  /** 读取失败的原因（此时 models 为空，界面只保留「默认模型」与自定义 id） */
  error?: string;
  /**
   * 目录来自启用中的第三方供应商（它的 `/models` 列表，默认模型 = 供应商里配置的模型）。
   * 这时没有思考深度（上游不告诉我们哪些模型支持）。
   */
  provider?: { id: string; name: string };
}

/** 有无头覆盖参数（模型 / 思考深度）的后端；Gemini ACP / dsh 暂无 */
const OVERRIDE_BACKENDS: readonly CliBackend[] = ['claude', 'codex', 'grok'];

export function supportsModelOverride(backend: string): backend is CliBackend {
  return (OVERRIDE_BACKENDS as readonly string[]).includes(backend);
}

/**
 * 模型名是否允许用于该后端：只做字符集校验（目录随账号 / 供应商变化，不能拿来卡死），
 * 是否真的可用由 CLI 报错说明。
 */
export function isAllowedModelId(backend: string, model: string): boolean {
  return supportsModelOverride(backend) && isValidModelId(model);
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
  backend: CliBackend,
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

function tomlQuoted(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 各后端无头模式的进程级覆盖参数（模型 / 思考深度）。
 * 模型合法性由调用方（setTabModel）保证；档位是否被该模型支持由调用方按目录校验。
 * - codex：`-c model="…" -c model_reasoning_effort="…"`（exec 每轮新进程）
 * - grok：`-m <id> --reasoning-effort <level>`（-p 每轮新进程）
 * - claude：`--model <id> --effort <level>`（长驻进程，切换后重启复用，见 CliHarnessService）
 */
export function overrideArgs(
  backend: CliBackend,
  o: { model?: string | null; effort?: string | null },
): string[] {
  const model = o.model?.trim();
  const effort = isReasoningEffort(o.effort) ? o.effort : null;
  const args: string[] = [];
  if (backend === 'codex') {
    if (model) args.push('-c', `model=${tomlQuoted(model)}`);
    if (effort) args.push('-c', `model_reasoning_effort=${tomlQuoted(effort)}`);
  } else if (backend === 'grok') {
    if (model) args.push('-m', model);
    if (effort) args.push('--reasoning-effort', effort);
  } else if (backend === 'claude') {
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
  }
  return args;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

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
    const m: CatalogModel = {
      id,
      label: asStr(o.displayName),
      description: asStr(o.description),
      reasoning: o.supportsEffort === true && efforts.length > 0,
      efforts,
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
  return { backend: 'claude', models, defaultModel };
}

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
    rows.push({
      m: {
        id,
        label: asStr(o.display_name),
        description: asStr(o.description),
        reasoning: efforts.length > 0,
        efforts,
        ...(isReasoningEffort(def) ? { defaultEffort: def } : {}),
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
  return { backend: 'codex', models, defaultModel };
}

/**
 * Grok：ACP `session/new` 的 `models`（availableModels + currentModelId）。
 * 档位在 `_meta.reasoningEfforts`（带 default 标记）；currentModelId 即不传参数时的默认模型。
 */
export function parseGrokModels(sessionResult: unknown): BackendModelCatalog {
  const ms = asObj(asObj(sessionResult).models);
  const models: CatalogModel[] = [];
  for (const item of Array.isArray(ms.availableModels) ? ms.availableModels : []) {
    const o = asObj(item);
    const id = asStr(o.modelId);
    if (!id) continue;
    const meta = asObj(o._meta);
    const list = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts.map(asObj) : [];
    const efforts = normalizeEfforts(list.map((e) => e.value ?? e.id));
    const def = list.find((e) => e.default === true);
    const defaultEffort = def ? (def.value ?? def.id) : meta.reasoningEffort;
    models.push({
      id,
      label: asStr(o.name),
      description: asStr(o.description),
      reasoning: meta.supportsReasoningEffort !== false && efforts.length > 0,
      efforts,
      ...(isReasoningEffort(defaultEffort) ? { defaultEffort } : {}),
    });
  }
  const current = asStr(ms.currentModelId);
  const defaultModel = (current && models.find((m) => m.id === current)) || null;
  return { backend: 'grok', models, defaultModel };
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
