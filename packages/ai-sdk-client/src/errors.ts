/**
 * 渲染进程侧错误恢复 —— IPC 抛出的错误在 Electron 序列化后会**丢失原型**，
 * 只保留 `message` 字段。本模块负责把这类"贫瘠错误"还原为带 `code / retryable / hint`
 * 的 `SDKError`，与主进程 [`AIClientError`](file:///../../ai-sdk/src/errors.ts) 语义对齐。
 *
 * 与 ai-sdk 侧的 IPC 契约保持一致（P9-4）：
 *   `[CODE] message`              → 兼容旧版本
 *   `[CODE|1] message`            → retryable=true
 *   `[CODE|1|hint:HINT] message`  → 带 UI CTA 提示
 *
 * ai-sdk-client 不 import ai-sdk 的运行时代码（保持渲染进程 bundle 干净），
 * 与主端的一致性由 [tests/contracts/errors.test.ts](file:///../tests/contracts/errors.test.ts) 契约测试保证。
 */

/** IPC 前缀正则；与 [ai-sdk errors.ts](file:///../../ai-sdk/src/errors.ts) 保持同步。 */
const IPC_PREFIX_RE = /^\[([A-Z_][A-Z0-9_]*)(\|[^\]]*)?\]\s?(.*)$/s;

/**
 * 与 [`ErrorCodes`](file:///../../ai-sdk/src/errors.ts) 保持同名的常量表；
 * 客户端侧独立维护以避免拉入 插件宿主 / peer 依赖。
 */
export const SDKErrorCodes = {
  // 既有（P5 引入）
  SEAM_NOT_INJECTED: 'SEAM_NOT_INJECTED',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_CONFIRM_INVALID: 'TOOL_CONFIRM_INVALID',
  PROFILE_INVALID: 'PROFILE_INVALID',
  DISPOSED: 'AICLIENT_DISPOSED',
  IPC_ERROR: 'IPC_ERROR',
  IPC_STREAM_ABORTED: 'IPC_STREAM_ABORTED',
  BRIDGE_MISSING: 'BRIDGE_MISSING',
  // P9-4 新增
  E_NO_KEY: 'E_NO_KEY',
  E_QUOTA: 'E_QUOTA',
  E_TIMEOUT: 'E_TIMEOUT',
  E_TOOL_DENIED: 'E_TOOL_DENIED',
  E_PROFILE_MISS: 'E_PROFILE_MISS',
} as const;

export type SDKErrorCode = (typeof SDKErrorCodes)[keyof typeof SDKErrorCodes];

export interface SDKErrorOptions {
  retryable?: boolean;
  hint?: string;
  cause?: unknown;
}

export class SDKError extends Error {
  readonly code: SDKErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  override readonly cause?: unknown;

  constructor(code: SDKErrorCode, message: string, opts?: SDKErrorOptions | unknown) {
    super(`[${code}] ${message}`);
    this.name = 'SDKError';
    this.code = code;
    // 兼容旧签名：第 3 参可能直接是 cause（例如 `new SDKError(code, msg, err)`）。
    // 只有当 opts 是 **纯 options 对象**（含 retryable/hint/cause 之一）时才按新签名解读；
    // 其余非空值（包括 Error / 字符串 / 数字）视作 cause。
    if (opts === undefined) {
      this.retryable = false;
      this.hint = undefined;
      return;
    }
    if (
      opts !== null &&
      typeof opts === 'object' &&
      !(opts instanceof Error) &&
      ('retryable' in opts || 'hint' in opts || 'cause' in opts)
    ) {
      const o = opts as SDKErrorOptions;
      this.retryable = o.retryable ?? false;
      this.hint = o.hint;
      if (o.cause !== undefined) this.cause = o.cause;
      return;
    }
    this.retryable = false;
    this.hint = undefined;
    this.cause = opts;
  }

  /**
   * 从 IPC 反序列化后的 Error（原型丢失）还原：
   * - 解析 `[CODE(|R)?(|hint:XX)?] xxx` 前缀；
   * - 未知 code 或无前缀时回落 `IPC_ERROR`。
   */
  static fromIpc(err: unknown): SDKError {
    if (err instanceof SDKError) return err;
    const raw = err instanceof Error ? err.message : String(err);
    const parsed = parseIpcMessage(raw);
    if (!parsed) return new SDKError(SDKErrorCodes.IPC_ERROR, raw, { cause: err });
    const known = (SDKErrorCodes as Record<string, SDKErrorCode>)[parsed.code];
    if (!known) return new SDKError(SDKErrorCodes.IPC_ERROR, raw, { cause: err });
    return new SDKError(known, parsed.message, {
      retryable: parsed.retryable ?? false,
      hint: parsed.hint,
      cause: err,
    });
  }
}

/**
 * 内部使用；与 ai-sdk `parseIpcMessage` 语义等价。
 * 单独实现是为了不引入 ai-sdk 的运行时依赖（渲染进程包大小敏感）。
 */
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
