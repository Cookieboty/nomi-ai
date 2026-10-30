/* eslint-disable no-console -- 库的默认 console sink；宿主可注入自己的 logger */
/**
 * 结构化 Logger
 *
 * 对齐 P9 计划 §P9-1：把 [RuntimeLogger](file:///../logger.ts) 升级为**结构化日志器**：
 * - 每条日志都是 `{ ts, level, msg, ...bindings, ...meta }` 的 JSON 对象；
 * - 支持 `child(bindings)` 派生子 logger，`sessionId / turnId / stepId / traceId`
 *   等字段沿链传递，无需每次手写；
 * - 输出端默认为 `console.<level>`，可通过 `sink` 注入 pino/pretty/文件 等实现；
 * - 走 [createRedactor](file:///./redaction.ts) 过 meta，密钥/token/邮箱不落盘；
 * - `level` 支持 `fatal / error / warn / info / debug / trace`；未开启的级别短路，
 *   避免热路径序列化开销。
 *
 * 与 pino 的关系：本模块**语义**上就是 pino 的最小子集（bindings + child + level），
 * 但不引入 pino 硬依赖——业务方若要 pino / winston，实现 `LogSink` 注入即可。
 */

import { createRedactor, type RedactOptions } from './redaction';

/** 日志级别，按严重程度升序排列。 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * 结构化日志记录，`sink` 收到的原始载荷。
 */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  /** 通过 child(bindings) 沿链传递的静态字段（sessionId 等）。 */
  bindings: Readonly<Record<string, unknown>>;
  /** 每条日志的动态 meta，已经过 redaction。 */
  meta?: Record<string, unknown>;
  /** 若最后一个参数是 Error，会拆出来放这里（保留 name/message/stack/code）。 */
  err?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

/** 输出端。生产可注入 pino / winston / 文件流；测试用 collector。 */
export type LogSink = (record: LogRecord) => void;

export interface StructuredLoggerOptions {
  /** 日志级别，默认 `info` */
  level?: LogLevel;
  /** 全局 bindings（sessionId 等），child 会 shallow-merge 覆盖 */
  bindings?: Readonly<Record<string, unknown>>;
  /** 输出端；未传使用 console(level) */
  sink?: LogSink;
  /** redaction 配置；未传使用默认敏感字段列表 */
  redact?: RedactOptions;
  /**
   * 提供当前时间戳（毫秒 epoch 或 ISO）；未传使用 `new Date().toISOString()`。
   * 便于单测替换。
   */
  now?: () => string;
}

/**
 * 结构化 logger 接口。与 pino 的最小契约对齐。
 */
export interface StructuredLogger {
  readonly level: LogLevel;
  isLevelEnabled(level: LogLevel): boolean;

  trace(msg: string, meta?: Record<string, unknown> | Error): void;
  debug(msg: string, meta?: Record<string, unknown> | Error): void;
  info(msg: string, meta?: Record<string, unknown> | Error): void;
  warn(msg: string, meta?: Record<string, unknown> | Error): void;
  error(msg: string, meta?: Record<string, unknown> | Error): void;
  fatal(msg: string, meta?: Record<string, unknown> | Error): void;

  /**
   * 派生子 logger，`bindings` 会与父层合并；后写覆盖先写。
   * `child({ sessionId, turnId })` 场景专用。
   */
  child(bindings: Readonly<Record<string, unknown>>): StructuredLogger;
}

const DEFAULT_LEVEL: LogLevel = 'info';

function defaultSink(record: LogRecord): void {
  const target =
    record.level === 'error' || record.level === 'fatal'
      ? console.error
      : record.level === 'warn'
        ? console.warn
        : record.level === 'debug' || record.level === 'trace'
          ? (console.debug ?? console.log)
          : console.info;
  try {
    target(JSON.stringify(record));
  } catch {
    // fallback: 结构化序列化失败（比如 BigInt）时打印 shallow toString
    target(`[ai-runtime] ${record.msg}`, record.meta);
  }
}

/**
 * 判断 meta 是否是 Error 或类 Error（有 message + stack）。
 */
