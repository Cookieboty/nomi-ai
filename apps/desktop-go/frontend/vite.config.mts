/**
 * POC 前端：不进 pnpm workspace，直接按源码引用仓库里的 avatar-runtime / character-contract / contract，
 * 第三方依赖从仓库根 node_modules 解析（先在仓库根 `pnpm install`）。
 *   ../../../node_modules/.bin/vite build --config vite.config.mts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @ts-expect-error -- plain .mjs
import { characterPackPlugin } from '../../../scripts/character/vite-plugin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const pkg = (p: string) => path.join(repo, 'packages', p);

export default defineConfig({
  root: here,
  base: './',
  // 看板娘按设置 mascot.renderer 运行时切换：Rive 版在独立 chunk 里，只有 rive 时才动态加载
  plugins: [react(), characterPackPlugin({ scope: 'all', packDir: path.join(repo, 'characters/nomi') })],
  server: { fs: { allow: [repo] } },
  resolve: {
    alias: [
      { find: /^@nomi-ai\/avatar-runtime$/, replacement: pkg('avatar-runtime/src/index.ts') },
      { find: /^@nomi-ai\/character-contract$/, replacement: pkg('character-contract/src/index.ts') },
      { find: /^@nomi-ai\/contract\/app$/, replacement: pkg('contract/src/app/index.ts') },
      // 看板娘窗口只用传输层（不带整份 appContract 的 zod schema），省掉约 170 KB 常驻 JS
      { find: /^@nomi-ai\/contract\/websocket$/, replacement: pkg('contract/src/websocket.ts') },
      { find: /^@nomi-ai\/contract$/, replacement: pkg('contract/src/index.ts') },
    ],
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: { index: path.join(here, 'index.html'), mascot: path.join(here, 'mascot.html'), chat: path.join(here, 'chat.html'), island: path.join(here, 'island.html') } },
  },
});
