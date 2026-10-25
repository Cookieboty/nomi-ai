/**
 * models.dev 的 api.json → 模型目录（§6.9.3 第 2 级来源；docs/design/unified-gateway.md §12.7.2）。
 * 纯函数：构建脚本 scripts/build-catalog.mjs 用它生成随包发布的 catalog.json，
 * 运行时「同步模型数据」用它生成覆盖层（userData），两边结果一致。
 * 输入来自网络，逐字段校验，不认识的形状一律跳过。
 */
import type { CatalogDoc } from './catalog';
import type { Effort, ModelReasoning, ModelSpecData } from './types';

/** 只收模型原厂的条目（同一个模型在中转服务里的条目字段常不全）；靠前的优先 */
const ORIGINS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshotai',
  'zhipuai',
  'alibaba',
  'minimax',
  'mistral',
];

/**
 * 原厂条目还没收录的新模型（如 deepseek-v4.1-flash 先上了中转、原厂条目滞后）：按 OpenRouter 的条目补，
 * 只补这些原厂前缀下的模型；原厂已有的不覆盖。
 */
const FALLBACK = 'openrouter';
const FALLBACK_VENDORS = [
  'openai',
  'anthropic',
  'google',
  'x-ai',
  'deepseek',
  'moonshotai',
  'z-ai',
  'qwen',
  'minimax',
  'mistralai',
];

const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 标准窗口：按上下文长度分档计价的模型，最高一档的门槛（gpt-5.4+ 272K、Gemini / Grok 200K、
 * Qwen 256K）。只在它小于最大输入时有意义——编程助手默认按它压缩，用户可按模型开启长上下文。
 * 低于 128K 的档（智谱按 32K 输入分档、Haiku 5.5 的 100K 档）只是计价阶梯，不当窗口：
 * 编程助手的系统提示与工具定义就要一二十 K，按它压缩会几乎每轮都压。
 */
const MIN_STANDARD = 128_000;

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : undefined;
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** models.dev 的 reasoning_options → 目录里的推理规格 */
function reasoningOf(m: Raw): ModelReasoning | undefined {
  if (!m.reasoning) return undefined;
  const opts = arr(m.reasoning_options)
    .map(obj)
    .filter((o): o is Raw => !!o);
  const effort = opts.find((o) => o.type === 'effort');
  const budget = opts.find((o) => o.type === 'budget_tokens');
  const toggle = opts.some((o) => o.type === 'toggle');
  const values = arr(effort?.values).filter((v): v is string => typeof v === 'string');
  const efforts = values.filter((v): v is Effort => (EFFORTS as readonly string[]).includes(v));
  const family = str(m.family) ?? str(m.id) ?? '';
  let control: ModelReasoning['control'];
  if (effort && efforts.length) control = budget && /^claude/i.test(family) ? 'adaptive' : 'effort';
  else if (budget) control = 'budget';
  else if (toggle) control = 'toggle';
  else control = 'none';
  const r: ModelReasoning = { control, ...(effort && efforts.length ? { efforts } : {}) };
  const min = posInt(budget?.min);
  const max = posInt(budget?.max);
  if (budget && (min || max)) r.budget = { ...(min ? { min } : {}), ...(max ? { max } : {}) };
  if (toggle || values.includes('none')) r.canDisable = true;
  const field = str(obj(m.interleaved)?.field);
  if (field) {
    r.passback = 'required';
    r.passbackField = field;
  }
  return r;
}

function standardOf(m: Raw): number | undefined {
  const sizes = arr(obj(m.cost)?.tiers)
    .map(obj)
    .map((t) => obj(t?.tier))
    .filter((t) => t && (!t.type || t.type === 'context'))
    .map((t) => posInt(t?.size))
    .filter((n): n is number => n !== undefined && n >= MIN_STANDARD);
  if (!sizes.length) return undefined;
  const size = Math.max(...sizes);
  const limit = obj(m.limit);
  const max = posInt(limit?.input) ?? posInt(limit?.context);
  return max && size < max ? size : undefined;
}

function entryOf(m: Raw): ModelSpecData {
  const input = arr(obj(m.modalities)?.input);
  const limit = obj(m.limit);
  const context = posInt(limit?.context);
  // 最大输入（总窗口减去为输出预留的部分）：编程助手按它压缩，比总窗口更准
  const maxInput = posInt(limit?.input);
  const standard = standardOf(m);
  const maxOutput = posInt(limit?.output);
  const family = str(m.family);
  const e: ModelSpecData = {
    ...(family ? { family } : {}),
    limits: {
      ...(context ? { context } : {}),
      ...(maxInput ? { input: maxInput } : {}),
      ...(standard ? { standard } : {}),
      ...(maxOutput ? { maxOutput } : {}),
    },
    input: { images: input.includes('image'), pdf: input.includes('pdf') },
    tools: { calling: Boolean(m.tool_call) },
  };
  const r = reasoningOf(m);
  if (r) e.reasoning = r;
  if (m.temperature === false) e.sampling = { temperature: false };
  return e;
}

const isChat = (m: Raw) => !m.type || m.type === 'chat';

/** 远程 id 写入目录时跳过原型链污染键 */
function safeCatalogKey(id: string): string | null {
  const key = id.toLowerCase();
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
  return key;
}

/** api.json → 目录；version 由调用方给（构建日 / 同步日） */
export function buildCatalog(api: unknown, version: string): CatalogDoc & { fromFallback: number } {
  const data = obj(api) ?? {};
  const models: Record<string, ModelSpecData> = Object.create(null);
  for (const pid of ORIGINS) {
    for (const [id, raw] of Object.entries(obj(obj(data[pid])?.models) ?? {})) {
      const m = obj(raw);
      if (!m || !isChat(m)) continue;
      const key = safeCatalogKey(id);
      if (!key || models[key]) continue;
      models[key] = entryOf(m);
    }
  }
  let fromFallback = 0;
  for (const [id, raw] of Object.entries(obj(obj(data[FALLBACK])?.models) ?? {})) {
    const m = obj(raw);
    const i = id.indexOf('/');
    if (!m || !isChat(m) || i <= 0) continue;
    if (!FALLBACK_VENDORS.includes(id.slice(0, i).replace(/^~/, ''))) continue;
    const key = safeCatalogKey(id.slice(i + 1));
    if (!key || models[key]) continue;
    models[key] = entryOf(m);
    fromFallback++;
  }
  const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)));
  return { version, source: 'models.dev', license: 'MIT', models: sorted, fromFallback };
}