function isErrorLike(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof value === 'object' &&
      value !== null &&
      typeof (value as { message?: unknown }).message === 'string' &&
      typeof (value as { stack?: unknown }).stack === 'string')
  );
}

function serializeError(err: Error): NonNullable<LogRecord['err']> {
  const withCode = err as Error & { code?: unknown };
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    code: typeof withCode.code === 'string' ? withCode.code : undefined,
  };
}

/**
 * 创建结构化 logger。业务方一般在 `runtime.configure({ logger })` 时传入一次。
 */
export function createStructuredLogger(opts: StructuredLoggerOptions = {}): StructuredLogger {
  const level: LogLevel = opts.level ?? DEFAULT_LEVEL;
  const sink: LogSink = opts.sink ?? defaultSink;
  const redactor = createRedactor(opts.redact);
  const now: () => string = opts.now ?? (() => new Date().toISOString());

  return buildLogger({
    level,
    sink,
    redactor,
    now,
    bindings: opts.bindings ?? {},
  });
}

interface InternalOptions {
  level: LogLevel;
  sink: LogSink;
  redactor: (input: unknown) => unknown;
  now: () => string;
  bindings: Readonly<Record<string, unknown>>;
}

function buildLogger(internal: InternalOptions): StructuredLogger {
  const minOrder = LEVEL_ORDER[internal.level];

  const emit = (
    level: LogLevel,
    msg: string,
    meta: Record<string, unknown> | Error | undefined,
  ): void => {
    if (LEVEL_ORDER[level] < minOrder) return;
    let err: LogRecord['err'];
    let metaOut: Record<string, unknown> | undefined;
    if (meta instanceof Error) {
      err = serializeError(meta);
    } else if (isErrorLike(meta)) {
      err = serializeError(meta as Error);
    } else if (meta && typeof meta === 'object') {
      const { err: rawErr, ...rest } = meta as { err?: unknown } & Record<string, unknown>;
      if (rawErr && isErrorLike(rawErr)) {
        err = serializeError(rawErr as Error);
      }
      if (Object.keys(rest).length > 0) {
        metaOut = internal.redactor(rest) as Record<string, unknown>;
      }
    }
    const record: LogRecord = {
      ts: internal.now(),
      level,
      msg,
      bindings: internal.bindings,
      ...(metaOut ? { meta: metaOut } : {}),
      ...(err ? { err } : {}),
    };
    try {
      internal.sink(record);
    } catch (sinkErr) {
      // sink 抛错不能阻塞主流程；退回 console.error 兜底
      console.error('[ai-runtime] log sink threw', sinkErr);
    }
  };

  const api: StructuredLogger = {
    level: internal.level,
    isLevelEnabled: (l: LogLevel) => LEVEL_ORDER[l] >= minOrder,
    trace: (msg, meta) => emit('trace', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    fatal: (msg, meta) => emit('fatal', msg, meta),
    child: (bindings) =>
      buildLogger({
        ...internal,
        bindings: { ...internal.bindings, ...bindings },
      }),
  };
  return api;
}

/**
 * 把 [StructuredLogger](file:///./logger.ts) 适配成 [RuntimeLogger](file:///../logger.ts) 接口，
 * 保持向后兼容——业务方现有的 `runtime.configure({ logger })` 无需改动。
 *
 * 语义差异：结构化 logger 只接受一个 meta 对象；老接口接受 `...args: unknown[]`。
 * 适配时把 rest 参数塞到 `meta.args` 里，避免信息丢失。
 */
export function toRuntimeLoggerAdapter(logger: StructuredLogger): {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
} {
  const wrap =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (msg: string, ...args: unknown[]) => {
      if (args.length === 0) {
        logger[level](msg);
        return;
      }
      if (args.length === 1 && (args[0] instanceof Error || isErrorLike(args[0]))) {
        logger[level](msg, args[0] as Error);
        return;
      }
      if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        logger[level](msg, args[0] as Record<string, unknown>);
        return;
      }
      logger[level](msg, { args });
    };
  return {
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    debug: wrap('debug'),
  };
}
