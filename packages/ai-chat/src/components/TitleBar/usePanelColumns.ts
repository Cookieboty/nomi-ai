/** 顶栏读取实际列边界，跟随拖拽、窄窗收缩与面板开合动画，而不是另算一组固定宽度。 */
import { useLayoutEffect, type RefObject } from 'react';

export const LAYOUT_SETTLED_EVENT = 'nomi:layout-settled';

const LAYOUT_PANEL_SELECTOR =
  '[data-testid="chat-sidebar"], [data-testid="sidebar-panel"]:not([data-floating]), [data-testid="workspace-card"], [data-testid="chat-column"], [data-testid="side-workspace"], [data-testid="files-rail"], [data-testid="settings-view"], [data-testid="settings-nav"], .settings-workspace, .main-content';

const IGNORED_SUBTREE_SELECTOR =
  '.chat-container, .input-container, [data-testid="conversation-list"], [data-testid="sidebar-panel"][data-floating]';

const isLayoutMotionTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.matches(LAYOUT_PANEL_SELECTOR);

const isLayoutMutationNode = (node: Node): boolean => {
  if (!(node instanceof Element)) return false;
  if (node.closest('[data-testid="sidebar-panel"][data-floating]')) return false;
  return node.matches(LAYOUT_PANEL_SELECTOR) || Boolean(node.querySelector(LAYOUT_PANEL_SELECTOR));
};

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

    const lastProps = new Map<string, string>();
    const setVar = (name: string, value: string) => {
      if (lastProps.get(name) === value) return;
      lastProps.set(name, value);
      bar.style.setProperty(name, value);
    };

    const sync = () => {
      const card = queryVisibleOrFirst('workspace-card');
      const chat = queryVisibleOrFirst('chat-column');
      const center = queryVisibleOrFirst('side-workspace');
      const files = queryVisibleOrFirst('files-rail');
      // 悬停弹出的浮层（data-floating）覆盖在对话区之上，不占用文档流宽度，不能作为停靠边界推右标题栏
      const rawPanel = queryVisibleOrFirst('sidebar-panel');
      const panel = rawPanel && !rawPanel.hasAttribute('data-floating') ? rawPanel : null;
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
      const centerWidth = middle
        ? Math.max(0, Math.min(middle.width, bounds.right - centerLeft))
        : 0;
      if (bar.dataset.columnsSynced !== 'true') bar.dataset.columnsSynced = 'true';
      setVar('--titlebar-main-left', `${mainLeft}px`);
      setVar('--titlebar-main-right', `${window.innerWidth - main.right}px`);
      setVar('--titlebar-center-left', `${centerLeft}px`);
      setVar('--titlebar-center-w', `${centerWidth}px`);
      setVar('--titlebar-files-left', `${right?.left ?? bounds.right}px`);
      setVar('--titlebar-files-w', `${right?.width ?? 0}px`);
      setVar('--cd-titlebar-rail-toggle-w', `${railToggle?.offsetWidth ?? 0}px`);
      setVar('--titlebar-panel-edge', `${panelEdge}px`);
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
      if (!isLayoutMotionTarget(e.target)) return;
      const prop = (e as TransitionEvent).propertyName;
      if (prop && !LAYOUT_TRANSITION_PROPS.has(prop)) return;
      trackFor(320);
    };
    const onTransitionDone = (e: Event) => {
      if (!isLayoutMotionTarget(e.target)) return;
      const prop = (e as TransitionEvent).propertyName;
      if (prop && !LAYOUT_TRANSITION_PROPS.has(prop)) return;
      sync();
      trackFor(50);
    };
    const onAnimationStart = (e: Event) => {
      if (!isLayoutMotionTarget(e.target)) return;
      trackFor(320);
    };
    const onAnimationEnd = (e: Event) => {
      if (!isLayoutMotionTarget(e.target)) return;
      sync();
      trackFor(50);
    };
    const onSettled = () => {
      sync();
      trackFor(50);
    };

    // 监听动态挂载 / 显隐切换（设置页、工作区标签栏、停靠侧边栏），跳过对话流/输入区/浮层内部变更
    const mountObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            let needsSync = false;
            for (const record of records) {
              if (
                record.target instanceof Element &&
                record.target.closest(IGNORED_SUBTREE_SELECTOR)
              )
                continue;
              if (record.type === 'attributes') {
                if (
                  record.target instanceof Element &&
                  record.target.matches(LAYOUT_PANEL_SELECTOR)
                ) {
                  needsSync = true;
                  break;
                }
                continue;
              }
              if (record.type === 'childList') {
                for (const node of record.addedNodes) {
                  if (isLayoutMutationNode(node)) {
                    needsSync = true;
                    break;
                  }
                }
                if (needsSync) break;
                for (const node of record.removedNodes) {
                  if (isLayoutMutationNode(node)) {
                    needsSync = true;
                    break;
                  }
                }
                if (needsSync) break;
              }
            }
            if (needsSync) sync();
          });
    mountObserver?.observe(app, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'class', 'data-side-max', 'data-side-split', 'data-floating'],
    });

    app.addEventListener('transitionrun', onTransitionStart, true);
    app.addEventListener('transitionstart', onTransitionStart, true);
    app.addEventListener('transitionend', onTransitionDone, true);
    app.addEventListener('transitioncancel', onTransitionDone, true);
    app.addEventListener('animationstart', onAnimationStart, true);
    app.addEventListener('animationend', onAnimationEnd, true);
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
      app.removeEventListener('animationstart', onAnimationStart, true);
      app.removeEventListener('animationend', onAnimationEnd, true);
      window.removeEventListener(LAYOUT_SETTLED_EVENT, onSettled);
      window.removeEventListener('resize', sync);
    };
  }, [ref, key]);
}
