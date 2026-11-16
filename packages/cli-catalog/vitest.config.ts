import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
  thresholds: { statements: 52, branches: 42, functions: 54, lines: 59 },
});
