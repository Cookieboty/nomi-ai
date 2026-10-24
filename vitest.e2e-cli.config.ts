import { createVitest } from './vitest.base.ts';

/**
 * 真实 CLI 一致性测试（docs/plans/cli-plugin-architecture.md P0）：假上游 → 网关 → 本机安装的 CLI 二进制。
 * 本机没装的 CLI 自动跳过；每个用例都起真实进程，串行执行。
 */
export default createVitest({
  environment: 'node',
  include: ['e2e-cli/tests/**/*.test.ts'],
  overrides: {
    test: {
      name: 'e2e-cli',
      dir: 'e2e-cli',
      testTimeout: 180_000,
      hookTimeout: 60_000,
      fileParallelism: false,
      coverage: { enabled: false },
    },
  },
});
