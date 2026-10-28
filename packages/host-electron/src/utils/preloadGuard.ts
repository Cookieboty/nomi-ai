/**
 * Preload 守护：检测「页面已加载但 preload 未执行」的空白窗口并自愈。
 *
 * 背景：sandbox 渲染进程里 preload 由 Electron 的 sandbox bundle 在创建脚本上下文时
 * 通过同步内部 IPC 从主进程取回脚本再执行。若此时有调试器以
 * `waitForDebuggerOnStart` 自动附加（Playwright `_electron.launch` 的 CDP 连接、
 * 远程调试等），该阶段会与调试器恢复执行发生竞态：index.html 照常加载完毕，
 * 但 Electron 的渲染侧初始化（含 preload、内部 IPC 处理）从未运行：无
 * `window.nomiTransport` / `window.nomiHost`，主进程发起的 `executeJavaScript` 也永远得不到
 * 回应（它依赖同一套渲染侧内部 IPC）。表现即「首启空白窗口」。
 *
 * 处理：每次主框架 `did-finish-load` 后在主世界探测 preload 暴露的全局；超时或缺失时
 * 记录日志并恢复——先 `reloadIgnoringCache()`（重新跑渲染侧初始化）；
 * 第二次仍失败则强制重建渲染进程后再加载。恢复次数有上限，避免无限重载。
 */
export interface PreloadGuardLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** BrowserWindow.webContents 的最小子集（便于单测）。 */
export interface GuardedWebContents {
  on(event: 'did-finish-load', listener: () => void): unknown;
  executeJavaScript(code: string): Promise<unknown>;
  reloadIgnoringCache(): void;
  forcefullyCrashRenderer(): void;
  isDestroyed(): boolean;
  getURL(): string;
}

export interface PreloadGuardOptions {
  /** 日志标签（窗口类型）。 */
  label: string;
  /** preload 必须暴露到主世界的全局名。 */
  globals: string[];
  logger: PreloadGuardLogger;
  /** 探测超时（ms）；卡住的渲染进程不会回应 executeJavaScript。 */
  probeTimeoutMs?: number;
  /** 最多恢复次数。 */
  maxRecoveries?: number;
}

export type ProbeResult = 'ok' | 'missing' | 'timeout' | 'error';

export function buildProbeScript(globals: string[]): string {
  const checks = globals.map((g) => `typeof window[${JSON.stringify(g)}] !== 'undefined'`);
  return `(${checks.join(' && ') || 'true'})`;
}

export async function probePreload(
  wc: GuardedWebContents,
  globals: string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    handle = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const probe = wc
    .executeJavaScript(buildProbeScript(globals))
    .then((v): ProbeResult => (v === true ? 'ok' : 'missing'))
    .catch((): ProbeResult => 'error');
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

export interface PreloadGuardHandle {
  recoveries(): number;
  check(): Promise<ProbeResult>;
}

export function installPreloadGuard(
  wc: GuardedWebContents,
  opts: PreloadGuardOptions,
): PreloadGuardHandle {
  const timeoutMs = opts.probeTimeoutMs ?? 4000;
  const max = opts.maxRecoveries ?? 2;
  let recoveries = 0;
  let checking = false;

  const check = async (): Promise<ProbeResult> => {
    if (checking || wc.isDestroyed()) return 'ok';
    checking = true;
    try {
      const result = await probePreload(wc, opts.globals, timeoutMs);
      if (result === 'ok') {
        if (recoveries > 0) {
          opts.logger.info(`[${opts.label}] preload 已在第 ${recoveries} 次恢复后生效`);
        }
        return result;
      }
      // 'error'：页面正在导航/销毁（executeJavaScript 被打断），交给下一次 did-finish-load
      if (result === 'error' || wc.isDestroyed()) return result;
      if (recoveries >= max) {
        opts.logger.error(`[${opts.label}] preload 仍未生效，放弃自动恢复`, {
          result,
          url: wc.getURL(),
          recoveries,
        });
        return result;
      }
      recoveries += 1;
      const hard = recoveries > 1;
      opts.logger.warn(`[${opts.label}] 页面已加载但 preload 未生效，自动恢复`, {
        result,
        url: wc.getURL(),
        attempt: recoveries,
        strategy: hard ? 'recreate-renderer' : 'reload',
      });
      // 首次软重载即可（Electron 渲染侧初始化重新执行）；仍失败再强制重建渲染进程
      if (hard) wc.forcefullyCrashRenderer();
      wc.reloadIgnoringCache();
      return result;
    } finally {
      checking = false;
    }
  };

  wc.on('did-finish-load', () => {
    void check();
  });
  return { recoveries: () => recoveries, check };
}
