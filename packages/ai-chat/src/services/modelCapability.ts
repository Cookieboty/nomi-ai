/**
 * 模型能力（视觉等）：统一从网关 state 的供应商 / 模型元数据取，没有元数据时返回 undefined（未知）。
 * 视图里判断「能不能看图」只走这里，不要再各写一套。
 */
import { t } from '@nomi-ai/ui';

import type { GatewayState } from './gatewayClient';
import { gatewayStateSnapshot, nomiMainRef, splitRef } from './nomiModel';
import { effectiveProviderRef, providerDisplayName } from './providerClient';

/** `供应商/模型` → 网关里的模型元数据；找不到时 undefined */
export function modelMetaOf(
  s: GatewayState | null,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
) {
  if (!s || !providerId || !modelId) return undefined;
  return s.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
}

/** 指定供应商 / 模型的视觉能力：元数据写明了就以它为准，没有元数据时 undefined */
export function visionOf(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  s: GatewayState | null = gatewayStateSnapshot(),
): boolean | undefined {
  const m = modelMetaOf(s, providerId, modelId);
  return m?.effective?.vision ?? m?.vision;
}

/** Nomi 对话当前模型（含 NOMI_PROVIDER 覆盖）的 `供应商/模型`；不知道时 undefined */
export function currentModelRef(s: GatewayState | null = gatewayStateSnapshot()): string | null {
  return effectiveProviderRef() ?? nomiMainRef(s);
}

/**
 * Nomi 对话当前模型（含覆盖）的视觉能力。
 * 覆盖时按覆盖后的模型取，不再一律当成未知——那会把能看图的模型误判成不支持。
 */
export function currentVision(
  s: GatewayState | null = gatewayStateSnapshot(),
): boolean | undefined {
  const r = splitRef(currentModelRef(s) ?? '');
  return r ? visionOf(r.provider, r.model, s) : undefined;
}

/**
 * 当前模型不能看图时的提示：有能看图的模型就点名（最多 2 个），一个都没有时用不带候选的那条。
 */
export function visionUnsupportedHint(s: GatewayState | null = gatewayStateSnapshot()): string {
  const labels = visionFallbackLabels(s);
  return labels.length
    ? t('ui.knowledge-local.images-unsupported-switch-to', labels.join(' / '))
    : t('ui.knowledge-local.images-unsupported');
}

/**
 * 「建议切换到」用的候选：用户已启用、元数据写明能看图的模型，优先当前供应商，最多 2 个。
 * 返回显示名（供应商名 · 模型名）；一个都没有时 undefined。
 */
export function visionFallbackLabels(
  s: GatewayState | null = gatewayStateSnapshot(),
  max = 2,
): string[] {
  if (!s) return [];
  const cur = splitRef(currentModelRef(s) ?? '');
  const out: string[] = [];
  const seen = new Set<string>();
  const providers = [...s.providers].sort(
    (a, b) => Number(b.id === cur?.provider) - Number(a.id === cur?.provider),
  );
  for (const p of providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (!m.enabled || (m.effective?.vision ?? m.vision) !== true) continue;
      if (cur && p.id === cur.provider && m.id === cur.model) continue;
      const label = `${providerDisplayName(p.name)} · ${m.label ?? m.id}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
      if (out.length >= max) return out;
    }
  }
  return out;
}
