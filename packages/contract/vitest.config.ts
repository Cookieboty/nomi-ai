import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
  thresholds: { statements: 89, branches: 78, functions: 89, lines: 92 },
});
