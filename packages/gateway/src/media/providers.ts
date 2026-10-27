/**
 * 生图复用 Nomi 已有的「第三方供应商」配置（同一个供应商列表、同一份 Key / 地址 / 启用开关），
 * 这里不再有第二套供应商：只负责从供应商的模型列表里识别出图片模型（随版本打包的规则：
 * 供应商预设 / 地址 + 上游模型名 → 模型 schema + 协议），以及用户在供应商设置里的手动标记。
 */
import type { MediaModelChoice, MediaProtocol, ProviderBinding } from './types';

/** 生图需要的供应商最小信息（来自网关供应商配置，不含 Key） */
export interface SharedProvider {
  id: string;
  name: string;
  /** 创建时用的预设 id（openai / gemini / doubao / openrouter / fal …） */
  presetId?: string;
  enabled: boolean;
  /** 有可用（已启用、能解密）的 Key */
  hasKey: boolean;
  /** 各协议地址（网关的 urls：chat / responses / messages / gemini） */
  urls: Partial<Record<'messages' | 'responses' | 'chat' | 'gemini', string>>;
  models: Array<{ id: string; enabled: boolean }>;
}

/** 用户在供应商设置里对某个上游模型的标记：modelId = 图片模型 schema；null = 不是图片模型 */
export interface ImageMark {
  providerRef: string;
  upstream: string;
  modelId: string | null;
}

export interface ImageModelRule {
  modelId: string;
  protocol: MediaProtocol;
  /** 上游模型名 */
  match: RegExp;
  /** 只对这些预设 / 地址的供应商生效；都不写 = 任何供应商 */
  presets?: string[];
  host?: RegExp;
}

/** 识别规则（有先后：带供应商限定的在前） */
export const IMAGE_MODEL_RULES: ImageModelRule[] = [
  {
    modelId: 'gemini-2.5-flash-image',
    protocol: 'openrouter-chat-image',
    match: /^google\/gemini-2\.5-flash-image/i,
    presets: ['openrouter'],
    host: /openrouter\.ai/i,
  },
  {
    modelId: 'gemini-2.5-flash-image',
    protocol: 'gemini',
    match: /^(models\/)?gemini-2\.5-flash-image/i,
    presets: ['gemini'],
    host: /generativelanguage\.googleapis\.com/i,
  },
  {
    modelId: 'seedream-4',
    protocol: 'ark-image',
    match: /seedream-4/i,
    presets: ['doubao'],
    host: /volces\.com|volcengine/i,
  },
  {
    modelId: 'flux-1.1-pro',
    protocol: 'fal',
    match: /^fal-ai\/flux-pro\/v1\.1/i,
    presets: ['fal'],
    host: /fal\.(run|ai)/i,
  },
  {
    modelId: 'seedream-4',
    protocol: 'fal',
    match: /seedream\/v4/i,
    presets: ['fal'],
    host: /fal\.(run|ai)/i,
  },
  { modelId: 'gpt-image-1', protocol: 'openai-images', match: /^gpt-image-1/i },
];

/** 手动标记时（规则没覆盖到的供应商）按模型选的默认协议 */
const DEFAULT_PROTOCOL: Record<string, MediaProtocol> = {
  'gpt-image-1': 'openai-images',
  'gemini-2.5-flash-image': 'gemini',
  'seedream-4': 'ark-image',
  'flux-1.1-pro': 'fal',
};

const urlOf = (p: SharedProvider) => p.urls.chat ?? p.urls.responses ?? p.urls.gemini ?? '';

function ruleApplies(r: ImageModelRule, p: SharedProvider): boolean {
  if (!r.presets && !r.host) return true;
  return (!!p.presetId && !!r.presets?.includes(p.presetId)) || !!r.host?.test(urlOf(p));
}

/** 供应商的「种类」规则（不看模型名）：用于手动标记时选协议 */
function protocolFor(modelId: string, p: SharedProvider): MediaProtocol | undefined {
  const r = IMAGE_MODEL_RULES.find(
    (x) => x.modelId === modelId && (x.presets || x.host) && ruleApplies(x, p),
  );
  return r?.protocol ?? DEFAULT_PROTOCOL[modelId];
}

