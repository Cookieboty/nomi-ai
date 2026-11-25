/**
 * 「会话中途换了模型」的弱提示（发送下一条消息前一直显示）：
 * Agents 标签在 setTabModel / 带模型的 setTabSource 成功后记一笔，发送时清掉。
 * 只在内存里（不跨重启）；Nomi 对话不用它——直接比较最后一条助手消息的模型与当前模型。
 */
import { useSyncExternalStore } from 'react';

import { ENDPOINT_NAME } from '../utils/endpointBadge';

const switched = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 标签换了模型（model 为空串 = 回到 CLI 默认模型） */
export function noteModelSwitch(tabId: string, model: string): void {
  if (switched.get(tabId) === model) return;
  switched.set(tabId, model);
  emit();
}

/** 发送了消息（新模型已经开始接手这段会话）：提示消失 */
export function clearModelSwitch(tabId: string): void {
  if (switched.delete(tabId)) emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 这个标签自上次发送以来切到的模型；没切过返回 undefined */
export function useModelSwitch(tabId: string): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => switched.get(tabId),
    () => undefined,
  );
}

const MODEL_EFFORT_SUFFIX_RE = /^(.+?)-(minimal|low|medium|high|xhigh|max|ultra)$/i;

export function stripModelEffortSuffix(model: string): string {
  const trimmed = model.trim();
  const match = MODEL_EFFORT_SUFFIX_RE.exec(trimmed);
  return match?.[1] ? match[1] : trimmed;
}

export interface ModelSwitchCompareOptions {
  /**
   * 是否忽略原生模型 ID 末尾的思考档位后缀（如 Antigravity 的 `gemini-4-neon-high`
   * 与聚合基础模型 `gemini-4-neon`、`gemini-4-neon-medium` 均属同一模型）。
   * 含 `/` 的网关/第三方模型（如 `dashscope/qwen-max`）自动跳过后缀剥离以避免误伤。
   */
  ignoreEffortSuffix?: boolean;
  /** 当前显式思考档位（兼容将 `${model}-${effort}` 记作实际模型名的场景） */
  effort?: string;
  /** 模型名称归一化（例如通过网关 refLabel 把 `provider/model` 转为 `Provider · model`） */
  normalize?: (model: string) => string;
}

export function isSameModelForSwitch(
  recorded: string | undefined,
  current: string | undefined,
  opts?: ModelSwitchCompareOptions,
): boolean {
  const rawA = recorded?.trim();
  const rawB = current?.trim();
  if (!rawA || !rawB) return false;
  if (rawA === rawB) return true;
  const normA = opts?.normalize ? opts.normalize(rawA).trim() || rawA : rawA;
  const normB = opts?.normalize ? opts.normalize(rawB).trim() || rawB : rawB;
  if (normA === normB) return true;
  const effort = opts?.effort?.trim();
  if (effort) {
    const suf = `-${effort}`.toLowerCase();
    if (rawA.toLowerCase() === `${rawB}${suf}` || normA.toLowerCase() === `${normB}${suf}`) {
      return true;
    }
  }
  if (opts?.ignoreEffortSuffix && !rawA.includes('/') && !rawB.includes('/')) {
    return (
      stripModelEffortSuffix(rawA).toLowerCase() === stripModelEffortSuffix(rawB).toLowerCase()
    );
  }
  return false;
}

export interface SwitchTipMessage {
  role: string;
  model?: string;
  label?: string;
  runtimeBackend?: string;
  raw?: unknown;
}

export function normalizeSwitchBackend(backend?: string): string {
  const b = backend?.trim().toLowerCase() ?? '';
  return !b || b === 'api' || b === 'nomi' ? 'nomi' : b;
}

export function backendLabelForSwitch(backend: string): string {
  const key = normalizeSwitchBackend(backend);
  const mapped = (ENDPOINT_NAME as Record<string, string>)[key];
  return mapped || backend;
}

function backendOfMessage(m: SwitchTipMessage): string {
  if (m.runtimeBackend) return normalizeSwitchBackend(m.runtimeBackend);
  const rawBackend =
    m.raw && typeof m.raw === 'object'
      ? (m.raw as { runtimeBackend?: unknown }).runtimeBackend
      : undefined;
  if (typeof rawBackend === 'string' && rawBackend.trim()) {
    return normalizeSwitchBackend(rawBackend);
  }
  const label = m.label?.trim();
  if (label) {
    for (const [k, v] of Object.entries(ENDPOINT_NAME)) {
      if (v === label) return normalizeSwitchBackend(k);
    }
  }
  return 'nomi';
}

export type SwitchTipKind = 'model' | 'runtime';

export interface SwitchTip {
  kind: SwitchTipKind;
  /** 切换目标展示文案（空串表示 CLI 默认模型） */
  target: string;
}

