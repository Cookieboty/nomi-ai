import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'happy-dom',
  include: ['tests/**/*.test.{ts,tsx}'],
  thresholds: { statements: 79, branches: 67, functions: 75, lines: 83 },
});
