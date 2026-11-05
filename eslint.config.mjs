// @ts-check
import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import-x';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { CLI_LITERAL_ALLOWLIST } from './scripts/eslint/cli-literal-allowlist.mjs';
import nomiPlugin from './scripts/eslint/nomi-plugin.mjs';

// 任何包都不 import 角色包目录：角色包只经包解析（CharacterPackService / validatePack）读取（§11.1）。
const CHARACTER_PACK_IMPORT = {
  group: ['**/characters/*', '**/characters/**'],
  message:
    '不能直接 import characters/*：角色包只经包解析读取（docs/design/core-host-decoupling.md §11.1）。',
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

  // 视图不依赖 electron（内核在 Go 版里，视图只经契约访问）
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
              message: '视图不依赖 electron：调用内核只经契约客户端（services/api）。',
            },
          ],
          patterns: [CHARACTER_PACK_IMPORT],
        },
      ],
    },
  },

  // 编程助手的清单与界面信息（@nomi-ai/cli-catalog）：视图也加载，整个包只能是纯数据与纯函数
  {
    files: ['packages/cli-catalog/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'cli-catalog 不能依赖 electron。' }],
          patterns: [
            CHARACTER_PACK_IMPORT,
            {
              group: ['node:*', 'fs', 'path', 'os', 'child_process', 'crypto', 'url'],
              message: 'cli-catalog 只能是纯数据与纯函数，不能依赖 node。',
            },
            {
              group: ['@nomi-ai/*'],
              message: 'cli-catalog 不依赖其它包。',
            },
          ],
        },
      ],
    },
  },
  // 视图不按内置编程助手名字分支（§7.3）：差异放进插件清单，视图按能力位判断。
  {
    files: ['packages/ai-chat/src/**/*.{ts,tsx}'],
    ignores: [...CLI_LITERAL_ALLOWLIST],
    plugins: { nomi: nomiPlugin },
    rules: { 'nomi/no-cli-literal': 'error' },
  },

  // avatar-runtime 是纯浏览器的角色引擎（§3.2、§10.6、§11.1）：经注入的 AvatarEventSource 接 AI，
  // 不依赖契约、electron、AI SDK 客户端或任何视图包（renderer 的 services/api 等）；也不用 ui。
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
  // 测试文件放宽
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // 视图只经契约访问内核（docs/design/core-host-decoupling.md §8、§11.1）：传输只在每个视图包唯一的
  // `services/api.ts` 里选（Go 宿主经页面地址片段里的回环 WebSocket）；旧桥 `window.aiIPC` /
  // `window.electronAPI` 已删除，也不许再声明或访问。
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
            '视图不访问宿主全局：调用内核用 services/api 的 api.*，文件路径用 hostPathForFile（§11.1）。',
        },
        {
          selector: 'Identifier[name=/^(aiIPC|electronAPI)$/]',
          message:
            'window.aiIPC / window.electronAPI 已删除：改用 services/api 的契约客户端（§11.1）。',
        },
        {
          selector:
            'ImportSpecifier[imported.name=/^(getSharedTransport|installSharedTransport|createAppClient|createWebSocketClientTransport|installGoHostTransport)$/]',
          message:
            '契约客户端只在 services/api.ts 里建一次、传输只在那里选，其余代码 import { api } from services/api（§11.1）。',
        },
        {
          selector: "ImportSpecifier[imported.name='ipcRenderer']",
          message: '视图不发原始 IPC：调用内核用 services/api 的 api.*（§11.1）。',
        },
      ],
    },
  },

  // 集中日志：产品源码只能用 createLogger（生产环境静默 debug / info），
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
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**'],
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
