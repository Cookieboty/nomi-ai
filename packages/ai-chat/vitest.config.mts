import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  overrides: { test: { testTimeout: process.platform === 'win32' ? 30_000 : 15_000 } },
});
