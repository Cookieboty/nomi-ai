import { defineConfig } from '@playwright/test';

// e2e 断言使用中文原文：固定界面语言（各用例启动 Electron 时透传 process.env）
process.env.CD_LOCALE ||= 'zh-CN';
// 首次启动引导默认不弹出（引导自己的用例里显式开启）
process.env.CD_ONBOARDING ||= 'off';
// e2e 不调用实时朗读引擎（避免外网请求与 CPU 抢占，气泡事件更稳定）。
process.env.CD_TTS ||= 'off';

export default defineConfig({
  testDir: './e2e-headed/tests',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },
});
