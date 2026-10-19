/**
 * 「启动 Nomi 后默认显示」（`startup.defaultView`）与主进程的通信（`ai:startup:*`，主进程 startup/StartupService）。
 * 没有 IPC（浏览器预览 / 测试）时 `available()` 为 false，界面不显示该设置。
 */
export type StartupView = 'mascot' | 'main';
export const DEFAULT_STARTUP_VIEW: StartupView = 'mascot';

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
}
const bridge = (): Bridge | undefined => (window as unknown as { aiIPC?: Bridge }).aiIPC;

const pick = (r: unknown): StartupView | null => {
  const v = (r as { defaultView?: unknown } | null)?.defaultView;
  return v === 'main' || v === 'mascot' ? v : null;
};

export const startupClient = {
  available: () => Boolean(bridge()),
  /** 读取失败 / 值异常时回落到默认（看板娘） */
  async get(): Promise<StartupView> {
    const r = await bridge()
      ?.invoke('ai:startup:get')
      .catch(() => null);
    return pick(r) ?? DEFAULT_STARTUP_VIEW;
  },
  /** 返回主进程确认后的值；失败时返回 null（调用方回滚界面） */
  async set(defaultView: StartupView): Promise<StartupView | null> {
    const r = await bridge()
      ?.invoke('ai:startup:set', { defaultView })
      .catch(() => null);
    return pick(r);
  },
};
