/**
 * 网关超时策略（与 docs/design/unified-gateway.md §11、#93 一致）：
 * - **流式首字节**：只等响应头。SSE 头应很快到达，默认 30s。
 * - **非流式首字节**：头与正文一起返回，等的是整轮生成。思考/推理模型（DeepSeek、
 *   Claude extended thinking、o-series 等）可能数分钟才出头，默认 5 分钟；标了
 *   `reasoning` 的模型 10 分钟。
 * - **流空闲**：首字节之后上游连续无事件的上限（整轮上限的一部分），默认 180s。
 * - **首字节预算**：同一请求换候选的总时长上限。
 *
 * 环境变量（毫秒，可选）：
 * - NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS
 * - NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS
 * - NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS
 * - NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS
 * - NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_BUDGET_MS
 * - NOMI_GATEWAY_STREAM_IDLE_TIMEOUT_MS
 */
import type { Candidate } from './route/resolve';

/** 流式：首字节（响应头）前单次尝试超时 */
export const FIRST_BYTE_TIMEOUT_MS = 30_000;
/** 非流式：首字节前单次尝试超时（整轮生成） */
export const NON_STREAM_FIRST_BYTE_TIMEOUT_MS = 300_000;
/** 非流式 + 思考/推理模型：更长 */
export const REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS = 600_000;
/** 流式：首字节前所有尝试总预算 */
export const FIRST_BYTE_BUDGET_MS = 60_000;
/** 非流式：首字节前所有尝试总预算 */
export const NON_STREAM_FIRST_BYTE_BUDGET_MS = 900_000;
/** 首字节之后上游连续无事件的上限 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;

export interface TimeoutHooks {
  firstByteTimeoutMs?: number;
  nonStreamFirstByteTimeoutMs?: number;
  reasoningNonStreamFirstByteTimeoutMs?: number;
  firstByteBudgetMs?: number;
  nonStreamFirstByteBudgetMs?: number;
  streamIdleTimeoutMs?: number;
}

function envMs(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 候选模型是否标了 reasoning（思考默认开） */
export function candidateIsReasoning(cand: Candidate): boolean {
  const short = cand.publicModel.includes('/')
    ? cand.publicModel.slice(cand.provider.id.length + 1)
    : cand.publicModel;
  const m =
    cand.provider.models.find((x) => x.id === short) ??
    cand.provider.models.find((x) => x.id === cand.upstreamModel);
  return m?.reasoning === true;
}

/**
 * 单次尝试在「首字节 / 响应头」前的超时。
 * 流式：等头；非流式：等整轮（思考模型更长）。
 * hooks.firstByteTimeoutMs 显式传入时（含测试）覆盖流式路径；非流式优先
 * nonStreamFirstByteTimeoutMs / reasoningNonStream…。
 */
export function resolveFirstByteTimeoutMs(
  wantsStream: boolean,
  reasoning: boolean,
  hooks: TimeoutHooks = {},
): number {
  if (wantsStream) {
    return (
      hooks.firstByteTimeoutMs ??
      envMs('NOMI_GATEWAY_FIRST_BYTE_TIMEOUT_MS') ??
      FIRST_BYTE_TIMEOUT_MS
    );
  }
  if (reasoning) {
    return (
      hooks.reasoningNonStreamFirstByteTimeoutMs ??
      hooks.nonStreamFirstByteTimeoutMs ??
      envMs('NOMI_GATEWAY_REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS') ??
      envMs('NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS') ??
      REASONING_NON_STREAM_FIRST_BYTE_TIMEOUT_MS
    );
  }
  return (
    hooks.nonStreamFirstByteTimeoutMs ??
    envMs('NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_TIMEOUT_MS') ??
    NON_STREAM_FIRST_BYTE_TIMEOUT_MS
  );
}

/** 同一请求在拿到首字节前换候选的总时长上限 */
export function resolveFirstByteBudgetMs(wantsStream: boolean, hooks: TimeoutHooks = {}): number {
  if (wantsStream) {
    return (
      hooks.firstByteBudgetMs ?? envMs('NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS') ?? FIRST_BYTE_BUDGET_MS
    );
  }
  return (
    hooks.nonStreamFirstByteBudgetMs ??
    hooks.firstByteBudgetMs ??
    envMs('NOMI_GATEWAY_NON_STREAM_FIRST_BYTE_BUDGET_MS') ??
    envMs('NOMI_GATEWAY_FIRST_BYTE_BUDGET_MS') ??
    NON_STREAM_FIRST_BYTE_BUDGET_MS
  );
}

export function resolveStreamIdleTimeoutMs(hooks: TimeoutHooks = {}): number {
  return (
    hooks.streamIdleTimeoutMs ??
    envMs('NOMI_GATEWAY_STREAM_IDLE_TIMEOUT_MS') ??
    STREAM_IDLE_TIMEOUT_MS
  );
}
