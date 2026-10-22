/**
 * 「启动 Nomi 后默认显示」（`startup.defaultView`）与主进程的通信（`ai:startup:*`，主进程 startup/StartupService）。
 * 没有 IPC（浏览器预览 / 测试）时 `available()` 为 false，界面不显示该设置。
 */
export type StartupView = 'mascot' | 'main';
export const DEFAULT_STARTUP_VIEW: StartupView = 'mascot';
/** 关闭主界面时：hide（默认，看板娘与托盘继续运行）/ quit（完全退出 Nomi） */
export type CloseMainAction = 'hide' | 'quit';
export const DEFAULT_CLOSE_MAIN: CloseMainAction = 'hide';

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
  on?(ch: string, fn: (payload: unknown) => void): () => void;
}
const bridge = (): Bridge | undefined => (window as unknown as { aiIPC?: Bridge }).aiIPC;

const pick = (r: unknown): StartupView | null => {
  const v = (r as { defaultView?: unknown } | null)?.defaultView;
  return v === 'main' || v === 'mascot' ? v : null;
};

const pickShowMascot = (r: unknown): boolean | null => {
  const v = (r as { showMascot?: unknown } | null)?.showMascot;
  return typeof v === 'boolean' ? v : null;
};

const pickClose = (r: unknown): CloseMainAction | null => {
  const v = (r as { closeMain?: unknown } | null)?.closeMain;
  return v === 'hide' || v === 'quit' ? v : null;
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
  /** 关闭主界面时的动作；读取失败回落到默认（隐藏到托盘） */
  async getCloseMain(): Promise<CloseMainAction> {
    const r = await bridge()
      ?.invoke('ai:startup:get')
      .catch(() => null);
    return pickClose(r) ?? DEFAULT_CLOSE_MAIN;
  },
  /** 返回主进程确认后的值；失败时返回 null（调用方回滚界面） */
  async setCloseMain(closeMain: CloseMainAction): Promise<CloseMainAction | null> {
    const r = await bridge()
      ?.invoke('ai:startup:set', { closeMain })
      .catch(() => null);
    return pickClose(r);
  },
  /** 是否显示桌面 Nomi；读取失败 / 老配置回落到显示 */
  async getShowMascot(): Promise<boolean> {
    const r = await bridge()
      ?.invoke('ai:startup:get')
      .catch(() => null);
    return pickShowMascot(r) ?? true;
  },
  /**
   * 立即显示 / 关闭看板娘；返回主进程确认后的 { showMascot, defaultView }，失败时返回 null。
   * 默认界面为看板娘时关闭她，主进程会把默认界面改为「软件主界面」（#55），defaultView 随之变化。
   */
  async setShowMascot(
    showMascot: boolean,
  ): Promise<{ showMascot: boolean; defaultView: StartupView } | null> {
    const r = await bridge()
      ?.invoke('ai:startup:set', { showMascot })
      .catch(() => null);
    const s = pickShowMascot(r);
    const v = pick(r);
    return s === null || v === null ? null : { showMascot: s, defaultView: v };
  },
  /** 看板娘工具栏「关闭看板娘」等外部改动；返回取消订阅 */
  onShowMascotChange(
    fn: (showMascot: boolean, defaultView: StartupView | null) => void,
  ): () => void {
    const b = bridge();
    if (!b?.on) return () => undefined;
    return b.on('ai:startup:changed', (r) => {
      const v = pickShowMascot(r);
      if (v !== null) fn(v, pick(r));
    });
  },
  /** 返回主进程确认后的值；失败时返回 null（调用方回滚界面） */
  async set(defaultView: StartupView): Promise<StartupView | null> {
    const r = await bridge()
      ?.invoke('ai:startup:set', { defaultView })
      .catch(() => null);
    return pick(r);
  },
};