/** 按规则识别一个上游模型（不看用户标记） */
export function detectImageModel(
  p: SharedProvider,
  upstream: string,
): { modelId: string; protocol: MediaProtocol } | null {
  const r = IMAGE_MODEL_RULES.find((x) => x.match.test(upstream) && ruleApplies(x, p));
  return r ? { modelId: r.modelId, protocol: r.protocol } : null;
}

/** 生成某协议请求用的地址：Gemini 原生接口从 OpenAI 兼容地址推出 */
export function imageBaseURL(p: SharedProvider, protocol: MediaProtocol): string {
  if (protocol === 'gemini')
    return (p.urls.gemini ?? (p.urls.chat ?? '').replace(/\/openai\/?$/, '')).replace(/\/+$/, '');
  return urlOf(p).replace(/\/+$/, '');
}

/**
 * 供应商下的图片模型 = 规则识别 + 用户标记（标记优先；标为 null 的排除）。
 * 只看供应商里已启用的模型；同一 schema 在同一供应商下只取第一个上游模型。
 */
export function imageBindings(providers: SharedProvider[], marks: ImageMark[]): ProviderBinding[] {
  const out: ProviderBinding[] = [];
  for (const p of providers)
    for (const m of p.models) {
      if (!m.enabled) continue;
      const mark = marks.find((x) => x.providerRef === p.id && x.upstream === m.id);
      let hit: { modelId: string; protocol: MediaProtocol } | null = null;
      if (mark) {
        const proto = mark.modelId ? protocolFor(mark.modelId, p) : undefined;
        hit = mark.modelId && proto ? { modelId: mark.modelId, protocol: proto } : null;
      } else hit = detectImageModel(p, m.id);
      if (!hit || out.some((b) => b.providerRef === p.id && b.modelId === hit!.modelId)) continue;
      out.push({
        providerRef: p.id,
        modelId: hit.modelId,
        enabled: true,
        presetKey: hit.protocol,
        upstreamModelName: m.id,
      });
    }
  return out;
}

export const MEDIA_PROTOCOLS: readonly MediaProtocol[] = [
  'openai-images',
  'gemini',
  'ark-image',
  'openrouter-chat-image',
  'fal',
];

/** 供应商在绑定判断里需要的最小信息 */
export interface ProviderAvailability {
  id: string;
  enabled: boolean;
  hasKey: boolean;
}

export function isBindingUsable(b: ProviderBinding, providers: ProviderAvailability[]): boolean {
  if (!b.enabled) return false;
  const p = providers.find((x) => x.id === b.providerRef);
  return !!p && p.enabled && p.hasKey;
}

/** 某模型下可用的供应商（按绑定顺序） */
export function providersForModel(
  modelId: string,
  bindings: ProviderBinding[],
  providers: ProviderAvailability[],
): string[] {
  return bindings
    .filter((b) => b.modelId === modelId && isBindingUsable(b, providers))
    .map((b) => b.providerRef);
}

/** 有至少一家可用供应商的模型 */
export function usableModels(
  bindings: ProviderBinding[],
  providers: ProviderAvailability[],
): string[] {
  const out: string[] = [];
  for (const b of bindings)
    if (isBindingUsable(b, providers) && !out.includes(b.modelId)) out.push(b.modelId);
  return out;
}

export type ReconcileResult =
  | { kind: 'unchanged'; choice: MediaModelChoice | null }
  | { kind: 'switched'; choice: MediaModelChoice; from: MediaModelChoice }
  | { kind: 'cleared'; from: MediaModelChoice };

/**
 * 对话默认生图的供应商被停用（或删 Key / 模型停用）（或删 Key / 绑定停用）时：自动切到同模型下另一家可用供应商；
 * 同模型下没有可用的就清空为未配置。绝不跨模型兜底。
 */
export function reconcileChoice(
  choice: MediaModelChoice | null,
  bindings: ProviderBinding[],
  providers: ProviderAvailability[],
): ReconcileResult {
  if (!choice) return { kind: 'unchanged', choice };
  const cur = bindings.find(
    (b) => b.modelId === choice.modelId && b.providerRef === choice.providerRef,
  );
  if (cur && isBindingUsable(cur, providers)) return { kind: 'unchanged', choice };
  const alt = providersForModel(choice.modelId, bindings, providers)[0];
  if (alt)
    return {
      kind: 'switched',
      choice: { modelId: choice.modelId, providerRef: alt },
      from: choice,
    };
  return { kind: 'cleared', from: choice };
}
