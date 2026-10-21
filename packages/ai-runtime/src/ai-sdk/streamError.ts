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

export function describeStreamError(e: unknown): string {
  if (isObj(e)) {
    // AI SDK 的 TypeValidationError：value 是未通过校验的原始帧
    const fromValue = 'value' in e ? upstreamError(e.value) : null;
    if (fromValue) return format(fromValue);
    // APICallError：响应体里的 { error: { code, message } }
    const fromData = 'data' in e ? upstreamError(e.data) : null;
    if (fromData) return format(fromData);
    // RetryError 等包着最后一个错误
    if ('lastError' in e && e.lastError && e.lastError !== e) {
      const inner = describeStreamError(e.lastError);
      if (inner.startsWith('[')) return inner;
    }
  }
  return clip(e instanceof Error ? e.message : String(e));
}

function format({ code, message }: { code?: string; message?: string }): string {
  if (!code) return clip(message ?? '');
  return clip(`[${code}] ${message && message !== code ? message : ''}`.trim());
}
