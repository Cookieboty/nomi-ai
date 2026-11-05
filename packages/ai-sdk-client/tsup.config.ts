import { createTsup } from '../../tsup.base';

export default createTsup({
  preset: 'react-lib',
  entry: ['src/index.ts', 'src/react/index.ts', 'src/preload/index.ts'],
  external: ['react', 'react-dom'],
  // preload 需要在 Electron CJS 环境 (`require`) 里被消费，因此双格式输出。
  // react/index 与 ai-sdk-client 主入口仍然可以只走 ESM，因为 renderer 侧用 bundler。
  format: ['esm', 'cjs'],
});
