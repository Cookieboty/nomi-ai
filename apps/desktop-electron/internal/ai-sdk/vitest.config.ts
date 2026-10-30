import { createVitest } from '../../../../vitest.base.ts';

export default createVitest({
  environment: 'node',
  include: ['tests/**/*.{test,spec}.ts'],
});
