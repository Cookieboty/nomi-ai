/**
 * 内置浏览器窗口：宿主的 browserWindow.*（Go：core/browserwindow + wailsshell/browserwindow.go）。
 *
 * 网页放在宿主的独立原生窗口里，贴着视图给它的区域显示——不是 iframe。子框架会被目标站点的
 * `X-Frame-Options` / `CSP frame-ancestors` 拒掉（Google、GitHub 这类都拒嵌），浏览器还保留随时拒绝的
 * 权利，应用侧只能显示一张「已阻止此内容」的错误页；原生窗口里的网页是顶层文档，不参与这些判定。
 *
 * 浏览器预览 / 测试里没有宿主：available() 为 false，标签退回调系统浏览器打开。
 */
import { useEffect, useState } from 'react';

import { api, hasTransport } from './api';

/** 要贴住的区域：视图 CSS px，相对对话窗口内容区左上角（与窗口 DIP 1:1） */
export type BrowserRegion = { x: number; y: number; width: number; height: number };

export type BrowserShowResult = {
  ok: boolean;
  reason?: 'unsupported' | 'failed';
  message?: string;
};

const unsupported: BrowserShowResult = { ok: false, reason: 'unsupported' };

/** 宿主调用不阻塞界面：失败也不浮到组件上（下一次贴位会再试） */
function fire<T>(call: Promise<T> | undefined): void {
  void Promise.resolve(call).catch(() => undefined);
}

export const browserWindowHost = {
  available: () => hasTransport(),

  /** 把 url 打开在贴着 region 的原生窗口里（同一个 id 已开着时换地址并重新贴位） */
  async show(id: string, url: string, region: BrowserRegion): Promise<BrowserShowResult> {
    if (!hasTransport()) return unsupported;
    try {
      const r = await api.browserWindow.show({ id, url, region });
      return r ?? unsupported;
    } catch {
      return { ok: false, reason: 'failed', message: 'host' };
    }
  },

  /** 重新贴位；visible=false 时先藏起来（切标签、收面板） */
  setRegion(id: string, region: BrowserRegion, visible: boolean): void {
    if (!hasTransport()) return;
    fire(api.browserWindow.setRegion({ id, region, visible }));
  },

  navigate(id: string, url: string): void {
    if (!hasTransport()) return;
    fire(api.browserWindow.navigate({ id, url }));
  },

  /** 重新加载当前页：用户可能已经在窗口里点进别的页面了 */
  reload(id: string): void {
    if (!hasTransport()) return;
    fire(api.browserWindow.reload({ id }));
  },

  close(id: string): void {
    if (!hasTransport()) return;
    fire(api.browserWindow.close({ id }));
  },

  /**
   * 收掉所有开着的浏览器窗口。
   *
   * 视图卸载 / 整页重载时用：原生窗口不属于这个页面，页面重载后没人认得它们，
   * 它们会留在屏幕上盖住界面（开发态热更新最容易碰到）。
   */
  closeAll(): void {
    liveIds.clear();
    if (!hasTransport()) return;
    fire(api.browserWindow.closeAll({}));
  },

  /**
   * 报上「这一侧现在开着的窗口 id 全集」，宿主收掉不在这份清单里的（空清单 = 一个都不留）。
   *
   * 这条是「关标签」真正靠得住的路：逐个 close 只要打空一次（视图重建、id 对不上、
   * 热更新把模块换掉），那个原生视图就再没人认领、永远浮在屏幕上。全集对齐不依赖
   * 哪一次通知送出成功，只看「它现在还在不在清单里」。
   */
  sync(ids: readonly string[]): void {
    if (!hasTransport()) return;
    fire(api.browserWindow.sync({ ids: [...ids] }));
  },
};

/**
 * 这一页现在挂着的浏览器标签 id 全集（浏览器标签挂载时 retain、卸载时 release）。
 *
 * 上报走一个短去抖，并且**到点才读集合**：切会话时是「旧实例卸载 + 新实例挂载」一起发生，
 * 快照 Old 集合会把刚挂上的新标签当成「不该开」。
 */
const liveIds = new Set<string>();
let syncTimer: number | null = null;

function flushSync(): void {
  if (syncTimer !== null) {
    window.clearTimeout(syncTimer);
    syncTimer = null;
  }
  browserWindowHost.sync([...liveIds]);
}

function scheduleSync(): void {
  if (typeof window === 'undefined') return;
  if (syncTimer !== null) return;
  syncTimer = window.setTimeout(() => {
    syncTimer = null;
    browserWindowHost.sync([...liveIds]);
  }, 80);
}

/** 浏览标签挂上：记进全集（多一个不该被收的窗口） */
export function retainWindow(id: string): void {
  liveIds.add(id);
  scheduleSync();
}

/** 浏览标签卸下：从全集里去掉，宿主随即把它的窗口收走 */
export function releaseWindow(id: string): void {
  if (!liveIds.delete(id)) return;
  scheduleSync();
}

/** 立刻对一次账（页面卸载 / 热更新时用，不等去抖） */
export function syncWindowsNow(): void {
  flushSync();
}

