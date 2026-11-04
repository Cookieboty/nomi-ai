import { createVitest } from './vitest.base.ts';

/**
 * 真实 CLI 一致性测试（docs/design/cli-plugin-architecture.md §9 / e2e-cli）：假上游 → 网关 → 本机安装的 CLI 二进制。
 * 本机没装的 CLI 自动跳过；每个用例都起真实进程，串行执行。
 */
export default createVitest({
  environment: 'node',
  // 相对 dir（e2e-cli）
  include: ['tests/**/*.test.ts'],
  overrides: {
    test: {
      name: 'e2e-cli',
      // 一个用例都没找到时失败（配置写错时不悄悄「通过」）
      passWithNoTests: false,
      dir: 'e2e-cli',
      testTimeout: 180_000,
      hookTimeout: 60_000,
      fileParallelism: false,
      coverage: { enabled: false },
    },
  },
});
