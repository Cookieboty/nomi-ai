/**
 * 模型质量（docs/design/model-quality.md §2、§4.1）：网关层每个请求的结果分类、各阶段时间与每次尝试。
 * 与 @nomi-ai/types 的 quality.ts 结构一致（网关内核不依赖它，主进程做类型兼容检查）。
 */

/** 一次请求 / 一次尝试的结果（§2.3） */
export type QualityOutcome =
  | 'ok'
  | 'client-cancel'
  | 'auth'
  | 'rate-limit'
  | 'upstream-5xx'
  | 'first-byte-timeout'
  | 'pre-commit-error'
  | 'stream-break'
  | 'idle-timeout'
  | 'protocol-violation'
  | 'repetition-stop'
  | 'request-rejected'
  | 'gateway-error'
  | 'cli-error'
  | 'cli-exit';

/** 各阶段时间点，都相对请求起点（网关收到请求，ms） */
export interface QualityTiming {
  /** 成功的那次尝试拿到上游响应头 */
  headersMs?: number;
  /** 第一个内容事件（正文 / 推理 / 工具调用任一）= TTFT（流式即提交点） */
  firstContentMs?: number;
  /** 第一个正文 token */
  firstTextMs?: number;
  /** 最后一个内容事件 */
  lastContentMs?: number;
  /** 最后一个字节写给客户端 = E2E */
  endMs: number;
}

/** 每个候选一次尝试（供应商 / Key 视角按尝试计数） */
export interface QualityAttempt {
  provider: string;
  keyId?: string;
  model: string;
  upstreamWire?: string;
  status?: number;
  outcome: QualityOutcome;
  /** 这次尝试的耗时（从开始排队到拿到结果） */
  ms: number;
  /** 这次尝试拿到响应头的时间（相对这次尝试开始） */
  headersMs?: number;
  /** 失败的简短类别（不含正文） */
  errorKind?: string;
}

/** 生成时长不到这个值、输出又不少：上游缓冲后整段吐出（§2.2 突发度） */
export const BURST_MAX_GEN_MS = 100;
export const BURST_MIN_OUTPUT_TOKENS = 20;

export function isBurst(
  firstContentMs: number | undefined,
  lastContentMs: number | undefined,
  outputTokens: number | undefined,
): boolean {
  if (firstContentMs === undefined || lastContentMs === undefined) return false;
  return (
    lastContentMs - firstContentMs < BURST_MAX_GEN_MS &&
    (outputTokens ?? 0) >= BURST_MIN_OUTPUT_TOKENS
  );
}

/** 请求本身的问题（不算供应商质量）：错误文本里的上下文超长 / 请求过大 */
const REJECTED_TEXT =
  /context(?:[ _-]?length| window)|too many tokens|maximum context|prompt is too long|request too large|payload too large/i;

/**
 * 一次失败的尝试 → 结果分类（§2.3）。upstreamStatus 是上游真实返回的状态码；
 * 没有它时是网关本地产生的失败（连接失败、首字节超时、排队超时、请求检查）。
 */
export function classifyAttemptFailure(f: {
  status: number;
  upstreamStatus?: number;
  network?: boolean;
  text?: string;
  message?: string;
}): { outcome: QualityOutcome; errorKind?: string } {
  const s = f.upstreamStatus;
  const text = `${f.text ?? ''} ${f.message ?? ''}`;
  if (s !== undefined) {
    if (s === 401 || s === 403) return { outcome: 'auth', errorKind: String(s) };
    if (s === 429) return { outcome: 'rate-limit', errorKind: '429' };
    if (s >= 500) return { outcome: 'upstream-5xx', errorKind: String(s) };
    if (s >= 300 && s < 400) return { outcome: 'upstream-5xx', errorKind: 'redirect' };
    // 其余 4xx（400 / 404 / 413 / 422、上下文超长等）：请求本身的问题
    return {
      outcome: 'request-rejected',
      errorKind: REJECTED_TEXT.test(text) ? 'context-length' : String(s),
    };
  }
  if (f.network) return { outcome: 'upstream-5xx', errorKind: 'connect' };
  if (f.status === 504) return { outcome: 'first-byte-timeout' };
  if (f.status === 429) return { outcome: 'rate-limit', errorKind: 'local-limit' };
  if (f.status === 400) return { outcome: 'request-rejected', errorKind: 'local-check' };
  return { outcome: 'gateway-error' };
}

/** 提交点之前收到错误事件（§6.11.2）：按推断出的状态码归类 */
export function classifyPreCommit(p: { status: number; upstreamStatus?: number }): {
  outcome: QualityOutcome;
  errorKind?: string;
} {
  const s = p.upstreamStatus ?? p.status;
  if (s === 429) return { outcome: 'rate-limit', errorKind: 'event' };
  if (s === 529) return { outcome: 'upstream-5xx', errorKind: 'overloaded' };
  return { outcome: 'pre-commit-error' };
}

/**
 * 提交之后上游流里的错误事件（解码器给出的 errorType / 文本）→ 结果分类：
 * 非法工具调用 = 协议不合规；内容被拦 = 请求被拒；其余（上游报错、没有结束标记就断开）= 断流。
 */
export function classifyStreamError(
  message: string,
  errorType?: string,
): {
  outcome: QualityOutcome;
  errorKind: string;
} {
  if (/invalid tool call/i.test(message))
    return { outcome: 'protocol-violation', errorKind: 'invalid-tool-call' };
  if (/(response|prompt) blocked/i.test(message))
    return { outcome: 'request-rejected', errorKind: 'blocked' };
  if (/ended (before completion|without any data)/i.test(message))
    return { outcome: 'stream-break', errorKind: 'no-terminal' };
  return { outcome: 'stream-break', errorKind: errorType || 'upstream-error' };
}
