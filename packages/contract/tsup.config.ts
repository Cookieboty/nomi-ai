import { createTsup } from '../../tsup.base';

// neutral：视图（浏览器）与内核（Node）共用同一份产物
// splitting：index / testing / app 共享同一份实现，不必每个入口各打一份
export default createTsup({
  preset: 'node-lib',
  platform: 'neutral',
  splitting: true,
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
    'app/index': 'src/app/index.ts',
  },
});
