/**
 * EffectiveModel 的合并（§6.9.3）：族默认 → 内置目录 → 供应商覆盖 → 运行时学到的 → 用户设置，
 * 后者覆盖前者；同名字段整体替换（不是追加），避免链式顺序的脆弱性。
 * 学到的结论带有效期（默认 7 天）并记下当时的目录版本，过期或目录升级后不再采用（重新验证）。
 * 用户明确设置的值永远优先。
 */
import type { LearnedModel, LearnedState, RuntimeModel, RuntimeProvider } from '../config';
import { specOf } from '../providers/index';

import { bareModelId, catalogEntry, CATALOG_VERSION } from './catalog';
import { familyOf } from './families';
import type { EffectiveModel, ModelSpecData } from './types';

/** 学到的结论的有效期 */
export const LEARNED_TTL_MS = 7 * 24 * 60 * 60_000;

/** 两级合并：对象字段逐键覆盖，数组与标量整体替换 */
function merge(base: ModelSpecData, over: ModelSpecData | undefined): ModelSpecData {
  if (!over) return base;
  const out: ModelSpecData = { ...base };
  for (const k of Object.keys(over) as Array<keyof ModelSpecData>) {
    const v = over[k];
    if (v === undefined) continue;
    const b = base[k];
    (out as Record<string, unknown>)[k] =
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      b &&
      typeof b === 'object' &&
      !Array.isArray(b)
        ? {
            ...(b as object),
            ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)),
          }
        : v;
  }
  return out;
}

/** 用户在模型编辑页设置的（现有 RuntimeModel 字段） → 规格数据 */
function userData(m: RuntimeModel | undefined): { data: ModelSpecData; set: string[] } {
  if (!m) return { data: {}, set: [] };
  const set: string[] = [];
  const data: ModelSpecData = {};
  if (m.ctx || m.maxOutput) {
    data.limits = {
      ...(m.ctx ? { context: m.ctx } : {}),
      ...(m.maxOutput ? { maxOutput: m.maxOutput } : {}),
    };
    if (m.ctx) set.push('limits.context');
    if (m.maxOutput) set.push('limits.maxOutput');
  }
  if (m.vision !== undefined) {
    data.input = { images: m.vision };
    set.push('input.images');
  }
  if (m.toolCalling !== undefined) {
    data.tools = { calling: m.toolCalling };
    set.push('tools.calling');
  }
  if (m.reasoning === false) {
    data.reasoning = { control: 'none' };
    set.push('reasoning');
  }
  if (m.efforts?.length) {
    data.reasoning = { ...(data.reasoning ?? { control: 'effort' }), efforts: m.efforts };
    set.push('reasoning.efforts');
  }
  return { data, set };
}

/** 学到的、还有效的结论 → 规格数据 */
function learnedData(l: LearnedModel | undefined, now: number): ModelSpecData | undefined {
  if (!l || now - l.at > LEARNED_TTL_MS) return undefined;
  if (l.catalogVersion && l.catalogVersion !== CATALOG_VERSION) return undefined;
  const d: ModelSpecData = {};
  if (l.efforts?.length) d.reasoning = { control: 'effort', efforts: l.efforts };
  if (l.temperature === false) d.sampling = { temperature: false };
  return d;
}

/** until：结果里用了学到的结论时，它过期的时刻；过了就重算（#138）。没用到学习结果的一直有效 */
const cache = new WeakMap<
  RuntimeProvider,
  Map<string, { learned: unknown; until: number; e: EffectiveModel }>
>();

/**
 * 供应商里某个模型的生效规格。model 是供应商模型列表里的 id（可能带中转服务的前缀）。
 * strict：网关配置的严格模式（§6.9.6）；模型自己的 strict 优先。
 */
export function effectiveModel(
  p: RuntimeProvider,
  model: string,
  learned?: LearnedState,
  opts: { strict?: boolean; now?: number } = {},
): EffectiveModel {
  const key = `${model}\u0000${opts.strict ? 1 : 0}`;
  let byModel = cache.get(p);
  if (!byModel) cache.set(p, (byModel = new Map()));
  const hit = byModel.get(key);
  // 学到的状态随配置快照整份替换：按引用判断是否需要重算
  const now = opts.now ?? Date.now();
  if (hit && hit.learned === learned && opts.now === undefined && now < hit.until) return hit.e;
  const id = bareModelId(model);
  const sources: EffectiveModel['sources'] = [];
  let data: ModelSpecData = {};
  const fam = familyOf(id);
  if (fam) {
    const { match: _m, ...rest } = fam;
    data = merge(data, rest);
    sources.push('family');
  }
  const cat = catalogEntry(id);
  if (cat) {
    data = merge(data, cat);
    sources.push('catalog');
  }
  const spec = specOf(p);
  const provider = spec.models?.find((x) =>
    x.match.some((g) =>
      new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(id),
    ),
  );
  if (provider) {
    data = merge(data, provider.spec);
    sources.push('provider');
  }
  const learnedModel = learned?.models?.[model];
  const l = learnedData(learnedModel, now);
  const user = userData(p.models.find((m) => m.id === model));
  if (l) {
    // 用户明确设置过的不被学到的结论覆盖
    const filtered: ModelSpecData = { ...l };
    if (user.set.includes('reasoning.efforts') && filtered.reasoning) delete filtered.reasoning;
    data = merge(data, filtered);
    sources.push('learned');
  }
  if (user.set.length) {
    data = merge(data, user.data);
    sources.push('user');
  }
  const m = p.models.find((x) => x.id === model);
  const e: EffectiveModel = {
    ...data,
    id,
    userSet: user.set,
    sources,
    strict: m?.strict ?? opts.strict ?? false,
    catalogVersion: CATALOG_VERSION,
  };
  // 学到的结论还没生效（不存在 / 已过期 / 目录版本不同）时重算也不会变：一直有效
  const until = l && learnedModel ? learnedModel.at + LEARNED_TTL_MS : Infinity;
  if (opts.now === undefined) byModel.set(key, { learned, until, e });
  return e;
}