/**
 * 订阅浏览器窗口的加载 / 关闭：拿到自己这个 id 的加载完成才收掉进度条。
 * 返回是否还挂着（组件卸载后回调不再触发）。
 */
export function useBrowserWindowEvents(
  id: string | null,
  handlers: { onLoaded?: (ok: boolean, message?: string) => void; onClosed?: () => void },
): void {
  const { onLoaded, onClosed } = handlers;
  useEffect(() => {
    if (!id || !hasTransport()) return;
    const offLoaded = api.on('browserWindow.loaded', (e) => {
      if (e.id !== id) return;
      onLoaded?.(e.ok, e.message);
    });
    const offClosed = api.on('browserWindow.closed', (e) => {
      if (e.id !== id) return;
      onClosed?.();
    });
    return () => {
      offLoaded();
      offClosed();
    };
  }, [id, onLoaded, onClosed]);
}

/**
 * 这块区域现在用户能不能看到。
 *
 * 光看几何不够：切到设置页 / 素材库时，整页视图是盖在同一块位置上的，标签区的 rect 一点没变，
 * 但屏幕上已经不是它了。所以再采样几个点，看最上层命中的是不是自己或自己的后代。
 */
export function isRegionOnScreen(el: HTMLElement | null, r?: DOMRect): boolean {
  if (!el || typeof document === 'undefined') return false;
  if (document.visibilityState === 'hidden') return false;
  const box = r ?? el.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return false;
  if (box.bottom <= 0 || box.right <= 0) return false;
  if (box.top >= window.innerHeight || box.left >= window.innerWidth) return false;
  const fromPoint = document.elementFromPoint;
  // 测试环境没实现 elementFromPoint：只能退到几何判断
  if (typeof fromPoint !== 'function') return true;
  const inset = 12;
  const points: Array<[number, number]> = [
    [box.left + box.width / 2, box.top + box.height / 2],
    [box.left + Math.min(inset, box.width / 2), box.top + Math.min(inset, box.height / 2)],
    [box.right - Math.min(inset, box.width / 2), box.bottom - Math.min(inset, box.height / 2)],
  ];
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    const hit = fromPoint.call(document, x, y);
    // 命中自己或自己的后代：这块区域确实露在最上面
    if (hit && (hit === el || el.contains(hit))) return true;
  }
  // 采样点全被别的层盖住了
  return false;
}

/** 上报给宿主的东西：贴在哪、要不要显示 */
export type RegionReport = { region: BrowserRegion; visible: boolean };

/**
 * 页面卸载 / 热更新时把开着的窗口收干。
 *
 * 原生窗口不属于这个页面：页面重载或模块被热替换后，新代码里已经没有这些 id 了，
 * 没人会去关它们——它们就留在屏幕上盖住界面（开发态最容易碰到）。
 */
let unloadBound = false;
function bindUnloadOnce(): void {
  if (unloadBound || typeof window === 'undefined') return;
  unloadBound = true;
  const flush = () => {
    syncWindowsNow();
    browserWindowHost.closeAll();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
}

bindUnloadOnce();
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unloadBound = false;
    browserWindowHost.closeAll();
  });
}

/** 把一个标签的区域变化（滚动 / 拖分隔条 / 窗口缩放 / 布局挪动）合并成每帧一次上报。
 *
 * 三种触发都得管：
 *   - 几何变化：ResizeObserver + scroll + resize（原来只有这些，切页时会漏）
 *   - 纯位置变化：位置变了不一定伴随尺寸变化（侧栏换边、上方内容变高），每 400ms 兜一次
 *   - 可见性变化：切到设置页 / 素材库时几何不变，只是被盖住了。MutationObserver 盯 DOM 变化，
 *     变化后跑一次 elementFromPoint 采样（见 isRegionOnScreen）
 *
 * 两种值都没变就不上报，避免白刷宿主。
 */
export function observeRegion(
  el: HTMLElement | null,
  onChange: (report: RegionReport) => void,
): () => void {
  if (!el || typeof window === 'undefined') return () => undefined;
  let frame = 0;
  let last: RegionReport | null = null;
  const measure = () => {
    frame = 0;
    const r = el.getBoundingClientRect();
    const region = { x: r.left, y: r.top, width: r.width, height: r.height };
    const visible = isRegionOnScreen(el, r);
    if (
      last &&
      last.visible === visible &&
      last.region.x === region.x &&
      last.region.y === region.y &&
      last.region.width === region.width &&
      last.region.height === region.height
    )
      return;
    last = { region, visible };
    onChange(last);
  };
  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(measure);
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(el);
  window.addEventListener('resize', schedule);
  // 面板里滚动时区域跟着动；capture 才能收到内部滚动容器的 scroll
  document.addEventListener('scroll', schedule, true);
  // 切页 / 收面板：整页视图盖上来时几何一点没变，只能靠 DOM 变化去复检
  const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
  mutations?.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state'],
  });
  // 纯位置变化（不改尺寸）也能跟上；值没变时 measure 会自己跳掉，不会白上报
  const drift = window.setInterval(schedule, 400);
  measure();
  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.clearInterval(drift);
    observer?.disconnect();
    mutations?.disconnect();
    window.removeEventListener('resize', schedule);
    document.removeEventListener('scroll', schedule, true);
  };
}
