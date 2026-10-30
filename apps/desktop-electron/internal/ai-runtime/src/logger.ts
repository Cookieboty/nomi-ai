/* eslint-disable no-console -- 库的默认 console sink；宿主可注入自己的 logger */
/**
 * 运行时日志抽象。生产环境默认走 `console`，可通过 AIRuntimeServiceOptions.logger 覆盖
 * 成 ai-sdk 的 ILogger 或者业务方的 LoggerService。
 */
export interface RuntimeLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug?(msg: string, ...args: unknown[]): void;
}

export const ConsoleRuntimeLogger: RuntimeLogger = {
  info: (msg, ...args) => console.info(`[ai-runtime] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[ai-runtime] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[ai-runtime] ${msg}`, ...args),
};

export const NoopRuntimeLogger: RuntimeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
