import { defineConfig } from 'vite';
import { characterPackPlugin } from '../../scripts/character/vite-plugin.mjs';
import { devTransportPlugin } from '../../scripts/dev-web/vite-plugin.mjs';
import { DEV_HOST, PORTS } from '../../scripts/ports.mjs';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

import { mascotCspString } from './src/security/csp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  // 插件配置
  plugins: [
    react(),
    // 当前角色包（CHARACTER_PACK 或 characters/nomi）：开发态直接读包，构建时输出到 dist/character
    characterPackPlugin({ scope: 'all' }),
    // pnpm dev:web：把开发态内核的 WebSocket 地址注入页面；生产构建里不允许出现这条传输
    ...devTransportPlugin(),
    {
      // 生产构建：给看板娘窗口注入 CSP（开发模式 HMR 需要内联脚本，不注入）
      name: 'mascot-csp',
      apply: 'build',
      transformIndexHtml: {
        order: 'pre',
        handler(html: string, ctx: { filename: string }) {
          // 看板娘页面经 file:// 加载，需要 meta CSP
          if (!/\.html$/.test(ctx.filename)) return html;
          const anchor = /<meta charset="UTF-8"\s*\/?>/i;
          // 找不到锚点时宁可构建失败，也不能静默产出没有 CSP 的页面
          if (!anchor.test(html))
            throw new Error(`mascot-csp: no <meta charset> in ${ctx.filename}`);
          return html.replace(
            anchor,
            `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${mascotCspString()}" />`,
          );
        },
      },
    },
  ],

  // 基础公共路径
  base: './',

  // @nomi-ai/types 只产出 CommonJS（主进程要 require），workspace 链接的包默认不预构建：
  // dev 下浏览器按 ESM 直接加载 dist/index.js 拿不到具名导出（brand 等），整页白屏（与 ai-chat 相同）
  optimizeDeps: {
    include: ['@nomi-ai/types'],
  },

  // 开发服务器配置
  server: {
    host: DEV_HOST,
    port: PORTS.renderer,
    strictPort: true,
    open: false,
  },

  // 构建配置
  build: {
    // AudioWorklet 等 .js 资源不能内联成 data: URL（CSP 只允许 'self' 脚本）
    assetsInlineLimit: (file: string) => (file.endsWith('.js') ? false : undefined),
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    minify: 'terser',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      output: {
        // 稳定的 vendor 拆分：react 常驻
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          return undefined;
        },
      },
    },
  },

  // CSS配置
  css: {
    modules: {
      // CSS Modules配置
      localsConvention: 'camelCase',
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
  },

  // 解析配置
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
  },
});
