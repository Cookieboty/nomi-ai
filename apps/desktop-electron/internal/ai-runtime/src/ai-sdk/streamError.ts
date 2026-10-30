/**
 * 流式请求的错误 → 简短可读的一句话（#78）。
 *
 * 网关 / 中转站返回的 `response.failed`、`error` 帧经常不完全符合 OpenAI 的 schema（缺 sequence_number、
 * code 不是字符串……），AI SDK 校验失败后抛出 TypeValidationError，message 是「整段 JSON + 全部 zod 校验明细」，
 * 动辄几十行。这里从错误里取出上游真正的 code / message，输出 `[code] message`；
 * 渲染层（ai-chat）按 code 换成本地化的说明。拿不到结构化信息时退回原文（截断）。
 */

const MAX_LEN = 500;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;

/** 从上游的错误帧里取 { code, message } */
function upstreamError(value: unknown): { code?: string; message?: string } | null {
  if (!isObj(value)) return null;
  let err: unknown;
  if (value.type === 'response.failed' || value.type === 'response.incomplete') {
    const response = isObj(value.response) ? value.response : {};
    err = response.error;
    if (!isObj(err) && isObj(response.incomplete_details))
      err = {
        code: response.incomplete_details.reason,
        message: response.incomplete_details.reason,
      };
  } else if (value.type === 'error') {
    err = isObj(value.error) ? value.error : value;
  } else if (isObj(value.error)) {
    err = value.error;
  }
  if (!isObj(err)) return null;
  const code = str(err.code) ?? str(err.type);
  const message = str(err.message);
  return code || message ? { code, message } : null;
}

function clip(s: string): string {
  const one = s.trim();
  return one.length > MAX_LEN ? `${one.slice(0, MAX_LEN)}…` : one;
}

function httpStatus(e: unknown): number | undefined {
  if (!isObj(e)) return undefined;
  for (const k of ['statusCode', 'status', 'status_code'] as const) {
    const v = e[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v);
  }
  if ('cause' in e && e.cause !== undefined && e.cause !== e) return httpStatus(e.cause);
  if ('lastError' in e && e.lastError !== undefined && e.lastError !== e)
    return httpStatus(e.lastError);
  return undefined;
}

export function describeStreamError(e: unknown): string {
  const status = httpStatus(e);
  let body: string | undefined;
  if (isObj(e)) {
    // AI SDK 的 TypeValidationError：value 是未通过校验的原始帧
    const fromValue = 'value' in e ? upstreamError(e.value) : null;
    if (fromValue) body = format(fromValue);
    // APICallError：响应体里的 { error: { code, message } }
    else {
      const fromData = 'data' in e ? upstreamError(e.data) : null;
      if (fromData) body = format(fromData);
      // RetryError 等包着最后一个错误
      else if ('lastError' in e && e.lastError && e.lastError !== e) {
        const inner = describeStreamError(e.lastError);
        if (inner.startsWith('[') || /^HTTP\s+\d{3}/i.test(inner)) return inner;
      }
    }
  }
  if (!body) body = clip(e instanceof Error ? e.message : String(e));
  // 把 HTTP 状态带进文案，便于 ProviderRouter.isKeyError 在只有字符串时仍优先按状态码判断
  if (status !== undefined && !new RegExp(`\\b${status}\\b`).test(body))
    return clip(`HTTP ${status}: ${body}`);
  return body;
}

function format({ code, message }: { code?: string; message?: string }): string {
  if (!code) return clip(message ?? '');
  return clip(`[${code}] ${message && message !== code ? message : ''}`.trim());
}
