import { defineConfig, type UserConfig } from 'vitest/config';

export type VitestEnv = 'node' | 'jsdom' | 'happy-dom';

/** 覆盖率下限（百分数）。只往上调；调低要在 PR 里写理由。 */
export interface CoverageThresholds {
  statements?: number;
  branches?: number;
  functions?: number;
  lines?: number;
}

/**
 * 各包共用的覆盖率统计口径（渲染进程的配置用 mergeConfig 合并 vite 配置，也复用这份）。
 *
 * 只在 CI 里统计：本地单跑一个文件时不必背上整包统计的开销。门槛也要有数据才判得动 ——
 * 原来的 `test` 只是 `vitest run`，CI 上传的各包 coverage 目录一直是空的（或上一次本地跑剩下的）。
 */
export function coverageConfig(thresholds?: CoverageThresholds) {
  return {
    provider: 'v8' as const,
    reporter: ['text', 'lcov', 'html'],
    include: ['src/**/*.{ts,tsx}'],
    exclude: ['src/**/*.d.ts', 'src/**/*.{test,spec}.{ts,tsx}', 'src/**/__mocks__/**'],
    enabled: !!process.env.CI,
    ...(thresholds ? { thresholds } : {}),
  };
}

export interface CreateVitestOptions {
  environment?: VitestEnv;
  setupFiles?: string[];
  include?: string[];
  thresholds?: CoverageThresholds;
  overrides?: UserConfig;
}

export function createVitest({
  environment = 'node',
  setupFiles = [],
  include = ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
  thresholds,
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
      coverage: coverageConfig(thresholds),
      ...(testOverrides ?? {}),
    },
  });
}
