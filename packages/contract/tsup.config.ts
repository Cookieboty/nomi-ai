import { createTsup } from '../../tsup.base';

// neutral：视图（浏览器）与内核（Node）共用同一份产物
// splitting：index / testing / app 共享同一份 ContractError 等实现（否则各入口各打一份，
// instanceof 跨入口失效，例如 testing 的会话把 index 的 ContractError 当成 INTERNAL）
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
