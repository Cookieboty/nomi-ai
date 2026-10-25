/**
 * 模型元数据的生效值（docs/design/unified-gateway.md §12.7.2）：上下文、输出上限、推理、图片。
 * 逐字段按优先级取第一个有值的：用户手填 > 预设（按当前版本的预设实时查，已保存的供应商也能用上
 * 后来补的值）> 已保存的预设 / 模型列表接口的值 > 内置模型目录（models.dev 快照）> 保守默认值。
 * 编程助手的启动注入、网关的请求修正、「模型」页的标签都用这里算出的同一份结果。
 */
import { bareModelId, catalogEntry } from '@nomi-ai/gateway';

import type { GatewayModel } from './types';

export type MetaSource = NonNullable<GatewayModel['metaSource']>;

/** 预设里为一个模型整理的值（ai-runtime presets 的 PresetModel） */
export interface PresetModelMeta {
  id: string;
  ctx?: number;
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
}

export interface ResolvedModelMeta {
  ctx: number;
  maxOutput: number;
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  /** 上下文取自哪一级；'default' = 哪里都没有，用的是保守默认值 */
  source: MetaSource;
  /** 输出上限取自哪一级 */
  maxOutputSource: MetaSource;
}

/** 元数据缺失时的保守默认值（§12.7.1） */
export const DEFAULT_CTX = 128_000;
/**
 * 输出上限的默认值：太小会截断长回答和推理（Claude Code 的推理预算按它的一半算）；
 * 网关只在知道模型真实上限时才压低请求，所以这里不必按最小的模型取
 */
export const DEFAULT_MAX_OUTPUT = 32_000;

type Layer = Partial<
  Pick<ResolvedModelMeta, 'ctx' | 'maxOutput' | 'reasoning' | 'vision' | 'toolCalling'>
>;

/** 预设里的条目：先按原 id，再按去掉中转前缀后的 id（预设写的是 glm-5.3，中转列的是 z-ai/glm-5.3） */
export function presetEntry(
  list: readonly PresetModelMeta[] | undefined,
  id: string,
): PresetModelMeta | undefined {
  if (!list?.length) return undefined;
  const bare = bareModelId(id);
  return list.find((m) => m.id === id) ?? list.find((m) => m.id.toLowerCase() === bare);
}

function catalogLayer(id: string): Layer | undefined {
  const c = catalogEntry(id);
  if (!c) return undefined;
  return {
    // 编程助手按「最大输入」压缩：有的模型为输出预留了一块（gpt-5：总窗口 400K、最大输入 272K），
    // 按总窗口注入会在压缩前先撞上上游的上下文超长
    ctx: c.limits?.input ?? c.limits?.context,
    maxOutput: c.limits?.maxOutput,
    // 目录只给会推理的模型写 reasoning；不能控制推理强度的（control: none）按非推理处理
    reasoning: c.reasoning ? c.reasoning.control !== 'none' : false,
    vision: c.input?.images,
    toolCalling: c.tools?.calling,
  };
}

/**
 * 一个模型的生效元数据。stored：已保存的模型条目（没有时只看预设与目录）；id：供应商模型列表里的 id。
 * 旧版本迁移来的条目可能标了 metaSource: 'user' 却没有任何值：按字段取值，空字段自然往下一级找。
 */
export function resolveModelMeta(
  stored: GatewayModel | undefined,
  id: string,
  preset?: PresetModelMeta,
): ResolvedModelMeta {
  const userSet = !stored?.metaSource || stored.metaSource === 'user';
  const layers: Array<[MetaSource, Layer | undefined]> = [
    ['user', userSet ? stored : undefined],
    ['preset', preset],
    [stored?.metaSource === 'preset' ? 'preset' : 'listed', userSet ? undefined : stored],
    ['catalog', catalogLayer(id)],
  ];
  const pick = <K extends keyof Layer>(k: K): [Layer[K], MetaSource] | undefined => {
    for (const [src, l] of layers) {
      const v = l?.[k];
      if (v !== undefined && v !== null && (typeof v !== 'number' || v > 0)) return [v, src];
    }
    return undefined;
  };
  const ctx = pick('ctx');
  const maxOutput = pick('maxOutput');
  const reasoning = pick('reasoning');
  const vision = pick('vision');
  const toolCalling = pick('toolCalling');
  return {
    ctx: ctx?.[0] ?? DEFAULT_CTX,
    maxOutput: maxOutput?.[0] ?? DEFAULT_MAX_OUTPUT,
    ...(reasoning ? { reasoning: reasoning[0] } : {}),
    ...(vision ? { vision: vision[0] } : {}),
    ...(toolCalling ? { toolCalling: toolCalling[0] } : {}),
    source: ctx?.[1] ?? 'default',
    maxOutputSource: maxOutput?.[1] ?? 'default',
  };
}
