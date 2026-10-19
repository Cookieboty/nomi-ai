/**
 * 官方账号（CLI 自带登录）路径下的可选模型目录。
 *
 * 与「第三方供应商档案」（改写 CLI 配置）互斥：这里只提供「标签级覆盖」的元数据，
 * 覆盖参数在每轮启动时以进程级参数（`-c` / `--model` / `-m` …）注入，不改写用户的
 * 全局 CLI 配置，因此终端里直接运行的 CLI 不受影响（与官方账号只切凭据的原则一致）。
 *
 * 各后端档位取值不同（见各目录的 efforts）；无头模式没有文档化覆盖参数的后端不建目录。
 */
import type { HarnessBackend } from './types';

/** 编程助手后端（排除 Nomi 自有） */
export type CliBackend = Exclude<HarnessBackend, 'nomi'>;

/** 思考深度档位（并集；UI 按模型 / 后端自己的 efforts 子集渲染，顺序即由浅到深） */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v);
}

export interface CatalogModel {
  /** 发给 CLI / API 的模型 id */
  id: string;
  /** 界面显示名（缺省用 id） */
  label?: string;
  /** 推理模型：支持思考深度切换；非推理模型不显示思考芯片 */
  reasoning?: boolean;
  /** 该模型支持的思考档位（缺省：用后端目录的档位集） */
  efforts?: readonly ReasoningEffort[];
  /** 该模型的默认思考档位（缺省：不发覆盖参数，沿用 CLI 默认） */
  defaultEffort?: ReasoningEffort;
  /** 标记即将停用等状态（置灰 + 说明） */
  deprecated?: boolean;
}

export interface BackendModelCatalog {
  backend: CliBackend;
  /** 该后端思考模型的档位集（模型未单独声明 efforts 时用它） */
  efforts: readonly ReasoningEffort[];
  models: readonly CatalogModel[];
}

/**
 * Codex 订阅可用模型（2026-10，自 Codex CLI 0.163.0 二进制模型表实证，构建时间 2026-10-09）。
 * 实际可见性随订阅套餐变化；未收录的新模型用「自定义模型 id」兜底（按字符集校验后透传）。
 */
const CODEX_CATALOG: BackendModelCatalog = {
  backend: 'codex',
  // model_reasoning_effort 稳定取值（二进制校验信息实证）
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoning: true },
    { id: 'gpt-6-pro', label: 'GPT-6 Pro', reasoning: true },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', reasoning: true },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', reasoning: true },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', reasoning: true },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoning: true },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', reasoning: true },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', reasoning: true },
    { id: 'gpt-5.5', label: 'GPT-5.5', reasoning: true },
    { id: 'gpt-5.4', label: 'GPT-5.4', reasoning: true },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', reasoning: true },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', reasoning: true },
    { id: 'gpt-5.2', label: 'GPT-5.2', reasoning: true },
    { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', reasoning: true },
    { id: 'gpt-4.1', label: 'GPT-4.1', reasoning: false },
  ],
};

/**
 * Claude Code 模型（2026-10，claude --help 与二进制模型表实证）。
 * 用官方文档化的模型别名（fable / opus / sonnet），始终指向最新代，避免目录过期；
 * 具体版本号可用「自定义模型 id」（如 claude-opus-4-8）。
 * --effort 档位：low / medium / high / xhigh / max（--help 实证）。
 * label 保持模型名（界面注记由渲染层 i18n 承担，不在数据里写死语言）。
 */
const CLAUDE_CATALOG: BackendModelCatalog = {
  backend: 'claude',
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  models: [
    { id: 'fable', label: 'Fable', reasoning: true },
    { id: 'opus', label: 'Opus', reasoning: true },
    { id: 'sonnet', label: 'Sonnet', reasoning: true },
  ],
};

/**
 * Grok Build 模型（2026-10，grok.exe 二进制模型表实证；默认模型解析为 grok-4.6）。
 * --reasoning-effort（别名 --effort）校验取值：none/minimal/low/medium/high/xhigh/max。
 * 「none」由「默认 / 不发参数」承担，档位只收五档半（minimal..max）。
 */
const GROK_CATALOG: BackendModelCatalog = {
  backend: 'grok',
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  models: [
    { id: 'grok-4.7', label: 'Grok 4.7', reasoning: true },
    { id: 'grok-4.7-high-fast', label: 'Grok 4.7 High Fast', reasoning: true },
    { id: 'grok-4.6', label: 'Grok 4.6', reasoning: true },
    { id: 'grok-4.5', label: 'Grok 4.5', reasoning: true },
    { id: 'grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning', reasoning: true },
    { id: 'grok-4-1-fast-nocompact', label: 'Grok 4.1 Fast', reasoning: true },
    { id: 'grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast', reasoning: false },
  ],
};

