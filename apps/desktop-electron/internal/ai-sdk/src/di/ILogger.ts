/**
 * ILogger —— AIClient 的极简日志契约。
 *
 * 默认由 `AIClient` 提供 no-op 实现，宿主（renderer/main/CLI）可注入
 * 更强的实现（console / pino / 宿主 logger 等）。
 */

export interface ILogger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const NoopLogger: ILogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
