import { createTsup } from '../../../../tsup.base';

// 三个入口：端口（只依赖 host-ports）、无界面内核（依赖 core）、WebSocket 传输（依赖 ws）；
// 只用端口的调用方不会加载内核或 ws
export default createTsup({
  preset: 'node-lib',
  splitting: true,
  entry: { index: 'src/index.ts', core: 'src/core.ts', websocket: 'src/websocket.ts' },
});
