import { createVitest } from './vitest.base.ts';

// 无界面 E2E：真实内核跑在 @nomi-ai/host-node 上（不启动 Electron），见 docs/development/testing.md
export default createVitest({
  environment: 'node',
  // 相对 dir（e2e）
  include: ['tests/**/*.{test,spec}.{ts,mts}'],
  setupFiles: ['e2e/setup/isolateEnv.ts'],
  overrides: {
    test: {
      name: 'e2e-headless',
      // 一个用例都没找到时失败（配置写错时不悄悄「通过」）
      passWithNoTests: false,
      dir: 'e2e',
      testTimeout: 30_000,
      hookTimeout: 60_000,
      // 与有界面 E2E（playwright.config.ts）同一规则：CI 上失败的用例重试一次，重试才过的在输出里标
      // 「retry x1」（不悄悄放过）；两次都失败才算失败。本地不重试
      retry: process.env.CI ? 1 : 0,
      // CI 上逐个列出用例，重试过的那条带黄色「(retry x1)」后缀（默认报告器不列通过的用例）
      reporters: process.env.CI ? ['verbose'] : ['default'],
      coverage: {
        enabled: false,
      },
    },
  },
});
