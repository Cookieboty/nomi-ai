/**
 * 内核实例作用域：每个 createCore() 实例自己持有界面语言、日志开关、诊断记录与私有文件根目录，
 * 同一进程里的多个内核互不影响。
 *
 * 内核里的模块（契约处理函数、服务、提醒、CLI 编排…）在调用时经 AsyncLocalStorage 找到「当前内核」，
 * 不再读模块级的全局状态。createCore 在建服务、start / stop / startReminders 与每次契约调用时进入
 * 自己的作用域，异步回调（定时器、Promise、子进程事件）沿用进入时的作用域。
 * 不在任何内核作用域里的代码（宿主进程自身、工具子进程、单测）落到不可变的进程默认值。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** 内核实例的界面语言（由 LocaleService 实现） */
export interface ScopedI18n {
  t(key: unknown, ...args: unknown[]): unknown;
  locale(): 'zh-CN' | 'en';
}

/** 内核实例的编程助手收发记录（由 CliTrace 实现） */
export interface ScopedCliTrace {
  tap(child: unknown, command: string, args: readonly string[], meta?: { tabId?: string }): void;
}

export interface CoreScope {
  i18n?: ScopedI18n;
  cliTrace?: ScopedCliTrace;
  /** debug / info 日志是否输出（未打包或 NOMI_DEBUG=1） */
  verboseLogging?: () => boolean;
  /** 允许自动收紧权限的私有文件根目录（userData） */
  privateRoot?: () => string | null;
}

const storage = new AsyncLocalStorage<CoreScope>();

export function createCoreScope(init: CoreScope = {}): CoreScope {
  return { ...init };
}

/** 在内核作用域里执行（同步返回值原样返回；异步延续沿用该作用域） */
export function runInCoreScope<T>(scope: CoreScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** 当前内核作用域；不在任何内核里时为 undefined */
export function currentCoreScope(): CoreScope | undefined {
  return storage.getStore();
}

/** 把异步迭代器的每一步都放进作用域里执行（流式契约处理函数） */
export function scopeIterable<T, R>(
  scope: CoreScope,
  make: () => AsyncIterable<T> | AsyncIterator<T, R>,
): AsyncGenerator<T, R, unknown> {
  let it: AsyncIterator<T, R> | undefined;
  const get = (): AsyncIterator<T, R> => {
    if (!it) {
      const src = runInCoreScope(scope, make);
      it =
        Symbol.asyncIterator in (src as object)
          ? ((src as AsyncIterable<T>)[Symbol.asyncIterator]() as AsyncIterator<T, R>)
          : (src as AsyncIterator<T, R>);
    }
    return it;
  };
  const gen: AsyncGenerator<T, R, unknown> = {
    next: (...a: [] | [unknown]) => runInCoreScope(scope, () => get().next(...(a as []))),
    return: (v?: R | PromiseLike<R>) =>
      runInCoreScope(scope, async () => {
        const i = get();
        return i.return ? i.return(await v) : ({ done: true, value: (await v) as R } as const);
      }),
    throw: (e?: unknown) =>
      runInCoreScope(scope, () => {
        const i = get();
        if (i.throw) return i.throw(e);
        return Promise.reject(e);
      }),
    [Symbol.asyncIterator]() {
      return gen;
    },
  } as AsyncGenerator<T, R, unknown>;
  return gen;
}
