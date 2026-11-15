import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'happy-dom',
  include: ['tests/**/*.test.{ts,tsx}'],
  thresholds: { statements: 66, branches: 51, functions: 44, lines: 69 },
});
