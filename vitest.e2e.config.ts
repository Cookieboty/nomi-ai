import { createVitest } from './vitest.base.ts';

// 无界面 E2E：真实内核跑在 @nomi-ai/host-node 上（不启动 Electron），见 docs/development/testing.md
export default createVitest({
  environment: 'node',
  include: ['e2e/tests/**/*.{test,spec}.{ts,mts}'],
  setupFiles: ['e2e/setup/isolateEnv.ts'],
  overrides: {
    test: {
      name: 'e2e-headless',
      dir: 'e2e',
      testTimeout: 30_000,
      hookTimeout: 60_000,
      coverage: {
        enabled: false,
      },
    },
  },
});
