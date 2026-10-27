import { createTsup } from '../../tsup.base';

// media 子入口：纯函数 + schema，渲染层（图片工作台 / 设置页）也直接引用
export default createTsup({
  preset: 'node-lib',
  entry: { index: 'src/index.ts', media: 'src/media/index.ts' },
});
