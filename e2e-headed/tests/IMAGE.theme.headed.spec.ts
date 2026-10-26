import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

import { repoRoot, resolveElectronExecutable } from '../fixtures/electronApp';
import { safeRm } from '../fixtures/fsutil';

const electronDirectory = resolve(repoRoot(), 'packages/electron');

for (const packaged of [false, true]) {
  test(`image theme persists custom overrides and restores bundled preset (${packaged ? 'packaged resources' : 'development'})`, async () => {
    test.setTimeout(120_000);
    const userData = mkdtempSync(join(tmpdir(), 'nomi-image-theme-'));
    const images = join(userData, 'chat/images');
    const backgroundFile = join(userData, 'chat-background.json');
    const themeFile = join(userData, 'theme.json');
    const source = join(userData, 'source.png');
    const resources = join(userData, 'test-app-resources');
    if (packaged) {
      const assets = join(resources, 'assets', 'backgrounds');
      mkdirSync(assets, { recursive: true });
      copyFileSync(
        join(electronDirectory, 'assets', 'backgrounds', 'nomi-preset.jpg'),
        join(assets, 'nomi-preset.jpg'),
      );
    }
    writeFileSync(
      source,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    writeFileSync(themeFile, JSON.stringify({ theme: 'graphite' }));
    writeFileSync(
      join(userData, 'startup.json'),
      JSON.stringify({ defaultView: 'main', showMascot: false }),
    );

    let application: ElectronApplication | null = null;
    const close = async () => {
      if (!application) return;
      const process = application.process();
      await Promise.race([
        application.close().catch(() => undefined),
        new Promise((resolveClose) => setTimeout(resolveClose, 5_000)),
      ]);
      if (process.exitCode === null) process.kill('SIGKILL');
      application = null;
    };
    const launch = async (): Promise<Page> => {
      const env = { ...process.env, NODE_ENV: 'test', CD_ONBOARDING: 'off', CD_TTS: 'off' };
      delete env.ELECTRON_RUN_AS_NODE;
      application = await electron.launch({
        executablePath: resolveElectronExecutable(),
        args: [resolve(repoRoot(), 'e2e-headed/harness/main.cjs'), '--profile=chat-only'],
        cwd: repoRoot(),
        env,
        timeout: 30_000,
      });
      await application.evaluate(
        async (
          { app, BrowserWindow },
          { electronDirectory, userData, themeFile, backgroundFile, images, packaged, resources },
        ) => {
          const requireModule = process.mainModule!.require.bind(process.mainModule);
          const { resolve } = requireModule('node:path');
          app.setPath('userData', userData);
          Object.defineProperty(app, 'isPackaged', { value: packaged });
          Object.defineProperty(process, 'resourcesPath', { value: resources });
          const { ThemeService } = requireModule(
            resolve(electronDirectory, 'dist/theme/ThemeService.js'),
          );
          const { ChatBackgroundService } = requireModule(
            resolve(electronDirectory, 'dist/chat/ChatBackgroundService.js'),
          );
          const { registerChatAssetProtocol } = requireModule(
            resolve(electronDirectory, 'dist/chat/assetProtocol.js'),
          );
          new ThemeService(themeFile).registerIpc();
          new ChatBackgroundService(backgroundFile, images).registerIpc();
          registerChatAssetProtocol();
          const window = new BrowserWindow({
            width: 1280,
            height: 900,
            webPreferences: {
              preload: resolve(electronDirectory, 'dist/ai-chat-preload.bundle.js'),
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
            },
          });
          await window.loadFile(resolve(electronDirectory, 'dist/ai-chat/index.html'));
        },
        { electronDirectory, userData, themeFile, backgroundFile, images, packaged, resources },
      );
      await expect
        .poll(() => application!.windows().some((page) => /ai-chat/.test(page.url())))
        .toBe(true);
      const page = application.windows().find((page) => /ai-chat/.test(page.url()))!;
      await page.getByTestId('chat-input').waitFor();
      return page;
    };

    try {
      let page = await launch();
      const fixturePage = application!.windows().find((window) => !/ai-chat/.test(window.url()))!;
      await fixturePage.setContent(
        '<body style="margin:0;height:100vh;background:repeating-linear-gradient(90deg,#f97316 0 10px,#172554 10px 20px)"></body>',
      );
      await fixturePage.screenshot({ path: source });
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
      const presetSize = await page.getByTestId('chat-bg-image').evaluate(async (image) => {
        const probe = new Image();
        probe.src = getComputedStyle(image).backgroundImage.slice(5, -2);
        await probe.decode();
        return { width: probe.naturalWidth, height: probe.naturalHeight };
      });
      expect(presetSize).toEqual({ width: 1920, height: 1080 });
      await expect(page.getByRole('slider', { name: '毛玻璃' })).toBeEnabled();
      await application!.evaluate(({ dialog }, source) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      }, source);
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
      const slider = page.getByRole('slider', { name: '毛玻璃' });
      await slider.focus();
      await slider.press('Home');
      await slider.press('ArrowRight');
      await expect(slider).toHaveValue('1');
      const clearBackground = await page.screenshot({
        clip: { x: 1210, y: 200, width: 40, height: 40 },
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
        clip: { x: 1210, y: 200, width: 40, height: 40 },
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
      await expect(page.getByTestId('app-titlebar').getByRole('button')).toHaveCount(0);
      await expect(brand).toHaveAttribute('aria-expanded', 'true');
      await expect(brand.getByTestId('endpoint-icon-nomi')).toBeVisible();
      const sidebarBackground = await sidebar.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      const composerBackground = await page
        .getByTestId('chat-input')
        .evaluate(
          (element) =>
            getComputedStyle(element.closest('[class*="inputWrapper"]')!).backgroundColor,
        );
      expect(composerBackground).toBe(sidebarBackground);
      await brand.getByTestId('endpoint-icon-nomi').click();
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
      ).toEqual(presetSize);
      await expect(page.getByTestId('theme-image')).toHaveAttribute('aria-checked', 'true');
      await page.getByTestId('theme-system').click();
      await expect(page.getByTestId('chat-bg-layer')).toHaveCount(0);
    } finally {
      await close();
      safeRm(userData);
    }
  });
}
