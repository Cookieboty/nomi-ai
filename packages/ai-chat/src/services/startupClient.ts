/**
 * 「启动 Nomi 后默认显示」（`startup.defaultView`）与主进程的通信（应用契约 `startup.*`，主进程 startup/StartupService）。
 * 没有契约传输（浏览器预览 / 测试）时 `available()` 为 false，界面不显示该设置。
 */
import { api, hasTransport } from './api';

export type StartupView = 'mascot' | 'main';
export const DEFAULT_STARTUP_VIEW: StartupView = 'mascot';
/** 关闭主界面时：hide（默认，看板娘与托盘继续运行）/ quit（完全退出 Nomi） */
export type CloseMainAction = 'hide' | 'quit';
export const DEFAULT_CLOSE_MAIN: CloseMainAction = 'hide';

/** 读取 / 写入失败时为 null（调用方回落到默认或回滚界面） */
const read = (): Promise<unknown> =>
  hasTransport() ? api.startup.get().catch(() => null) : Promise.resolve(null);
const write = (patch: {
  defaultView?: StartupView;
  closeMain?: CloseMainAction;
  showMascot?: boolean;
}): Promise<unknown> =>
  hasTransport() ? api.startup.set(patch).catch(() => null) : Promise.resolve(null);

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
  available: () => hasTransport(),
  /** 读取失败 / 值异常时回落到默认（看板娘） */
  async get(): Promise<StartupView> {
    const r = await read();
    return pick(r) ?? DEFAULT_STARTUP_VIEW;
  },
  /** 关闭主界面时的动作；读取失败回落到默认（隐藏到托盘） */
  async getCloseMain(): Promise<CloseMainAction> {
    const r = await read();
    return pickClose(r) ?? DEFAULT_CLOSE_MAIN;
  },
  /** 返回主进程确认后的值；失败时返回 null（调用方回滚界面） */
  async setCloseMain(closeMain: CloseMainAction): Promise<CloseMainAction | null> {
    const r = await write({ closeMain });
    return pickClose(r);
  },
  /** 是否显示桌面看板娘；读取失败 / 老配置回落到显示 */
  async getShowMascot(): Promise<boolean> {
    const r = await read();
    return pickShowMascot(r) ?? true;
  },
  /**
   * 立即显示 / 关闭看板娘；返回主进程确认后的 { showMascot, defaultView }，失败时返回 null。
   * 默认界面为看板娘时关闭她，主进程会把默认界面改为「软件主界面」（#55），defaultView 随之变化。
   */
  async setShowMascot(
    showMascot: boolean,
  ): Promise<{ showMascot: boolean; defaultView: StartupView } | null> {
    const r = await write({ showMascot });
    const s = pickShowMascot(r);
    const v = pick(r);
    return s === null || v === null ? null : { showMascot: s, defaultView: v };
  },
  /** 看板娘工具栏「关闭看板娘」等外部改动；返回取消订阅 */
  onShowMascotChange(
    fn: (showMascot: boolean, defaultView: StartupView | null) => void,
  ): () => void {
    if (!hasTransport()) return () => undefined;
    return api.on('startup.changed', (r) => {
      const v = pickShowMascot(r);
      if (v !== null) fn(v, pick(r));
    });
  },
  /** 返回主进程确认后的值；失败时返回 null（调用方回滚界面） */
  async set(defaultView: StartupView): Promise<StartupView | null> {
    const r = await write({ defaultView });
    return pick(r);
  },
};
