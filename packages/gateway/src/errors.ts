/**
 * 错误按入口协议编码（docs/design/unified-gateway.md §9.6），让各 CLI 自带的重试逻辑能识别。
 */
import type { Wire } from './ir';

export type ErrorKind =
  'rate_limit' | 'overloaded' | 'auth' | 'invalid' | 'not_found' | 'context' | 'upstream';

export function kindOfStatus(status: number, message = ''): ErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 503 || status === 529) return 'overloaded';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 400 && /context|too long|maximum context|token limit/i.test(message))
    return 'context';
  if (status >= 400 && status < 500) return 'invalid';
  return 'upstream';
}

const STATUS: Record<ErrorKind, number> = {
  rate_limit: 429,
  overloaded: 503,
  auth: 401,
  invalid: 400,
  not_found: 404,
  context: 400,
  upstream: 502,
};

export function errorResponse(
  ingress: Wire,
  kind: ErrorKind,
  message: string,
): { status: number; body: unknown } {
  const status = ingress === 'messages' && kind === 'overloaded' ? 529 : STATUS[kind];
  if (ingress === 'messages') {
    const type = {
      rate_limit: 'rate_limit_error',
      overloaded: 'overloaded_error',
      auth: 'authentication_error',
      invalid: 'invalid_request_error',
      not_found: 'not_found_error',
      context: 'invalid_request_error',
      upstream: 'api_error',
    }[kind];
    // 「prompt is too long」触发 Claude Code 自动压缩
    const msg =
      kind === 'context' && !/prompt is too long/i.test(message)
        ? `prompt is too long: ${message}`
        : message;
    return { status, body: { type: 'error', error: { type, message: msg } } };
  }
  if (ingress === 'gemini') {
    const s = {
      rate_limit: 'RESOURCE_EXHAUSTED',
      overloaded: 'UNAVAILABLE',
      auth: 'UNAUTHENTICATED',
      invalid: 'INVALID_ARGUMENT',
      not_found: 'NOT_FOUND',
      context: 'INVALID_ARGUMENT',
      upstream: 'INTERNAL',
    }[kind];
    return { status, body: { error: { code: status, message, status: s } } };
  }
  const code = {
    rate_limit: 'rate_limit_exceeded',
    overloaded: 'server_error',
    auth: 'invalid_api_key',
    invalid: 'invalid_request_error',
    not_found: 'model_not_found',
    context: 'context_length_exceeded',
    upstream: 'server_error',
  }[kind];
  const type =
    kind === 'invalid' || kind === 'context' || kind === 'not_found'
      ? 'invalid_request_error'
      : code;
  return { status, body: { error: { message, type, code } } };
}

/** 从上游错误体里取出可读的消息 */
export function upstreamMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof j.error === 'string') return j.error;
    if (j.error && typeof j.error.message === 'string') return j.error.message;
    if (typeof j.message === 'string') return j.message;
  } catch {
    /* 非 JSON */
  }
  return text.slice(0, 500) || 'upstream error';
}
