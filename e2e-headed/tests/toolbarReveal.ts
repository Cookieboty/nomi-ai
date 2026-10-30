import { expect, type Page } from '@playwright/test';

/**
 * 桌面角色工具栏只在指针悬停角色 / 工具栏时显示：把指针移到工具栏所在位置，直到它显示出来。
 * 工具栏位置在启动后才定下来（跟随角色包围盒），所以每次轮询都重新取位置。
 */
export async function revealToolbar(page: Page): Promise<void> {
  const bar = page.locator('[data-testid="mascot-toolbar"]');
  await expect
    .poll(
      async () => {
        const b = await bar.boundingBox();
        if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        return bar.getAttribute('data-mascot-ui');
      },
      { timeout: 15_000, intervals: [200] },
    )
    .toBe('');
}
