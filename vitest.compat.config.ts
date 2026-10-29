import { createVitest } from './vitest.base.ts';

// 契约兼容冒烟：按 e2e/compat/baseline 重建的「旧视图」连新内核（host-node），见 e2e/compat/contractCompat.test.ts
export default createVitest({
  environment: 'node',
  include: ['e2e/compat/**/*.test.ts'],
  setupFiles: ['e2e/setup/isolateEnv.ts'],
  overrides: {
    test: {
      name: 'contract-compat',
      dir: 'e2e/compat',
      testTimeout: 30_000,
      hookTimeout: 60_000,
      coverage: { enabled: false },
    },
  },
});
