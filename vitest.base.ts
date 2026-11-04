import { defineConfig, type UserConfig } from 'vitest/config';

export type VitestEnv = 'node' | 'jsdom' | 'happy-dom';

export interface CreateVitestOptions {
  environment?: VitestEnv;
  setupFiles?: string[];
  include?: string[];
  overrides?: UserConfig;
}

export function createVitest({
  environment = 'node',
  setupFiles = [],
  include = ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
  overrides = {},
}: CreateVitestOptions = {}) {
  // overrides.test 合并进下面的 test，不能放在最后整个展开：那样 test 被 overrides.test 整个替换，
  // setupFiles / include / environment 全丢（ai-chat 的 tests/setup.ts、无界面 e2e 的 isolateEnv 曾因此从未加载）
  const { test: testOverrides, ...rest } = overrides;
  return defineConfig({
    ...rest,
    test: {
      environment,
      setupFiles,
      include,
      globals: false,
      passWithNoTests: true,
      // Windows runner 上 happy-dom 渲染、真实文件 / 子进程都慢 2~5 倍（各包可再用 overrides.test 覆盖）
      testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.d.ts', 'src/**/*.{test,spec}.{ts,tsx}', 'src/**/__mocks__/**'],
      },
      ...(testOverrides ?? {}),
    },
  });
}
