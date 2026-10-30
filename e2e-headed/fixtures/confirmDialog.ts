import type { Page } from '@playwright/test';

/** 在页面里装观察器：应用内确认框一出现就点「确定」（同一文档只装一次） */
function install(): void {
  const w = window as unknown as { __autoAcceptConfirms?: boolean };
  if (w.__autoAcceptConfirms) return;
  w.__autoAcceptConfirms = true;
  const start = () => {
    const click = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-ok"]')?.click();
    new MutationObserver(click).observe(document.body, { childList: true, subtree: true });
    click();
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}

/**
 * 应用里的确认已经不用 window.confirm（不会触发 Playwright 的 'dialog' 事件），
 * 而是应用内确认框（data-testid="confirm-dialog"）。等价于以前的
 * `page.on('dialog', (d) => d.accept())`：当前页面立即生效，之后重新加载也继续生效。
 */
export async function autoAcceptConfirms(page: Page): Promise<void> {
  await page.addInitScript(install);
  await page.evaluate(install);
}
