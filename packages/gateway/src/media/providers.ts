/**
 * 生图供应商预设与「先模型、后供应商」的绑定逻辑。Nomi 没有内置生图服务，也没有兜底：
 * 一切生成都走用户自己配置（并启用、填了 Key）的第三方供应商。
 */
import type { MediaModelChoice, MediaProtocol, ProviderBinding } from './types';

export interface MediaProviderPreset {
  id: string;
  name: string;
  baseURL: string;
  /** 该供应商默认提供的模型（用户可逐条启停 / 改上游模型名） */
  bindings: Array<Omit<ProviderBinding, 'providerRef' | 'enabled'>>;
}

export const MEDIA_PROVIDER_PRESETS: MediaProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    bindings: [
      { modelId: 'gpt-image-1', presetKey: 'openai-images', upstreamModelName: 'gpt-image-1' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    bindings: [
      {
        modelId: 'gemini-2.5-flash-image',
        presetKey: 'openrouter-chat-image',
        upstreamModelName: 'google/gemini-2.5-flash-image',
      },
    ],
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    bindings: [
      {
        modelId: 'gemini-2.5-flash-image',
        presetKey: 'gemini',
        upstreamModelName: 'gemini-2.5-flash-image',
      },
    ],
  },
  {
    id: 'volc',
    name: 'ui.media.provider-volc',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    bindings: [
      {
        modelId: 'seedream-4',
        presetKey: 'ark-image',
        upstreamModelName: 'doubao-seedream-4-0-250828',
      },
    ],
  },
  {
    id: 'fal',
    name: 'fal.ai',
    baseURL: 'https://fal.run',
    bindings: [
      { modelId: 'flux-1.1-pro', presetKey: 'fal', upstreamModelName: 'fal-ai/flux-pro/v1.1' },
      {
        modelId: 'seedream-4',
        presetKey: 'fal',
        upstreamModelName: 'fal-ai/bytedance/seedream/v4/text-to-image',
      },
    ],
  },
];

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
 * 对话默认生图供应商被停用（或删 Key / 绑定停用）时：自动切到同模型下另一家可用供应商；
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
