import { createTsup } from '../../tsup.base';

// neutral：视图（浏览器）与内核（Node）共用同一份产物
export default createTsup({
  preset: 'node-lib',
  platform: 'neutral',
  entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts' },
});
