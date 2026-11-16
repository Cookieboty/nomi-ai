import { createVitest } from '../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  thresholds: { statements: 79, branches: 71, functions: 81, lines: 81 },
});
