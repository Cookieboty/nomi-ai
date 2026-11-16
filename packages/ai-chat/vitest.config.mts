import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  // 下限比实测低 2~3 个点：拦覆盖率下滑，不拦正常的代码挪动。只往上调。
  thresholds: { statements: 79, branches: 71, functions: 74, lines: 82 },
  overrides: { test: { testTimeout: process.platform === 'win32' ? 30_000 : 15_000 } },
});
