import { createRequire } from 'node:module';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { characterPackPlugin } from '../../scripts/character/vite-plugin.mjs';
import { DEV_HOST, PORTS } from '../../scripts/ports.mjs';
import { appCspString } from './src/security/csp';
import packageJson from './package.json' with { type: 'json' };

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    // 引导插画取自当前角色包（CHARACTER_PACK 或 characters/nomi）
    characterPackPlugin({ scope: 'onboarding' }),
    {
      // 生产构建：以 <meta> 注入 CSP（Go 宿主提供页面时再改写，internal/shell/viewpage）；
      // 开发模式（HMR 需内联脚本）不注入。
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
  // 相对路径：Go 宿主以内嵌资源路径加载视图，浏览器预览也复用相对资源地址
  base: './',
  define: {
    'process.env.MODE': JSON.stringify(mode),
    'process.env.API_BASE_URL':
      mode === 'development'
        ? JSON.stringify(`http://${DEV_HOST}:${PORTS.renderer}`)
        : '"https://api.example.com"',
  },
  // @nomi-ai/types 只产出 CommonJS（主进程要 require），workspace 链接的包默认不预构建：
  // dev 下浏览器按 ESM 直接加载 dist/index.js 拿不到任何具名导出，整页白屏。
  resolve: {
    // micromark's browser entity decoder uses document.createElement. Use its
    // own DOM-free entry in both the page and worker, including optimized deps.
    alias: {
      'decode-named-character-reference': createRequire(import.meta.url).resolve(
        'decode-named-character-reference',
      ),
    },
    // CodeMirror extensions use instanceof: every grammar must share these instances.
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@lezer/common',
      '@lezer/lr',
      '@lezer/highlight',
    ],
  },
  optimizeDeps: {
    // Prebundle the lazy preview's entire grammar graph together. Discovering grammars
    // after opening a file otherwise replaces shared chunks while old editors still run.
    include: [
      '@nomi-ai/types',
      ...Object.keys(packageJson.dependencies).filter(
        (name) =>
          (name.startsWith('@codemirror/') && name !== '@codemirror/legacy-modes') ||
          name.startsWith('codemirror-lang-') ||
          name === '@lezer/highlight',
      ),
      ...[
        'clike',
        'clojure',
        'cmake',
        'commonlisp',
        'diff',
        'dockerfile',
        'erlang',
        'haskell',
        'lua',
        'mllike',
        'perl',
        'powershell',
        'properties',
        'protobuf',
        'r',
        'ruby',
        'shell',
        'sql',
        'stex',
        'swift',
        'toml',
      ].map((mode) => `@codemirror/legacy-modes/mode/${mode}`),
    ],
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
