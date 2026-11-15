import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'happy-dom',
  include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  thresholds: { statements: 81, branches: 69, functions: 83, lines: 85 },
});
