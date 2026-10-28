/**
 * IMAGE · 图片主题（真实应用：packages/host-electron 的 dist，内核 createCore 里真实的 ThemeService /
 * ChatBackgroundService 与宿主的 chat-asset:// 协议）
 *
 * 选图片主题 → 内置预设图（1920×1080）→ 换成自己的图（系统对话框在主进程里打桩）→ 毛玻璃 / 透明度
 * 写盘 → 切别的主题再切回来保留设置 → 重启后仍在 → 恢复预设。
 *
 * 打包后的预设图位置（resources/assets/backgrounds，经 extraResources、不进 asar）由
 * host-electron 的单测 `tests/unit/chat/backgroundPreset.test.ts` 与 `host/assetProtocol.test.ts` 守住：
 * 这里不能把整个应用伪装成已打包（窗口、日志、更新都会跟着走打包路径）。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';
import { ISOLATED_HOME_ARGS, isolatedHomeEnv } from '../fixtures/homeEnv';

const electronPkgDir = resolve(repoRoot(), 'packages', 'host-electron');
const mainJs = resolve(electronPkgDir, 'dist', 'main.js');
const aiChatBuild = resolve(electronPkgDir, 'dist', 'ai-chat', 'index.html');
const isChat = (url: string) => /ai-chat/.test(url);

/** 竖条纹 PNG（橙 / 深蓝各 10px）：毛玻璃前后截图要能看出差别，纯色图模糊了也一样 */
function stripesPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    const [r, g, b] = Math.floor(x / 10) % 2 ? [0x17, 0x25, 0x54] : [0xf9, 0x73, 0x16];
    row.writeUInt8(r, 1 + x * 3);
    row.writeUInt8(g, 2 + x * 3);
    row.writeUInt8(b, 3 + x * 3);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('image theme persists custom overrides and restores the bundled preset', async () => {
  test.skip(!existsSync(mainJs) || !existsSync(aiChatBuild), '先 pnpm build');
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), 'nomi-image-theme-'));
  const home = mkdtempSync(join(tmpdir(), 'nomi-image-theme-home-'));
  const backgroundFile = join(userData, 'chat-background.json');
  const themeFile = join(userData, 'theme.json');
  const source = join(home, 'source.png');
  writeFileSync(source, stripesPng(640, 400));
  mkdirSync(userData, { recursive: true });
  writeFileSync(themeFile, JSON.stringify({ theme: 'graphite' }));
  // 启动直接开主界面、不显示看板娘
  writeFileSync(
    join(userData, 'startup.json'),
    JSON.stringify({ defaultView: 'main', showMascot: false }),
  );

  let application: ElectronApplication | null = null;
  const close = async () => {
    if (!application) return;
    const proc = application.process();
    await Promise.race([
      application.close().catch(() => undefined),
      new Promise((resolveClose) => setTimeout(resolveClose, 5_000)),
    ]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    application = null;
  };
  const launch = async (): Promise<Page> => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...isolatedHomeEnv(home),
      CD_LOCALE: 'zh-CN',
      CD_ONBOARDING: 'off',
      CD_TTS: 'off',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };
    delete env.NODE_ENV;
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      executablePath: resolveElectronExecutable(),
      args: [
        electronPkgDir,
        `--user-data-dir=${userData}`,
        '--enable-unsafe-swiftshader',
        ...ISOLATED_HOME_ARGS,
      ],
      cwd: electronPkgDir,
      env,
      timeout: 60_000,
    });
    await expect
      .poll(() => application!.windows().some((p) => isChat(p.url())), { timeout: 30_000 })
      .toBe(true);
    const page = application.windows().find((p) => isChat(p.url()))!;
    await page.getByTestId('chat-input').waitFor({ timeout: 30_000 });
    // 系统「选择图片」对话框：主进程里打桩，返回准备好的图
    await application.evaluate(({ dialog }, file) => {
      (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, source);
    return page;
  };

  try {
    let page = await launch();
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('theme-image')).toBeVisible();
    await expect(page.getByTestId('image-theme-settings')).toHaveCount(0);
    await expect(page.getByTestId('settings-chat-bg')).toHaveCount(0);
    await expect(page.getByTestId('chat-bg-layer')).toHaveCount(0);

    await page.getByTestId('theme-image').click();
    await expect(page.getByTestId('theme-image')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('chat-bg-pick')).toBeVisible();
    await expect(page.getByTestId('chat-bg-image-set')).toHaveText('预设图片（可替换）');
    await expect(page.getByTestId('chat-bg-blur')).toHaveValue('8');
    await expect(page.getByTestId('chat-bg-opacity')).toHaveValue('40');
    await expect(page.getByTestId('chat-bg-reset')).toHaveCount(0);
    // 解码失败（Windows runner 上偶发）时重试，而不是一次就判失败；失败原因带进断言信息
    await expect
      .poll(() =>
        page.getByTestId('chat-bg-image').evaluate(async (image) => {
          const probe = new Image();
          probe.src = getComputedStyle(image).backgroundImage.slice(5, -2);
          try {
            await probe.decode();
          } catch (e) {
            return `${probe.src}: ${String(e)}`;
          }
          return { width: probe.naturalWidth, height: probe.naturalHeight };
        }),
      )
      .toEqual({ width: 1920, height: 1080 });
    await expect(page.getByRole('slider', { name: '毛玻璃' })).toBeEnabled();
    await page.getByTestId('chat-bg-pick').click();
    await expect(page.getByTestId('chat-bg-image-set')).toBeVisible();
    const initialImage = await page
      .getByTestId('chat-bg-layer')
      .evaluate((layer) => layer.style.getPropertyValue('--cd-chat-bg-image'));
    await page.getByTestId('chat-bg-pick').click();
    await expect
      .poll(() =>
        page
          .getByTestId('chat-bg-layer')
          .evaluate((layer) => layer.style.getPropertyValue('--cd-chat-bg-image')),
      )
      .not.toBe(initialImage);
    await expect(page.getByTestId('settings-appearance').getByRole('slider')).toHaveCount(2);
    await expect(page.getByTestId('chat-bg-blur')).toHaveValue('8');
    await expect(page.getByTestId('chat-bg-opacity')).toHaveValue('40');
    await expect(page.getByTestId('chat-bg-image')).toHaveCSS('filter', 'blur(8px)');
    await expect(page.getByTestId('chat-bg-mask')).toHaveCSS('backdrop-filter', 'none');
    await expect(page.locator('.settings-overlay')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    await expect.poll(() => JSON.parse(readFileSync(themeFile, 'utf8')).theme).toBe('image');

    const image = page.getByTestId('chat-bg-image');
    // 窗口右侧露出背景的一小块；Windows runner 屏幕只有 1024 宽，窗口会被压窄，不能写死 x
    const bgClip = async () => {
      const width = await page.evaluate(() => window.innerWidth);
      return { x: width - 70, y: 200, width: 40, height: 40 };
    };
    const slider = page.getByRole('slider', { name: '毛玻璃' });
    await slider.focus();
    await slider.press('Home');
    await slider.press('ArrowRight');
    await expect(slider).toHaveValue('1');
    const clearBackground = await page.screenshot({
      clip: await bgClip(),
    });
    const sliderBounds = (await slider.boundingBox())!;
    await page.mouse.move(sliderBounds.x + 8, sliderBounds.y + sliderBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sliderBounds.x + sliderBounds.width * 0.5,
      sliderBounds.y + sliderBounds.height / 2,
      { steps: 15 },
    );
    await page.mouse.up();
    const glass = await slider.inputValue();
    expect(Number(glass)).toBeGreaterThan(1);
    await expect(page.getByTestId('chat-bg-image')).toHaveCSS('filter', `blur(${glass}px)`);
    const frostedBackground = await page.screenshot({
      clip: await bgClip(),
    });
    expect(frostedBackground.equals(clearBackground)).toBe(false);
    await expect(image).toHaveCSS('transform', 'none');
    await expect
      .poll(() => JSON.parse(readFileSync(backgroundFile, 'utf8')).blur)
      .toBe(Number(glass));

    const opacity = page.getByTestId('chat-bg-opacity');
    await opacity.focus();
    await opacity.press('End');
    await opacity.press('ArrowLeft');
    await expect(opacity).toHaveValue('99');
    const beforeReplacement = JSON.parse(readFileSync(backgroundFile, 'utf8')).imageUrl;
    await page.getByTestId('chat-bg-pick').click();
    await expect
      .poll(() => JSON.parse(readFileSync(backgroundFile, 'utf8')).imageUrl)
      .not.toBe(beforeReplacement);
    await expect(page.getByTestId('chat-bg-blur')).toHaveValue(glass);
    await expect(opacity).toHaveValue('99');

    await page.keyboard.press('Escape');
    const sidebar = page.getByTestId('chat-sidebar');
    const brand = page.getByTestId('sidebar-toggle');
    // 收起 / 展开侧栏按钮固定在标题栏红绿灯旁
    await expect(page.getByTestId('titlebar-sidebar-toggle')).toBeVisible();
    await expect(brand).toHaveAttribute('aria-expanded', 'true');
    await expect(brand.getByTestId('sidebar-brand-mark')).toBeVisible();
    const sidebarBackground = await sidebar.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    const composerBackground = await page
      .getByTestId('chat-input')
      .evaluate(
        (element) => getComputedStyle(element.closest('[class*="inputWrapper"]')!).backgroundColor,
      );
    expect(composerBackground).toBe(sidebarBackground);
    await brand.getByTestId('sidebar-brand-mark').click();
    await expect(brand).toHaveAttribute('aria-expanded', 'false');
    await expect(brand).toHaveText('');
    await brand.press('Enter');
    await expect(brand).toHaveAttribute('aria-expanded', 'true');
    await brand.getByText('Nomi', { exact: true }).click();
    await expect(brand).toHaveAttribute('aria-expanded', 'false');
    await brand.press('Space');
    await expect(brand).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('open-settings').click();

    await page.getByTestId('theme-cream').click();
    await expect(page.getByTestId('chat-bg-layer')).toHaveCount(0);
    await expect(page.getByTestId('image-theme-settings')).toHaveCount(0);
    await page.getByTestId('theme-image').click();
    await expect(page.getByTestId('chat-bg-blur')).toHaveValue(glass);
    await expect(page.getByTestId('chat-bg-image-set')).toBeVisible();
    await expect.poll(() => JSON.parse(readFileSync(themeFile, 'utf8')).theme).toBe('image');
    const selectedUrl = JSON.parse(readFileSync(backgroundFile, 'utf8')).imageUrl;
    unlinkSync(source);
    await close();

    page = await launch();
    await expect(page.getByTestId('chat-bg-image')).toHaveCSS('filter', `blur(${glass}px)`);
    await expect(page.locator('html')).toHaveAttribute('data-theme-pref', 'image');
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('theme-image')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('chat-bg-opacity')).toHaveValue('99');
    await expect(page.getByTestId('chat-bg-image-set')).toBeVisible();
    await expect(page.getByTestId('chat-bg-layer')).toHaveCSS(
      '--cd-chat-bg-image',
      `url("${selectedUrl}")`,
    );
    await expect
      .poll(() =>
        page.getByTestId('chat-bg-image').evaluate((image) => {
          const url = getComputedStyle(image).backgroundImage.slice(5, -2);
          const probe = new Image();
          probe.src = url;
          return probe.decode().then(() => probe.naturalWidth > 0);
        }),
      )
      .toBe(true);
    await page.getByTestId('chat-bg-reset').click();
    await expect(page.getByTestId('chat-bg-image-set')).toHaveText('预设图片（可替换）');
    await expect(page.getByTestId('chat-bg-blur')).toHaveValue('8');
    await expect(page.getByTestId('chat-bg-opacity')).toHaveValue('40');
    expect(JSON.parse(readFileSync(backgroundFile, 'utf8')).imageUrl).toBe(
      'chat-asset://presets/background.jpg',
    );
    expect(
      await page.getByTestId('chat-bg-image').evaluate(async (image) => {
        const probe = new Image();
        probe.src = getComputedStyle(image).backgroundImage.slice(5, -2);
        await probe.decode();
        return { width: probe.naturalWidth, height: probe.naturalHeight };
      }),
    ).toEqual({ width: 1920, height: 1080 });
    await expect(page.getByTestId('theme-image')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('theme-system').click();
    await expect(page.getByTestId('chat-bg-layer')).toHaveCount(0);
  } finally {
    await close();
    safeRm(userData);
    safeRm(home);
  }
});
