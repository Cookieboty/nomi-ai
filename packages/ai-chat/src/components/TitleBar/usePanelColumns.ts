/** 顶栏读取实际列边界，跟随拖拽、窄窗收缩与面板开合，而不是另算一组固定宽度。 */
import { useLayoutEffect, type RefObject } from 'react';

export function usePanelColumns(ref: RefObject<HTMLDivElement | null>, key: string) {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const app = bar.closest('.ai-chat-app');
    if (!app) return;
    const query = (testId: string) => app.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const card = query('workspace-card');
    const chat = query('chat-column');
    const center = query('side-workspace');
    const files = query('files-rail');
    const panel = query('sidebar-panel');
    const settingsNav = query('settings-nav');
    const settingsContent = app.querySelector<HTMLElement>('.settings-workspace main');
    const sync = () => {
      const visibleRect = (el: HTMLElement | null) =>
        el?.getClientRects().length ? el.getBoundingClientRect() : null;
      const settings = visibleRect(app.querySelector<HTMLElement>('.settings-workspace main'));
      const bounds = settings ?? visibleRect(card);
      const main = settings ?? visibleRect(chat) ?? bounds;
      if (!main || !bounds) return;
      const middle = visibleRect(center);
      const right = visibleRect(files);
      bar.style.setProperty('--titlebar-main-left', `${main.left}px`);
      bar.style.setProperty('--titlebar-main-right', `${window.innerWidth - main.right}px`);
      bar.style.setProperty('--titlebar-center-left', `${middle?.left ?? main.right}px`);
      bar.style.setProperty('--titlebar-center-w', `${middle?.width ?? 0}px`);
      bar.style.setProperty('--titlebar-files-left', `${right?.left ?? bounds.right}px`);
      bar.style.setProperty('--titlebar-files-w', `${right?.width ?? 0}px`);
      bar.style.setProperty(
        '--titlebar-panel-edge',
        `${visibleRect(settingsNav)?.right ?? visibleRect(panel)?.right ?? bounds.left}px`,
      );
    };
    sync();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    for (const el of [app, card, chat, center, files, panel, settingsNav, settingsContent])
      if (el) observer?.observe(el);
    // 设置页为懒加载，初次提交时可能仍是 Suspense 占位。
    const mountObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            const changed = records.some((record) =>
              [...record.addedNodes, ...record.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches('[data-testid="settings-view"]') ||
                    node.querySelector('[data-testid="settings-view"]')),
              ),
            );
            if (!changed) return;
            for (const el of [
              query('settings-nav'),
              app.querySelector<HTMLElement>('.settings-workspace main'),
            ]) {
              if (el) observer?.observe(el);
            }
            sync();
          });
    mountObserver?.observe(app, { childList: true, subtree: true });
    window.addEventListener('resize', sync);
    return () => {
      observer?.disconnect();
      mountObserver?.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [ref, key]);
}
