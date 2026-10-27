/**
 * 添加第三方供应商的公共逻辑（§4.2）：预设地址、探测结果 → 模型行、保存进网关。
 * 设置 →「模型」页与新手引导共用同一个内联表单（ProviderForm），这里是它背后的纯函数。
 */
import { t } from '@nomi-ai/ui';

import {
  gatewayClient,
  isPrivateUrl,
  WIRES,
  type DetectResult,
  type GatewayModel,
  type ProviderView,
  type StoredProbe,
  type Wire,
} from '../../services/gatewayClient';
import type { Protocol, ProviderPreset } from '../../services/providerClient';

export type PresetGroup = 'vendor' | 'platform' | 'local';

const PROTOCOL_WIRE: Record<Protocol, Wire> = {
  anthropic: 'messages',
  'openai-responses': 'responses',
  'openai-chat': 'chat',
};

/** 不能用来对话的模型（图像、向量、语音等）：列出来但默认不启用，也不给编程助手选 */
export const NON_CHAT =
  /image|embed|tts|whisper|dall-e|audio|speech|video|seedance|rerank|moderation/i;

/** 探测结果 → 存进供应商的 detected（每种协议最近一次的结果） */
export function storedProbes(result: DetectResult): Partial<Record<Wire, StoredProbe>> {
  const at = Date.now();
  const detected: Partial<Record<Wire, StoredProbe>> = {};
  for (const w of WIRES) {
    const l = result.wires[w];
    if (l)
      detected[w] = {
        ok: l.ok,
        at,
        ...(l.status ? { status: l.status } : {}),
        ...(l.model ? { model: l.model } : {}),
        ...(l.auth ? { auth: l.auth } : {}),
        ...(l.error ? { error: l.error } : {}),
      };
  }
  return detected;
}

/** 预设里各协议的地址：有多地址扩展（§8.4）用它，否则只有 baseURL 那一种 */
export const presetUrls = (p: ProviderPreset): Partial<Record<Wire, string>> =>
  p.urls ?? { [PROTOCOL_WIRE[p.protocol]]: p.baseURL };

/** 预设推荐的模型：整理过元数据的主力模型 */
export const recommendedOf = (p: ProviderPreset | null): string[] =>
  p ? [...(p.modelMeta ?? []).map((m) => m.id), ...p.models] : [];

export const groupOf = (p: ProviderPreset): PresetGroup =>
  !p.requiresApiKey && isPrivateUrl(p.baseURL)
    ? 'local'
    : p.category === 'platform'
      ? 'platform'
      : 'vendor';

/** 探测结果 → 模型行：有模型列表用列表，否则用预设推荐 + 测试模型 */
export function modelRows(
  result: DetectResult,
  preset: ProviderPreset | null,
  testModel = '',
): ModelRow[] {
  const recommended = new Set(recommendedOf(preset));
  const listed = result.models.length
    ? result.models
    : [...recommended, testModel.trim()].filter(Boolean);
  return [...new Set(listed)].map((id) => ({
    id,
    recommended: recommended.has(id),
    chat: !NON_CHAT.test(id),
  }));
}

/** 默认启用的模型：列表里有预设推荐的就只启用推荐的，否则全部对话模型 */
export function defaultEnabled(rows: ModelRow[]): Set<string> {
  const chat = rows.filter((x) => x.chat);
  const preferred = chat.filter((x) => x.recommended);
  return new Set((preferred.length ? preferred : chat).map((x) => x.id));
}

/** 把检测过的供应商存进网关（设置里的模型页与新手引导共用） */
export function saveDetectedProvider(input: {
  result: DetectResult;
  preset: ProviderPreset | null;
  name: string;
  keys: string[];
  models: ModelRow[];
  enabled: Set<string>;
}): Promise<ProviderView> {
  const { result, preset, name, keys, models, enabled } = input;
  const meta = new Map((preset?.modelMeta ?? []).map((m) => [m.id, m]));
  const list: GatewayModel[] = models.map((m) => {
    const known = meta.get(m.id);
    // 预设没整理的，用模型列表接口顺带返回的上限（§12.7.2 第 3 级）
    const listed = known ? undefined : result.limits?.[m.id];
    return {
      id: m.id,
      enabled: enabled.has(m.id),
      // 预设整理过的元数据（§12.7.2 第 2 级）一起存下，编程助手按它注入上下文与输出上限
      ...(known
        ? {
            ctx: known.ctx,
            maxOutput: known.maxOutput,
            reasoning: known.reasoning,
            vision: known.vision,
            toolCalling: known.toolCalling,
            metaSource: 'preset' as const,
          }
        : m.chat
          ? {}
          : { toolCalling: false }),
      ...(listed ? { ...listed, metaSource: 'listed' as const } : {}),
    };
  });
  return gatewayClient.upsertProvider({
    name: name.trim() || preset?.name || t('ui.models.custom-provider'),
    ...(preset ? { presetId: preset.id } : {}),
    ...(preset?.quirks ? { quirks: preset.quirks } : {}),
    urls: result.urls,
    newKeys: keys.map((value) => ({ value })),
    models: list,
    detected: storedProbes(result),
  });
}

export interface ModelRow {
  id: string;
  recommended: boolean;
  chat: boolean;
}
