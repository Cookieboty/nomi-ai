import { defineConfig } from 'vitest/config';

/**
 * 与根目录 vitest.base.ts 的 coverageConfig 同一口径。这个包不能直接 import 它：
 * tsconfig.check.json 把 rootDir 钉在包内（include 里带 vitest.config.ts），跨目录引用会撞
 * TS5097 / TS6059。改口径时两边一起改。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*.{test,spec}.{ts,tsx}', 'src/**/__mocks__/**'],
      enabled: !!process.env.CI,
      thresholds: { statements: 43, branches: 41, functions: 57, lines: 43 },
    },
  },
});
