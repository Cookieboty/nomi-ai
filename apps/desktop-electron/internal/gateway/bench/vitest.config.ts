import { createVitest } from '../../../../../vitest.base.ts';

// 基准单独一份配置：默认的 vitest run（CI）不包含 bench/
export default createVitest({
  environment: 'node',
  include: ['bench/**/*.bench.ts'],
});
