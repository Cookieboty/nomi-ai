/**
 * AI SDK 错误码 & 分类 —— 供 UI / IPC 统一识别。
 *
 * 对齐 P9 计划 §P9-4：
 * - 错误码扩展到覆盖用户可见的常见失败场景（配额、超时、密钥缺失等）；
 * - `AIClientError` 携带 `retryable`（能否让用户一键重试）与 `hint`（UI 提示 id，用于
 *   分发到 [errorHint](file:///../../ai-sdk-client/src/errorHint.ts) 的中文文案表）；
 * - IPC 透传（Electron 序列化 Error 时只保留 message）：使用 `[CODE|R|hint:XX] message`
 *   的紧凑前缀协议——`R` 为 `0`/`1`，`hint:` 可省略；老的 `[CODE] message` 形式仍然可解析。
 *
 * 命名规则：`{SUBSYS}_{REASON}`；所有 error 均带 `code` 常量属性，方便断言。
 */

export const ErrorCodes = {
  // 既有（P5 引入）
  SEAM_NOT_INJECTED: 'SEAM_NOT_INJECTED',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_CONFIRM_INVALID: 'TOOL_CONFIRM_INVALID',
  PROFILE_INVALID: 'PROFILE_INVALID',
  DISPOSED: 'AICLIENT_DISPOSED',
  // P9-4 新增：用户可见的常见失败
  E_NO_KEY: 'E_NO_KEY',
  E_QUOTA: 'E_QUOTA',
  E_TIMEOUT: 'E_TIMEOUT',
  E_TOOL_DENIED: 'E_TOOL_DENIED',
  E_PROFILE_MISS: 'E_PROFILE_MISS',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * 默认 retryable 分类。未列出的 code 默认视为**不可重试**（安全侧偏保守）。
 */
const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCodes.E_TIMEOUT,
  ErrorCodes.E_QUOTA,
]);

/**
 * 默认 UI hint 映射（可被实例级 hint 覆盖）。hint 是 UI 层展示的 CTA 标识：
 * - `open-settings`：跳转到设置页；
 * - `switch-provider`：建议切换 provider；
 * - `retry`：显示重试按钮；
 * - `dismiss`：仅普通提示，无 CTA；
 * - `check-profile`：提示重装或换 profile。
 */
const DEFAULT_HINT: Partial<Record<ErrorCode, string>> = {
  [ErrorCodes.E_NO_KEY]: 'open-settings',
  [ErrorCodes.E_QUOTA]: 'switch-provider',
  [ErrorCodes.E_TIMEOUT]: 'retry',
  [ErrorCodes.E_TOOL_DENIED]: 'dismiss',
  [ErrorCodes.E_PROFILE_MISS]: 'check-profile',
};

export function isRetryable(code: ErrorCode): boolean {
  return DEFAULT_RETRYABLE.has(code);
}

export function getDefaultHint(code: ErrorCode): string | undefined {
  return DEFAULT_HINT[code];
}

export interface AIClientErrorOptions {
  /** 覆盖默认 retryable */
  retryable?: boolean;
  /** 覆盖默认 hint（UI CTA 标识） */
  hint?: string;
  /** 原始 cause，仅本地保留（不参与 IPC 序列化） */
  cause?: unknown;
}

export class AIClientError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, opts: AIClientErrorOptions = {}) {
    const retryable = opts.retryable ?? isRetryable(code);
    const hint = opts.hint ?? getDefaultHint(code);
    super(formatIpcMessage({ code, message, retryable, hint }));
    this.name = 'AIClientError';
    this.code = code;
    this.retryable = retryable;
    this.hint = hint;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * IPC 透传契约 —— 把 (code, retryable, hint, message) 序列化为 `Error.message`。
 *
 * 契约（向后兼容）：
 * - 基础：`[CODE] message`（不传 retryable 时用旧格式）；
 * - 带 retryable：`[CODE|1] message` / `[CODE|0] message`；
 * - 带 hint：`[CODE|1|hint:HINT_ID] message`。
 *
 * 反序列化见 [parseIpcMessage](file:///./errors.ts#parseIpcMessage) 与
 * [ai-sdk-client SDKError.fromIpc](file:///../../ai-sdk-client/src/errors.ts)。
 */
export function formatIpcMessage(input: {
  code: string;
  message: string;
  retryable?: boolean;
  hint?: string;
}): string {
  const parts: string[] = [input.code];
  if (typeof input.retryable === 'boolean') parts.push(input.retryable ? '1' : '0');
  if (input.hint) {
    if (parts.length === 1) parts.push('0');
    parts.push(`hint:${input.hint}`);
  }
  return `[${parts.join('|')}] ${input.message}`;
}

/**
 * 反解析 IPC 序列化后的 `Error.message`：
 * - 命中 `[CODE] rest` → `{ code, message: rest }`
 * - 命中 `[CODE|R] rest` → 追加 `retryable`
 * - 命中 `[CODE|R|hint:XX] rest` → 追加 `hint`
 *
 * 若无法匹配前缀，返回 `undefined`，调用方按 `IPC_ERROR` 兜底。
 */
const IPC_PREFIX_RE = /^\[([A-Z_][A-Z0-9_]*)(\|[^\]]*)?\]\s?(.*)$/s;

export function parseIpcMessage(raw: string):
  | {
      code: string;
      message: string;
      retryable?: boolean;
      hint?: string;
    }
  | undefined {
  const m = IPC_PREFIX_RE.exec(raw);
  if (!m) return undefined;
  const code = m[1]!;
  const flagStr = (m[2] ?? '').replace(/^\|/, '');
  const message = m[3] ?? '';
  if (!flagStr) return { code, message };
  const flags = flagStr.split('|').filter(Boolean);
  let retryable: boolean | undefined;
  let hint: string | undefined;
  for (const f of flags) {
    if (f === '0') retryable = false;
    else if (f === '1') retryable = true;
    else if (f.startsWith('hint:')) hint = f.slice('hint:'.length) || undefined;
  }
  return {
    code,
    message,
    ...(retryable !== undefined ? { retryable } : {}),
    ...(hint ? { hint } : {}),
  };
}
