/**
 * Nomi 对话的上下文预算：按实际路由到的模型的上下文窗口算（与编程助手启动注入用同一份元数据，
 * modelMeta.resolveModelMeta：用户手填 > 预设 > 模型列表 > 内置目录 > 保守默认值）。
 *
 * - outputReserve：给回答留的空间（输出上限，最多 32K，最多窗口的 1/4）；
 * - budget：每轮发给模型的输入上限（ai-sdk fitMessagesToBudget 的 maxTokens），超过就从最早的历史裁掉；
 * - compactAt：输入预算的 95%。视图发送前估算到这里就先把较早的对话压缩成摘要（同其它 CLI 的自动压缩）。
 */
import type { ResolvedModelMeta } from './modelMeta';

/** 自动压缩阈值：输入预算的比例 */
export const COMPACT_RATIO = 0.95;
const MAX_OUTPUT_RESERVE = 32_000;
/** 每轮最多带的历史条数（只防极端情况；主要按 token 预算裁） */
export const NOMI_MAX_MESSAGES = 1000;

export interface NomiContextInfo {
  /** 路由到的模型（providerId/modelId） */
  model: string;
  window: number;
  outputReserve: number;
  budget: number;
  compactAt: number;
  /** 窗口取自哪一级（'default' = 没查到，用的保守默认值） */
  source: string;
}

export function nomiContextBudget(
  meta: Pick<ResolvedModelMeta, 'ctx' | 'maxOutput'>,
): Pick<NomiContextInfo, 'window' | 'outputReserve' | 'budget' | 'compactAt'> {
  const window = Math.max(1, Math.floor(meta.ctx));
  const outputReserve = Math.max(
    0,
    Math.min(meta.maxOutput || MAX_OUTPUT_RESERVE, MAX_OUTPUT_RESERVE, Math.floor(window / 4)),
  );
  const budget = window - outputReserve;
  return { window, outputReserve, budget, compactAt: Math.floor(budget * COMPACT_RATIO) };
}

export type NomiRole = 'chat' | 'agent-tools' | 'summary';

/** 这次请求按哪个角色路由（显式 role 优先；否则 agent* 方法 = agent-tools，其余 = chat） */
export function chatRoleOf(role: unknown, method: string): NomiRole {
  if (role === 'chat' || role === 'agent-tools' || role === 'summary') return role;
  return method.startsWith('agent') ? 'agent-tools' : 'chat';
}

/**
 * 请求没带上下文预算、也没指定 provider 时，按路由到的模型设预算（就地改写）。
 * 调用方显式给了 context（含 false）就不动。
 */
export function applyNomiContext(
  options: { context?: unknown; provider?: unknown; role?: unknown },
  method: string,
  contextOf: (role: NomiRole) => NomiContextInfo | null,
): void {
  if (options.context !== undefined || options.provider) return;
  const info = contextOf(chatRoleOf(options.role, method));
  if (info) options.context = { maxTokens: info.budget, maxMessages: NOMI_MAX_MESSAGES };
}
