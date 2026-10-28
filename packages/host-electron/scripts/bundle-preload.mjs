// 将 preload 脚本打包为单文件。
//
// Electron >= 20 默认对渲染进程启用 sandbox，sandbox 下的 preload 只能 require
// `electron` 及少量内建模块，无法加载 `@nomi-ai/ai-sdk-client/preload` 这类 workspace 包。
// tsc 输出的 dist/preload.js 会因此抛出 "module not found"，导致 window.nomiTransport /
// window.nomiHost 均不可用。这里用 tsup(esbuild) 把依赖内联进去，仅保留 `electron` 为外部依赖，
// 输出为 dist/*.bundle.js（WindowManager 加载的就是这些文件）。使用独立文件名，
// 避免与 `tsc -w` 的输出互相覆盖。
//
// 用法：node scripts/bundle-preload.mjs [--watch]
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'tsup';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

await build({
  entry: {
    'preload.bundle': path.join(root, 'src/preload.ts'),
    'ai-chat-preload.bundle': path.join(root, 'src/ai-chat-preload.ts'),
  },
  outDir: path.join(root, 'dist'),
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  bundle: true,
  // 强制内联所有依赖（包括 workspace 包），仅 electron 由运行时提供
  noExternal: [/^(?!electron$).*/],
  external: ['electron'],
  outExtension: () => ({ js: '.js' }),
  clean: false,
  dts: false,
  sourcemap: false,
  splitting: false,
  shims: false,
  config: false,
  tsconfig: path.join(root, 'tsconfig.json'),
  watch: watch ? [path.join(root, 'src')] : false,
});
