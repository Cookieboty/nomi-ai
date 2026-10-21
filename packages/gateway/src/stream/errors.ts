/** 错误类型在各协议之间的对应（完整映射见 docs/design/unified-gateway.md §9.6） */

/** 中间事件里的错误类型 → Gemini 的 status 与 HTTP 码 */
export function geminiErrorStatus(errorType?: string): { code: number; status: string } {
  switch (errorType) {
    case 'rate_limit_error':
    case 'rate_limit_exceeded':
      return { code: 429, status: 'RESOURCE_EXHAUSTED' };
    case 'overloaded_error':
      return { code: 503, status: 'UNAVAILABLE' };
    case 'authentication_error':
      return { code: 401, status: 'UNAUTHENTICATED' };
    case 'permission_error':
      return { code: 403, status: 'PERMISSION_DENIED' };
    case 'invalid_request_error':
      return { code: 400, status: 'INVALID_ARGUMENT' };
    default:
      return { code: 500, status: 'INTERNAL' };
  }
}
