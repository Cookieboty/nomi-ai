import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { characterPackPlugin } from '../../scripts/character/vite-plugin.mjs';
import { DEV_HOST, PORTS } from '../../scripts/ports.mjs';
// 与主进程响应头使用同一份策略（纯数据模块，构建期引用）
import { appCspString } from '../electron/src/security/csp';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // 引导插画取自当前角色包（CHARACTER_PACK 或 characters/nomi）
    characterPackPlugin({ scope: 'onboarding' }),
    {
      // 生产构建：以 <meta> 注入 CSP。打包后窗口经 file:// 加载，onHeadersReceived
      // 的响应头对 file:// 不生效，必须靠 meta；开发模式（HMR 需内联脚本）不注入。
      name: 'chat-csp',
      apply: 'build',
      transformIndexHtml: {
        order: 'pre',
        handler: (html: string) =>
          html.replace(
            /<meta charset="UTF-8"\s*\/?>/,
            (m) =>
              `${m}\n    <meta http-equiv="Content-Security-Policy" content="${appCspString()}"/>`,
          ),
      },
    },
  ],
  // 相对路径：生产环境由 Electron 通过 file:// 加载，绝对路径 /assets/* 会指向文件系统根目录
  base: './',
  define: {
    'process.env.MODE': JSON.stringify(mode),
    'process.env.ELECTRON_ENV': JSON.stringify(!!process.env.ELECTRON_ENV),
    'process.env.API_BASE_URL':
      mode === 'development'
        ? JSON.stringify(`http://${DEV_HOST}:${PORTS.renderer}`)
        : '"https://api.example.com"',
  },
  // @nomi-ai/types 只产出 CommonJS（主进程要 require），workspace 链接的包默认不预构建：
  // dev 下浏览器按 ESM 直接加载 dist/index.js 拿不到任何具名导出，整页白屏。
  optimizeDeps: {
    include: ['@nomi-ai/types'],
  },
  server: {
    host: DEV_HOST,
    port: PORTS.chat,
    strictPort: true,
    cors: true,
  },
  build: {
    // AudioWorklet 等 .js 资源不能内联成 data: URL（CSP 只允许 'self' 脚本）
    assetsInlineLimit: (file: string) => (file.endsWith('.js') ? false : undefined),
    outDir: 'dist',
    sourcemap: mode === 'development',
    rollupOptions: {
      input: 'index.html',
    },
  },
}));
