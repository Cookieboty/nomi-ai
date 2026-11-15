import { defineConfig, mergeConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.base.ts';
import viteConfig from './vite.config.mts';

/**
 * Renderer tests load React modules through Vite. When the monorepo runs
 * all packages concurrently, the first dynamic import can exceed Vitest's
 * default 5-second timeout even though the test itself is healthy.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      passWithNoTests: true,
      testTimeout: 15_000,
      hookTimeout: 15_000,
      coverage: coverageConfig({ statements: 50, branches: 49, functions: 43, lines: 51 }),
    },
  }),
);