export interface MainChatSwitchInput {
  messages: ReadonlyArray<SwitchTipMessage>;
  isCliBackend: boolean;
  currentBackend?: string;
  managedModel?: string;
  managedSource?: string;
  managedEffort?: string;
  gatewayModelLabel?: string;
  gatewayModelRef?: string | null;
  normalizeModel?: (model: string) => string;
  defaultModelLabel?: string;
}

/**
 * 主对话「会话中途切换提示」综合判断（结合 CLI 底座与模型两维）：
 * - 底座或模型任一维与上一条助手消息不一致即提示；
 * - 仅当同底座且模型相同时不提示（含 Antigravity 思考变体、网关 `provider/model` 与显示名等价）；
 * - 跨底座切换返回 `kind: 'runtime'`，同底座换模型返回 `kind: 'model'`。
 */
export function resolveMainChatSwitchTip(input: MainChatSwitchInput): SwitchTip | null {
  let last: SwitchTipMessage | undefined;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i]!;
    if (m.role === 'assistant') {
      last = m;
      break;
    }
  }
  if (!last) return null;

  const lastBackend = backendOfMessage(last);
  const currentBackend = input.isCliBackend ? normalizeSwitchBackend(input.currentBackend) : 'nomi';
  const sameBackend = lastBackend === currentBackend;
  const kind: SwitchTipKind = sameBackend ? 'model' : 'runtime';
  const formatWithBackend = (targetLabel: string): string =>
    sameBackend ? targetLabel : `${backendLabelForSwitch(currentBackend)} · ${targetLabel}`;

  if (!input.isCliBackend) {
    const currentLabel = input.gatewayModelLabel?.trim();
    if (!currentLabel) {
      return sameBackend ? null : { kind: 'runtime', target: backendLabelForSwitch('nomi') };
    }
    const currentRef = input.gatewayModelRef?.trim() || undefined;
    if (!last.model) {
      return sameBackend
        ? null
        : { kind: 'runtime', target: `${backendLabelForSwitch('nomi')} · ${currentLabel}` };
    }
    const bareRefMatch =
      sameBackend &&
      !last.model.includes('/') &&
      !last.model.includes(' · ') &&
      Boolean(currentRef?.includes('/')) &&
      currentRef!.slice(currentRef!.indexOf('/') + 1).trim() === last.model.trim();
    const sameModel =
      isSameModelForSwitch(last.model, currentLabel, { normalize: input.normalizeModel }) ||
      Boolean(
        currentRef &&
        isSameModelForSwitch(last.model, currentRef, { normalize: input.normalizeModel }),
      ) ||
      bareRefMatch;
    if (sameBackend && sameModel) return null;
    return { kind, target: formatWithBackend(currentLabel) };
  }

  const rawManaged = input.managedModel?.trim();
  const mModel = rawManaged && rawManaged !== 'cli-default' ? rawManaged : undefined;
  if (!mModel) {
    if (sameBackend) return null;
    const label = backendLabelForSwitch(currentBackend);
    return {
      kind: 'runtime',
      target: input.defaultModelLabel ? `${label} · ${input.defaultModelLabel}` : label,
    };
  }

  const displayTarget =
    (input.normalizeModel ? input.normalizeModel(mModel) : mModel).trim() || mModel;
  if (!last.model) {
    return sameBackend
      ? null
      : { kind: 'runtime', target: `${backendLabelForSwitch(currentBackend)} · ${displayTarget}` };
  }
  const sameModel = isSameModelForSwitch(last.model, mModel, {
    ignoreEffortSuffix: input.managedSource !== 'thirdParty',
    effort: input.managedEffort,
    normalize: input.normalizeModel,
  });
  if (sameBackend && sameModel) return null;
  return { kind, target: formatWithBackend(displayTarget) };
}

/**
 * 要不要显示提示：会话里已经有助手回复，切换后的模型和最后一条助手消息的模型不同
 * （切回原来的模型就不提示；旧消息没记模型时按「切过」处理）。
 */
export function modelSwitchTipFor(
  messages: ReadonlyArray<{ role: string; model?: string }>,
  target: string | undefined,
  opts?: ModelSwitchCompareOptions,
): string | null {
  if (target === undefined) return null;
  let last: { model?: string } | undefined;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]!.role === 'assistant') {
      last = messages[i];
      break;
    }
  if (!last) return null;
  if (last.model && target && isSameModelForSwitch(last.model, target, opts)) return null;
  return target;
}

/**
 * Nomi 对话：当前模型和最后一条助手消息记的模型不同（在别处换过模型也算），下一条会由新模型接手。
 * 两边都知道模型时才判断；会话还没有助手回复不提示。
 */
export function derivedSwitchTip(
  messages: ReadonlyArray<{ role: string; model?: string }>,
  current: string | undefined,
  opts?: ModelSwitchCompareOptions,
): string | null {
  if (!current) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'assistant') continue;
    return m.model && !isSameModelForSwitch(m.model, current, opts) ? current : null;
  }
  return null;
}
