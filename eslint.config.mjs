// @ts-check
import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import-x';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { CLI_LITERAL_ALLOWLIST } from './scripts/eslint/cli-literal-allowlist.mjs';
import {
  ELECTRON_DYNAMIC_ALLOWLIST,
  ELECTRON_FREE_PACKAGES,
  ELECTRON_HOST_FILES,
  ELECTRON_IMPORT_ALLOWLIST,
} from './scripts/eslint/electron-boundary.mjs';
import nomiPlugin from './scripts/eslint/nomi-plugin.mjs';

// 任何包都不 import 角色包目录：角色包只经包解析（CharacterPackService / validatePack）读取（§11.1）。
const CHARACTER_PACK_IMPORT = {
  group: ['**/characters/*', '**/characters/**'],
  message:
    '不能直接 import characters/*：角色包只经包解析读取（docs/design/core-host-decoupling.md §11.1）。',
};

// 宿主包（host-electron、host-node 以及以后的 host-*）不 import 视图包（§3.2）：
// 视图只以构建产物被宿主加载；宿主可用的视图侧代码只有契约客户端的传输适配（ai-sdk-client/preload）。
const HOST_VIEW_IMPORT = {
  group: [
    '@nomi-ai/ai-chat',
    '@nomi-ai/ai-chat/*',
    '@nomi-ai/renderer',
    '@nomi-ai/renderer/*',
    '@nomi-ai/ui',
    '@nomi-ai/ui/*',
    '@nomi-ai/voice',
    '@nomi-ai/voice/*',
    '@nomi-ai/avatar-runtime',
    '@nomi-ai/avatar-runtime/*',
    '**/ai-chat/src/**',
    '**/renderer/src/**',
    '**/ui/src/**',
    '**/voice/src/**',
    '**/avatar-runtime/src/**',
  ],
  message:
    '宿主不能依赖视图包：视图只以构建产物被宿主加载（docs/design/core-host-decoupling.md §3.2）。',
};

