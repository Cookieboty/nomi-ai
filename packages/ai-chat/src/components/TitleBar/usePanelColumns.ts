/** 顶栏读取实际列边界，跟随拖拽、窄窗收缩与面板开合动画，而不是另算一组固定宽度。 */
import { useLayoutEffect, type RefObject } from 'react';

export const LAYOUT_SETTLED_EVENT = 'nomi:layout-settled';

const LAYOUT_TRANSITION_PROPS = new Set([
  'width',
  'min-width',
  'max-width',
  'flex',
  'flex-basis',
  'margin',
  'margin-right',
  'margin-left',
  'margin-inline',
  'margin-inline-end',
  'margin-inline-start',
  'transform',
  'translate',
]);

export function usePanelColumns(ref: RefObject<HTMLDivElement | null>, key: string) {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const app = bar.closest<HTMLElement>('.ai-chat-app');
    if (!app) return;
    const queryVisibleOrFirst = (testId: string) => {
      const all = app.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`);
      for (const el of all) {
        if (!el.hidden && el.getClientRects().length > 0) return el;
      }
      return all[0] ?? null;
    };
    const observed = new WeakSet<Element>();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => sync());
    const observeIfNeeded = (el: HTMLElement | null) => {
      if (!el || !observer || observed.has(el)) return;
      observed.add(el);
      observer.observe(el);
    };

    const sync = () => {
      const card = queryVisibleOrFirst('workspace-card');
      const chat = queryVisibleOrFirst('chat-column');
      const center = queryVisibleOrFirst('side-workspace');
      const files = queryVisibleOrFirst('files-rail');
      const panel = queryVisibleOrFirst('sidebar-panel');
      const settingsNav = queryVisibleOrFirst('settings-nav');
      const settingsMain = app.querySelector<HTMLElement>('.settings-workspace main');
      // 文件栏开关与工作区操作按钮绝对定位在标题栏右端，单独量出总宽度供左侧让位
      const railToggle = bar.querySelector<HTMLElement>('.app-titlebar-rail-toggle');

      for (const el of [
        app,
        card,
        chat,
        center,
        files,
        panel,
        settingsNav,
        settingsMain,
        railToggle,
      ]) {
        observeIfNeeded(el);
      }

      const visibleRect = (el: HTMLElement | null) =>
        el && !el.hidden && el.getClientRects().length ? el.getBoundingClientRect() : null;
      const settings = visibleRect(settingsMain);
      const bounds = settings ?? visibleRect(card);
      const main = settings ?? visibleRect(chat) ?? bounds;
      if (!main || !bounds) return;
      const middle = visibleRect(center);
      const right = visibleRect(files);
      const panelEdge = visibleRect(settingsNav)?.right ?? visibleRect(panel)?.right ?? bounds.left;
      // 主会话标题左边界绝不越过侧栏右边缘或对话卡片左边缘（防动画首帧或 transform 负偏移越界）
      const mainLeft = Math.max(main.left, bounds.left, panelEdge);
      const centerLeft = middle ? Math.max(middle.left, bounds.left) : main.right;
      bar.dataset.columnsSynced = 'true';
      bar.style.setProperty('--titlebar-main-left', `${mainLeft}px`);
      bar.style.setProperty('--titlebar-main-right', `${window.innerWidth - main.right}px`);
      bar.style.setProperty('--titlebar-center-left', `${centerLeft}px`);
      bar.style.setProperty('--titlebar-center-w', `${middle?.width ?? 0}px`);
      bar.style.setProperty('--titlebar-files-left', `${right?.left ?? bounds.right}px`);
      bar.style.setProperty('--titlebar-files-w', `${right?.width ?? 0}px`);
      bar.style.setProperty('--cd-titlebar-rail-toggle-w', `${railToggle?.offsetWidth ?? 0}px`);
      bar.style.setProperty('--titlebar-panel-edge', `${panelEdge}px`);
    };

    sync();
    // 下一帧再校对一次，消除父组件 useLayoutEffect（如工作区推拉动画初始化）晚于子组件执行带来的首帧偏移
    const rafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sync) : 0;
    let trackingUntil = 0;
    let loopId = 0;

    const stepLoop = () => {
      loopId = 0;
      sync();
      if (performance.now() < trackingUntil && typeof requestAnimationFrame === 'function') {
        loopId = requestAnimationFrame(stepLoop);
      }
    };
    const trackFor = (ms: number) => {
      if (typeof requestAnimationFrame !== 'function') {
        sync();
        return;
      }
      trackingUntil = Math.max(trackingUntil, performance.now() + ms);
      if (!loopId) loopId = requestAnimationFrame(stepLoop);
    };

    const onTransitionStart = (e: Event) => {
      const prop = (e as TransitionEvent).propertyName;
      if (prop && !LAYOUT_TRANSITION_PROPS.has(prop)) return;
      trackFor(320);
    };
    const onTransitionDone = (e: Event) => {
      const prop = (e as TransitionEvent).propertyName;
      if (prop && !LAYOUT_TRANSITION_PROPS.has(prop)) return;
      sync();
      trackFor(50);
    };
    const onSettled = () => {
      sync();
      trackFor(50);
    };

    // 监听动态挂载 / 显隐切换（设置页、工作区标签栏、侧边栏）
    const mountObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            sync();
          });
    mountObserver?.observe(app, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'data-side-max', 'data-side-split'],
    });

    app.addEventListener('transitionrun', onTransitionStart, true);
    app.addEventListener('transitionstart', onTransitionStart, true);
    app.addEventListener('transitionend', onTransitionDone, true);
    app.addEventListener('transitioncancel', onTransitionDone, true);
    app.addEventListener('animationend', onSettled, true);
    window.addEventListener(LAYOUT_SETTLED_EVENT, onSettled);
    window.addEventListener('resize', sync);
    return () => {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      if (loopId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(loopId);
      observer?.disconnect();
      mountObserver?.disconnect();
      app.removeEventListener('transitionrun', onTransitionStart, true);
      app.removeEventListener('transitionstart', onTransitionStart, true);
      app.removeEventListener('transitionend', onTransitionDone, true);
      app.removeEventListener('transitioncancel', onTransitionDone, true);
      app.removeEventListener('animationend', onSettled, true);
      window.removeEventListener(LAYOUT_SETTLED_EVENT, onSettled);
      window.removeEventListener('resize', sync);
    };
  }, [ref, key]);
}
