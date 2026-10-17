/**
 * 统一的服务生命周期：有后台定时器 / 子进程 / 监听端口 / worker 的服务注册进来，
 * 应用退出时按「后注册先停止」的顺序逐个 stop()，互不影响（一个抛错或卡住不拖垮其余）。
 */
export interface LifecycleService {
  readonly name: string;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface LifecycleLogger {
  warn(message: string, meta?: unknown): void;
}

export class LifecycleRegistry {
  private readonly items: LifecycleService[] = [];

  /** 同名服务只保留一份（重复 register 视为替换） */
  register<T extends LifecycleService>(svc: T): T {
    const i = this.items.findIndex((x) => x.name === svc.name);
    if (i >= 0) this.items.splice(i, 1);
    this.items.push(svc);
    return svc;
  }

  names(): string[] {
    return this.items.map((x) => x.name);
  }

  /**
   * 逆序停止全部已注册服务；每个服务各自有超时（默认 3s），超时 / 抛错只记日志。
   * 停止后注册表清空，因此幂等。
   */
  async stopAll(logger?: LifecycleLogger, perServiceTimeoutMs = 3000): Promise<void> {
    const list = this.items.splice(0).reverse();
    for (const svc of list) {
      if (!svc.stop) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve(svc.stop()),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              logger?.warn(`服务 ${svc.name} 停止超时，继续退出`, {
                timeoutMs: perServiceTimeoutMs,
              });
              resolve();
            }, perServiceTimeoutMs);
          }),
        ]);
      } catch (error) {
        logger?.warn(`服务 ${svc.name} 停止失败`, {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

export interface ShutdownOptions {
  /** 真正的清理工作（只会执行一次） */
  work: () => Promise<void>;
  /** 超过该时长不再等待 work，继续退出 */
  timeoutMs: number;
  /** 清理结束（成功 / 失败 / 超时）后调用，通常是 app.exit(0) */
  exit: () => void;
  onTimeout?: () => void;
}

/**
 * 退出协调：
 * - stop()：重入守卫，多次 / 并发调用共用同一次 work，带超时兜底（超时只放弃等待，不抛错）；
 * - requestQuit()：before-quit / 信号共用入口，只触发一次「stop → exit」。
 */
export function createShutdown(opts: ShutdownOptions): {
  stop(): Promise<void>;
  requestQuit(): void;
} {
  let stopPromise: Promise<void> | undefined;
  let quitRequested = false;

  const run = async (): Promise<void> => {
    const work = opts.work();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        opts.onTimeout?.();
        resolve();
      }, opts.timeoutMs);
    });
    // 超时后 work 若再失败，不应变成 unhandledRejection
    work.catch(() => undefined);
    try {
      await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const stop = (): Promise<void> => {
    stopPromise ??= run();
    return stopPromise;
  };

  const requestQuit = (): void => {
    if (quitRequested) return;
    quitRequested = true;
    stop()
      .catch(() => undefined)
      .finally(() => opts.exit());
  };

  return { stop, requestQuit };
}