// 视图只能用 cli-plugins 的纯数据目录：其余子路径（main、<cli>/main 等）含 Node 实现（§3.2）
const VIEW_CLI_PLUGINS_IMPORT = {
  regex: '^@nomi-ai/cli-plugins(?!/catalog$)(?:/.*)?$',
  message: '视图只能 import @nomi-ai/cli-plugins/catalog（纯数据）；其余入口含 Node 实现（§3.2）。',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-cjs/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.min.js',
      'packages/renderer/public/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 },
    },
    // eslint-plugin-import-x（eslint-plugin-import 不支持 ESLint 10）；沿用 `import/` 规则前缀
    plugins: { import: importPlugin },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // React / DOM 相关子包
  {
    files: [
      'packages/renderer/**/*.{ts,tsx}',
      'packages/ai-chat/**/*.{ts,tsx}',
      'packages/ai-sdk-client/**/*.{ts,tsx}',
      'packages/avatar-runtime/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // eslint-plugin-react 7.x 仍调用 ESLint 10 已移除的 context API（getFilename 等），用 compat 垫片包装
    plugins: { react: fixupPluginRules(reactPlugin), 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // react-hooks 7 新增的 React Compiler 规则：遗留组件大量命中，先以 warn 呈现、逐步治理
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.recommended.rules)
          .filter((r) => !['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps'].includes(r))
          .map((r) => [r, 'warn']),
      ),
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
    },
  },

  // Renderer / 渲染进程禁止直接引 electron
  {
    files: [
      'packages/renderer/**/*.{ts,tsx}',
      'packages/ai-chat/**/*.{ts,tsx}',
      'packages/ai-sdk-client/**/*.{ts,tsx}',
      'packages/ui/**/*.{ts,tsx}',
      'packages/voice/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: '渲染进程禁止直接引入 electron，请通过 preload / IPC / ai-sdk-client。',
            },
          ],
          patterns: [
            {
              group: [
                '@nomi-ai/core',
                '@nomi-ai/core/*',
                '@nomi-ai/host-*',
                '@nomi-ai/host-*/*',
                '**/core/src/**',
                '**/host-*/src/**',
              ],
              message: '视图不能依赖内核与宿主：只经契约客户端（services/api）访问（§11.1）。',
            },
            VIEW_CLI_PLUGINS_IMPORT,
            CHARACTER_PACK_IMPORT,
          ],
        },
      ],
    },
  },

  // 编程助手插件的入口边界（docs/design/cli-plugin-architecture.md §5.1）：
  // manifest / gateway / renderer 是纯数据，渲染进程与网关进程也会加载，不能依赖 node 与主进程实现；
  // main 是主进程实现，不能依赖渲染进程入口。整个插件包都不能 import electron。
  {
    files: ['packages/cli-plugins/src/**/*.ts'],
    ignores: [
      'packages/cli-plugins/src/*/main.ts',
      'packages/cli-plugins/src/main.ts',
      'packages/cli-plugins/src/shared/homes.ts',
      'packages/cli-plugins/src/shared/scan.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: '插件包不能依赖 electron。' }],
          patterns: [
            CHARACTER_PACK_IMPORT,
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process', 'crypto', 'url'],
              message: 'manifest / gateway / renderer 入口只能是纯数据，不能依赖 node。',
            },
            {
              group: ['**/main', './main', '../*/main', '../shared/homes', '../shared/scan'],
              message: 'manifest / gateway / renderer 入口不能依赖主进程实现。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/cli-plugins/src/*/main.ts', 'packages/cli-plugins/src/main.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: '插件包不能依赖 electron。' }],
          patterns: [
            CHARACTER_PACK_IMPORT,
            {
              group: ['**/renderer', './renderer', '../*/renderer', '../shared/renderer'],
              message: '主进程实现不能依赖渲染进程入口。',
            },
          ],
        },
      ],
    },
  },

  // 核心目录不按内置编程助手名字分支（§7.3）：差异放进插件，核心按能力位判断。
  // core/src/cli 是插件宿主与内置 CLI 的适配层（编排、驱动接线），不在此列。
  {
    files: [
      'packages/core/src/**/*.ts',
      'packages/host-electron/src/**/*.ts',
      'packages/ai-chat/src/**/*.{ts,tsx}',
    ],
    ignores: ['packages/core/src/cli/**', ...CLI_LITERAL_ALLOWLIST],
    plugins: { nomi: nomiPlugin },
    rules: { 'nomi/no-cli-literal': 'error' },
  },

  // Electron 边界（docs/design/core-host-decoupling.md §7.2、§11.1、§12 P0）：
  // packages/host-electron/src 里只有宿主区域能 import electron；P0 时已有的业务模块列在
  // scripts/eslint/electron-boundary.mjs 的白名单里（shrink only, see docs/design/core-host-decoupling.md §12）。
  // 所有宿主包的兜底规则；下面针对具体宿主的规则覆盖 no-restricted-imports 时都带上 HOST_VIEW_IMPORT
  {
    files: ['packages/host-*/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [CHARACTER_PACK_IMPORT, HOST_VIEW_IMPORT] }],
    },
  },
  {
    files: ['packages/host-electron/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    ignores: [...ELECTRON_HOST_FILES, ...ELECTRON_IMPORT_ALLOWLIST],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '业务模块不能直接依赖 electron：平台能力走宿主端口，窗口广播走事件（docs/design/core-host-decoupling.md §6）；宿主代码放 src/host/。',
            },
          ],
          patterns: [CHARACTER_PACK_IMPORT, HOST_VIEW_IMPORT],
        },
      ],
    },
  },
  // 内核 / 契约 / 端口 / 角色契约等包整个都不能依赖 electron（§3.2、§11.1）
  ...ELECTRON_FREE_PACKAGES.map((p) => ({
    files: [`packages/${p}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '这个包不能依赖 electron（docs/design/core-host-decoupling.md §3.2、§11.1）。',
            },
          ],
          patterns: [CHARACTER_PACK_IMPORT, ...(p.startsWith('host-') ? [HOST_VIEW_IMPORT] : [])],
        },
      ],
    },
  })),
  // 内核（@nomi-ai/core）的依赖方向（docs/design/core-host-decoupling.md §3.2、§11.1）：不依赖 electron
  // （包括 electron-updater 这类只能在 Electron 里跑的包），也不依赖宿主包、视图包与 ui。
  // 宿主能力经 @nomi-ai/host-ports 的端口注入，视图只经契约访问内核。
  {
    files: ['packages/core/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '内核不能依赖 electron：平台能力走宿主端口（docs/design/core-host-decoupling.md §3.2、§6）。',
            },
          ],
          patterns: [
            CHARACTER_PACK_IMPORT,
            {
              group: ['electron/*', 'electron-*', '@electron/*'],
              message:
                '内核不能依赖 Electron 专用的包：由宿主实现后注入（docs/design/core-host-decoupling.md §3.2）。',
            },
            {
              group: [
                '@nomi-ai/host-electron',
                '@nomi-ai/host-electron/*',
                '@nomi-ai/bundle-ig-electron-caps',
                '@nomi-ai/bundle-ig-electron-caps/*',
                '**/host-electron/src/**',
              ],
              message: '内核不能依赖宿主包：宿主能力经 @nomi-ai/host-ports 的端口注入（§3.2）。',
            },
            {
              group: [
                '@nomi-ai/ui',
                '@nomi-ai/ui/*',
                '@nomi-ai/ai-chat',
                '@nomi-ai/ai-chat/*',
                '@nomi-ai/renderer',
                '@nomi-ai/renderer/*',
                '@nomi-ai/ai-sdk-client',
                '@nomi-ai/ai-sdk-client/*',
                '@nomi-ai/voice',
                '@nomi-ai/voice/*',
                '@nomi-ai/avatar-runtime',
                '@nomi-ai/avatar-runtime/*',
              ],
              message: '内核不能依赖视图包与 ui：视图只经契约访问内核（§3.2）。',
            },
          ],
        },
      ],
    },
  },
  // avatar-runtime 是纯浏览器的角色引擎（§3.2、§10.6、§11.1）：经注入的 AvatarEventSource 接 AI，
  // 不依赖契约、electron、AI SDK 客户端或任何视图包（renderer 的 services/api 等）；也不用 ui。
  // 这条放在 ELECTRON_FREE_PACKAGES 之后，覆盖那里的 no-restricted-imports（electron 也在下面）。
  {
    files: ['packages/avatar-runtime/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: 'avatar-runtime 不能依赖 electron（§3.2、§11.1）。' },
          ],
          patterns: [
            CHARACTER_PACK_IMPORT,
            {
              group: [
                '@nomi-ai/contract',
                '@nomi-ai/contract/*',
                '@nomi-ai/ai-sdk',
                '@nomi-ai/ai-sdk/*',
                '@nomi-ai/ai-sdk-client',
                '@nomi-ai/ai-sdk-client/*',
                '@nomi-ai/host-*',
                '@nomi-ai/core',
                '@nomi-ai/core/*',
                '@nomi-ai/renderer',
                '@nomi-ai/renderer/*',
                '@nomi-ai/ai-chat',
                '@nomi-ai/ai-chat/*',
                '@nomi-ai/ui',
                '@nomi-ai/ui/*',
                '**/services/api',
                '**/renderer/src/**',
              ],
              message:
                'avatar-runtime 只依赖 character-contract 与浏览器 API：AI 与宿主能力经注入的 AvatarEventSource / AvatarWindowHost / 回调接入（§10.6）。',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(aiIPC|electronAPI|nomiTransport|nomiHost|nomiDevTransport)$/], MemberExpression[computed=true][property.value=/^(aiIPC|electronAPI|nomiTransport|nomiHost|nomiDevTransport)$/]',
          message: 'avatar-runtime 不访问宿主全局：宿主能力经注入的接口传进来（§10.6）。',
        },
      ],
    },
  },
  // 动态加载 electron（require / nodeRequire()(…) / createRequire(…)(…) / import()）绕过了静态 import 检查：
  // 宿主区域之外一律禁止；既有用法在 ELECTRON_DYNAMIC_ALLOWLIST（shrink only）。
  {
    files: [
      'packages/*/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}',
      ...ELECTRON_FREE_PACKAGES.map((p) => `packages/${p}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`),
    ],
    ignores: [
      ...ELECTRON_HOST_FILES,
      ...ELECTRON_DYNAMIC_ALLOWLIST,
      '**/*.{test,spec}.{ts,tsx}',
      '**/tests/**',
      '**/__tests__/**',
    ],
    plugins: { nomi: nomiPlugin },
    rules: { 'nomi/no-dynamic-electron': 'error' },
  },

  // 测试文件放宽
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // 遗留 electron 主进程代码（P0 之前既存业务代码，P3 搬进 packages/core 后沿用同样的放宽，再逐个清理）
  {
    files: [
      'packages/host-electron/**/*.{ts,tsx,js,cjs,mjs}',
      'packages/core/**/*.{ts,tsx,js,cjs,mjs}',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'warn',
      'no-case-declarations': 'warn',
      'no-async-promise-executor': 'warn',
      'no-control-regex': 'warn',
      'prefer-const': 'warn',
      'no-var': 'warn',
      'no-console': 'off',
    },
  },

  // examples 里的 electron 主进程 / preload 需要 CJS require
  {
    files: ['examples/**/electron/**/*.{cjs,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },

  // e2e-headed · Playwright electron harness（主进程 + preload 走 CJS，需要 require + console 调试）
  {
    files: ['e2e-headed/harness/**/*.{cjs,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
      'import/order': 'off',
    },
  },

  // e2e-headed · Playwright fixture / spec（官方 `async ({}, use)` 空解构签名 + trace 调试 console）
  {
    files: ['e2e-headed/**/*.{ts,tsx}'],
    rules: {
      'no-empty-pattern': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  // 视图只经契约访问内核（docs/design/core-host-decoupling.md §8、§11.1）：preload 只暴露
  // `window.nomiTransport`（契约传输）与 `window.nomiHost`（拖入文件路径），开发服务器（pnpm dev:web）注入
  // `window.nomiDevTransport`（WebSocket 传输的地址与 token），三者都只能在每个视图包唯一的 `services/api.ts`
  // 里读，传输也只在那里选；旧桥 `window.aiIPC` / `window.electronAPI` 已删除，也不许再声明或访问。
  {
    files: [
      'packages/ai-chat/src/**/*.{ts,tsx}',
      'packages/renderer/src/**/*.{ts,tsx}',
      'packages/ui/src/**/*.{ts,tsx}',
      'packages/voice/src/**/*.{ts,tsx}',
    ],
    ignores: ['**/src/services/api.ts', '**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(aiIPC|electronAPI|nomiTransport|nomiHost|nomiDevTransport)$/], MemberExpression[computed=true][property.value=/^(aiIPC|electronAPI|nomiTransport|nomiHost|nomiDevTransport)$/]',
          message:
            '视图不直接访问 preload 全局：调用内核用 services/api 的 api.*，文件路径用 hostPathForFile（§11.1）。',
        },
        {
          selector: 'Identifier[name=/^(aiIPC|electronAPI)$/]',
          message:
            'window.aiIPC / window.electronAPI 已删除：改用 services/api 的契约客户端（§11.1）。',
        },
        {
          selector:
            'ImportSpecifier[imported.name=/^(NOMI_TRANSPORT_GLOBAL|NOMI_HOST_GLOBAL|NOMI_DEV_TRANSPORT_GLOBAL|getGlobalBridge|getSharedTransport|installSharedTransport|lazyGlobalTransport|createAppClient|createWebSocketClientTransport|createIpcClientTransport)$/]',
          message:
            '契约客户端只在 services/api.ts 里建一次，其余代码 import { api } from services/api（§11.1）。',
        },
        {
          selector: "ImportSpecifier[imported.name='ipcRenderer']",
          message: '视图不发原始 IPC：调用内核用 services/api 的 api.*（§11.1）。',
        },
      ],
    },
  },

  // 主进程只经契约传输（host/contractIpc.ts）接收视图的调用：宿主目录之外不注册 ipcMain 通道（§11.1）。
  {
    files: ['packages/host-electron/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    ignores: ['packages/host-electron/src/host/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportSpecifier[imported.name='ipcMain'], MemberExpression[property.name='ipcMain']",
          message:
            '不注册 ipcMain 通道：视图的调用经契约（contract/src/app/<域>.ts + host/contract/<域>.ts），推送经 events.publish（§11.1）。',
        },
      ],
    },
  },

  // 集中日志：产品源码只能用 createLogger / createMainLogger（生产环境静默 debug / info），
  // console.warn / console.error 仍允许（始终输出）。日志实现文件自行 eslint-disable。
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // 不用系统弹窗：macOS / Windows 样式不一、按钮跟系统语言走。
  // 确认 / 输入用 ai-chat 的 confirmDialog / promptDialog（components/ConfirmDialog）。
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: [
      '**/*.{test,spec}.{ts,tsx}',
      '**/tests/**',
      'packages/host-electron/**',
      'packages/core/**',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['alert', 'confirm', 'prompt'].map((name) => ({
          name,
          message:
            '不用系统弹窗：确认 / 输入用 confirmDialog / promptDialog（ai-chat/components/ConfirmDialog）',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['alert', 'confirm', 'prompt'].map((property) => ({
          object: 'window',
          property,
          message:
            '不用系统弹窗：确认 / 输入用 confirmDialog / promptDialog（ai-chat/components/ConfirmDialog）',
        })),
      ],
    },
  },
);
