import { defineConfig } from 'vite';
import { DEV_HOST, PORTS } from '../../scripts/ports.mjs';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

import { mascotCspString } from './src/security/csp';
import { tsdSourceVitePlugin } from '../../scripts/react-tsd-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // 插件配置
  plugins: [
    ...(mode === 'development' ? [tsdSourceVitePlugin()] : []),
    react(),
    {
      // 生产构建：给看板娘窗口注入 CSP（开发模式 HMR 需要内联脚本，不注入）
      name: 'mascot-csp',
      apply: 'build',
      transformIndexHtml: {
        order: 'pre',
        handler(html: string, ctx: { filename: string }) {
          // index.html（看板娘）与 tts-config.html 都经 file:// 加载，都需要 meta CSP
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
      // 多页面：看板娘主窗口 + TTS 配置窗口（共享 @nomi-ai/ui 样式）
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'tts-config': path.resolve(__dirname, 'tts-config.html'),
      },
      output: {
        // 稳定的 vendor 拆分：react 常驻；three/VRM 仅 3D 模式懒加载时请求
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (
            /[\\/](three|@pixiv|@react-three|three-stdlib|troika-[^\\/]+|maath|camera-controls)[\\/]/.test(
              id,
            )
          )
            return 'vendor-three';
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
}));