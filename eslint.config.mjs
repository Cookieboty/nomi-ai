// @ts-check
import { fixupPluginRules } from '@eslint/compat';
import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import-x';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
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
            {
              group: ['**/renderer', './renderer', '../*/renderer', '../shared/renderer'],
              message: '主进程实现不能依赖渲染进程入口。',
            },
          ],
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

  // 遗留 electron 主进程代码（P0 之前既存业务代码，待 P3 迁移时再逐个清理）
  {
    files: ['packages/electron/**/*.{ts,tsx,js,cjs,mjs}'],
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
  // 集中日志：产品源码只能用 createLogger / createMainLogger（生产环境静默 debug / info），
  // console.warn / console.error 仍允许（始终输出）。日志实现文件自行 eslint-disable。
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
);
