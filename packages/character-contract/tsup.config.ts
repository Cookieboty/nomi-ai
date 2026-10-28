import { createTsup } from '../../tsup.base';

// 核心入口（index）不依赖 node，浏览器也能用；node 入口额外提供从目录读包。
export default createTsup({ preset: 'node-lib', entry: ['src/index.ts', 'src/node.ts'] });
