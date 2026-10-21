/**
 * Nomi 对话当前用的模型（docs/design/unified-gateway.md §12.5）：以网关里 clients.nomi.models.main 为准；
 * 网关里还没分配时退回旧存储（过渡期，环境变量供应商也在那里）。
 * 缓存一份网关状态供同步读取（消息上的模型标签），网关变化时刷新。
 */
import type { PickerProvider } from '@nomi-ai/ui';
import { useEffect, useState } from 'react';

import {
  gatewayClient,
  gatewayClientAvailable,
  WIRE_LABEL,
  WIRES,
  type GatewayState,
  type ProviderView,
} from './gatewayClient';
import { effectiveProviderLabel, providerDisplayName } from './providerClient';

let cached: GatewayState | null = null;
const listeners = new Set<(s: GatewayState) => void>();
/** 已订阅的桥（窗口重载 / 测试换桥后要重新订阅） */
let watched: unknown = null;
let unwatch: (() => void) | null = null;

const currentBridge = (): unknown =>
  typeof window === 'undefined' ? null : (window as unknown as { aiIPC?: unknown }).aiIPC;

function publish(s: GatewayState): GatewayState {
  cached = s;
  for (const fn of listeners) fn(s);
  return s;
}

/** 重新拉一次网关状态 */
export function refreshNomiModel(): void {
  if (!gatewayClientAvailable()) return;
  void gatewayClient
    .state()
    .then(publish)
    .catch(() => undefined);
}

/** 拉一次网关状态并订阅变化（同一个桥只订阅一次；每次调用都会刷新） */
export function watchNomiModel(): void {
  if (!gatewayClientAvailable()) return;
  const b = currentBridge();
  if (watched !== b) {
    unwatch?.();
    watched = b;
    unwatch = gatewayClient.onChanged(refreshNomiModel);
  }
  refreshNomiModel();
}

/** 当前缓存的网关状态（可能还没拉到） */
export function gatewayStateSnapshot(): GatewayState | null {
  return cached;
}

/** 网关状态（组件用）：挂载时刷新一次并订阅，所有组件共享同一份 */
export function useGatewayState(): GatewayState | null {
  const [s, setS] = useState<GatewayState | null>(cached);
  useEffect(() => {
    listeners.add(setS);
    // 挂载后立即刷新一次：拿到的新状态经 publish 推给所有订阅者（含这里）
    watchNomiModel();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

export function splitRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : null;
}

/** `供应商/模型` → 「供应商名 · 模型」；供应商不在网关里时原样返回 */
export function refLabel(s: GatewayState | null, ref: string): string {
  const r = splitRef(ref);
  const p = r ? s?.providers.find((x) => x.id === r.provider) : undefined;
  if (!r || !p) return ref;
  const m = p.models.find((x) => x.id === r.model);
  return `${providerDisplayName(p.name)} · ${m?.label ?? r.model}`;
}

/** 消息上的模型标签：网关分配优先，没有再看旧存储 */
export function nomiModelLabel(): string | undefined {
  const main = cached?.clients.nomi?.models.main;
  if (main) return refLabel(cached, main);
  return effectiveProviderLabel();
}

/** 当前 main 模型的元数据（视觉等能力判断用）；不知道时 undefined */
export function nomiModelMeta(): ProviderView['models'][number] | undefined {
  const r = splitRef(cached?.clients.nomi?.models.main ?? '');
  if (!r) return undefined;
  return cached?.providers.find((p) => p.id === r.provider)?.models.find((m) => m.id === r.model);
}

/** 设为 Nomi 对话的模型（立即生效；托盘、斜杠命令、「模型」页共用） */
export const setNomiModel = (ref: string) =>
  gatewayClient.setAssignment('nomi', { models: { main: ref } });

/** 选择器用的供应商列表：只列启用的供应商里启用的模型 */
export function pickerProviders(list: ProviderView[]): PickerProvider[] {
  return list
    .filter((p) => p.enabled)
    .map((p) => {
      const okWires = WIRES.filter((w) => p.detected?.[w]?.ok ?? Boolean(p.urls[w]));
      return {
        id: p.id,
        name: providerDisplayName(p.name),
        models: p.models
          .filter((m) => m.enabled)
          .map((m) => ({
            id: m.id,
            label: m.label,
            ctx: m.ctx,
            reasoning: m.reasoning,
            vision: m.vision,
            toolCalling: m.toolCalling,
            metaKnown: m.metaSource ? m.metaSource !== 'default' : undefined,
            wire: WIRE_LABEL[m.wires?.[0] ?? okWires[0] ?? 'chat'],
          })),
      };
    })
    .filter((p) => p.models.length);
}

/** 斜杠命令 /model 的候选：每个启用的模型一项 */
export function nomiModelChoices(
  s: GatewayState | null,
): Array<{ ref: string; provider: string; model: string; label: string; current: boolean }> {
  if (!s) return [];
  const main = s.clients.nomi?.models.main;
  return pickerProviders(s.providers).flatMap((p) =>
    p.models.map((m) => ({
      ref: `${p.id}/${m.id}`,
      provider: p.name,
      model: m.id,
      label: `${p.name} · ${m.label ?? m.id}`,
      current: `${p.id}/${m.id}` === main,
    })),
  );
}