/** 各后端目录（只有有无头覆盖参数的后端出现；Gemini ACP / dsh 暂无文档化参数） */
const CATALOGS: Partial<Record<CliBackend, BackendModelCatalog>> = {
  codex: CODEX_CATALOG,
  claude: CLAUDE_CATALOG,
  grok: GROK_CATALOG,
};

export function modelCatalog(backend: CliBackend): BackendModelCatalog | null {
  return CATALOGS[backend] ?? null;
}

export function catalogModel(backend: CliBackend, model: string): CatalogModel | null {
  const c = modelCatalog(backend);
  if (!c) return null;
  return c.models.find((m) => m.id === model) ?? null;
}

/**
 * 模型名是否允许用于该后端：目录内模型，或合法的自定义模型 id。
 * 自定义兜底让官方新上线、目录尚未收录的模型立即可用。
 */
export function isAllowedModelId(backend: CliBackend, model: string): boolean {
  const id = model.trim();
  if (!id || id.length > 128) return false;
  // 没有模型目录的后端（Gemini / dsh）一律不接受覆盖
  if (!modelCatalog(backend)) return false;
  if (catalogModel(backend, id)) return true;
  // 自定义：厂商模型 id 字符集（字母数字 . _ - : /），不能以 - 开头，不含空白与引号
  return /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/.test(id);
}

/**
 * 模型支持的思考档位。
 * - 非推理模型（目录内显式标记）：null（界面隐藏思考芯片）
 * - 未知模型（用户自定义的新模型名）：给后端完整档位；是否真正支持由 CLI 返回的错误说明，
 *     避免官方新上线推理模型在目录更新前完全无法调档位
 */
export function effortsForModel(
  backend: CliBackend,
  model: string,
): readonly ReasoningEffort[] | null {
  const c = modelCatalog(backend);
  if (!c) return null;
  const m = catalogModel(backend, model);
  if (m) {
    if (!m.reasoning) return null;
    return m.efforts ?? c.efforts;
  }
  return c.efforts;
}

/** 切换模型时把思考档位校正到该模型支持的范围；不支持时返回 null（隐藏思考芯片） */
export function sanitizeEffort(
  backend: CliBackend,
  model: string,
  effort: unknown,
): ReasoningEffort | null {
  const levels = effortsForModel(backend, model);
  if (!levels) return null;
  if (isReasoningEffort(effort) && levels.includes(effort)) return effort;
  return catalogModel(backend, model)?.defaultEffort ?? null;
}

/** 档位是否属于该后端（未选具体模型、只调档位时用后端档位集校验） */
export function isBackendEffort(backend: CliBackend, effort: unknown): effort is ReasoningEffort {
  const c = modelCatalog(backend);
  return !!c && isReasoningEffort(effort) && c.efforts.includes(effort);
}

function tomlQuoted(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 各后端无头模式的进程级覆盖参数（模型 / 思考深度）。
 * 模型合法性（含自定义字符集）由调用方（setTabModel）保证；档位在这里按后端档位集
 * 做最后一道过滤（codex 无 max、claude 无 minimal），模型级子集同样由调用方保证。
 * - codex：`-c model="…" -c model_reasoning_effort="…"`（exec 每轮新进程）
 * - grok：`-m <id> --reasoning-effort <level>`（-p 每轮新进程）
 * - claude：`--model <id> --effort <level>`（长驻进程，切换后重启复用，见 CliHarnessService）
 */
export function overrideArgs(
  backend: CliBackend,
  o: { model?: string | null; effort?: string | null },
): string[] {
  const model = o.model?.trim();
  const effort = isBackendEffort(backend, o.effort) ? o.effort : null;
  if (backend === 'codex') {
    const args: string[] = [];
    if (model) args.push('-c', `model=${tomlQuoted(model)}`);
    if (effort) args.push('-c', `model_reasoning_effort=${tomlQuoted(effort)}`);
    return args;
  }
  if (backend === 'grok') {
    const args: string[] = [];
    if (model) args.push('-m', model);
    if (effort) args.push('--reasoning-effort', effort);
    return args;
  }
  if (backend === 'claude') {
    const args: string[] = [];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return args;
  }
  return [];
}
