/* eslint-disable no-console -- 集中日志：主进程里唯一允许直接调用 console 的地方之一（另见 LoggerService） */
/**
 * 主进程轻量日志（给没有注入 LoggerService 的模块用）。
 *
 * - debug / info：开发环境（未打包）输出；打包后静默，设置环境变量 NOMI_DEBUG=1 可打开。
 * - warn / error：始终输出。
 *
 * 「是否正式打包」由宿主在启动时告诉这里（Electron：host/processDefaults.ts 接 `app.isPackaged`）；
 * 没设置的进程（工具子进程、单测）按开发态处理。
 */

export interface MainLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

let isPackaged: (() => boolean) | null = null;

/** 宿主设置「是否正式打包」的取值函数；传 null 恢复默认（按开发态处理） */
export function setMainLogPackaged(fn: (() => boolean) | null): void {
  isPackaged = fn;
}

export function isVerboseMainLogging(): boolean {
  if (process.env.NOMI_DEBUG === '1') return true;
  try {
    return !isPackaged?.();
  } catch {
    return true;
  }
}

export function createMainLogger(scope: string): MainLogger {
  const p = `[${scope}]`;
  return {
    debug: (...a) => {
      if (isVerboseMainLogging()) console.debug(p, ...a);
    },
    info: (...a) => {
      if (isVerboseMainLogging()) console.info(p, ...a);
    },
    warn: (...a) => console.warn(p, ...a),
    error: (...a) => console.error(p, ...a),
  };
}
