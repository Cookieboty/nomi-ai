/**
 * 错误模型（docs/design/core-host-decoupling.md §4.2）：
 * 线上只传 `{ code, message, data? }`，不透传 Error 对象。
 * 内置错误码由本包定义；业务错误码在 `defineContract({ errors })` 里枚举。
 */

export const BUILTIN_ERROR_CODES = [
  /** 帧格式不对、对流式过程用了 call 等调用方错误 */
  'BAD_REQUEST',
  /** 入参未通过契约 schema */
  'BAD_INPUT',
  /** 返回值 / chunk / 事件未通过契约 schema，或不可序列化 */
  'BAD_OUTPUT',
  /** 过程不存在（例如新视图调用旧内核没有的过程） */
  'NOT_FOUND',
  /** 调用者不在过程的 surfaces 里，或不可信的调用者调用 dangerous 过程 */
  'FORBIDDEN',
  /** 调用被取消 */
  'ABORTED',
  /** 契约 major 版本不一致 */
  'VERSION_MISMATCH',
  /** 传输层故障：连接关闭、发送失败 */
  'TRANSPORT',
  /** 处理函数抛出了非 ContractError 的异常 */
  'INTERNAL',
] as const;

export type BuiltinErrorCode = (typeof BUILTIN_ERROR_CODES)[number];

/** 线上的错误形态 */
export interface ErrorPayload {
  code: string;
  message: string;
  data?: unknown;
}

/**
 * `ContractError` 按名称 + 错误码识别，不用 `instanceof`：本包同时发 ESM 与 CommonJS，一个进程里可能加载
 * 两份（CommonJS 的内核 + ESM 的测试 / 无界面宿主），跨副本、跨 realm（worker、vm、iframe）时 `instanceof`
 * 都不成立。判断只看结构：`name === 'ContractError'`，`code` / `message` 是字符串。
 */
export const CONTRACT_ERROR_NAME = 'ContractError';

export class ContractError<Code extends string = string> extends Error {
  override readonly name = CONTRACT_ERROR_NAME;
  readonly code: Code;
  readonly data?: unknown;

  constructor(code: Code, message: string, data?: unknown) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  toJSON(): ErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

/** 是不是契约错误（按名称与错误码判断，跨副本 / 跨 realm 都认得）；传 `code` 时还要求错误码一致 */
export function isContractError<Code extends string = string>(
  value: unknown,
  code?: Code,
): value is ContractError<Code> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { name?: unknown; code?: unknown; message?: unknown };
  if (v.name !== CONTRACT_ERROR_NAME) return false;
  if (typeof v.code !== 'string' || typeof v.message !== 'string') return false;
  return code === undefined || v.code === code;
}

/** 把任意异常转成线上错误形态；非 ContractError 一律记为 INTERNAL */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (isContractError(err)) {
    return err.data === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, data: err.data };
  }
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
  return { code: 'INTERNAL', message };
}

export function fromErrorPayload(payload: ErrorPayload): ContractError {
  return new ContractError(payload.code, payload.message, payload.data);
}

export function abortedError(message = 'Call aborted'): ContractError<'ABORTED'> {
  return new ContractError('ABORTED', message);
}
