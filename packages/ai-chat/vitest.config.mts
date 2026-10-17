import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  setupFiles: ['./tests/setup.ts'],
  include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  overrides: { test: { testTimeout: 15_000 } },
});
