import { defineConfig } from 'tsup';

/**
 * bundle-ig-mascot 主入口是 React/渲染进程代码（ESM only），
 * 但 `./seams` 只导出 Service Key / 类型 / 契约，是纯 Node/浏览器双兼容代码，
 * 且被 `@nomi-ai/ai-sdk` 的 CJS build 作为**运行时值**引用（AvatarKey 需要注入）。
 *
 * 因此拆两条 tsup 流水线：
 * 1) 主入口 `src/index.ts` → 浏览器 ESM
 * 2) `src/seams/index.ts`  → node，ESM + CJS 双格式
 *
 * 两条流水线并行执行，`clean: true` 会在主入口的 DTS 阶段删掉 seams 的 .d.ts（竞态），
 * 所以这里都不 clean，改由 build 脚本先 `rimraf dist`。
 */
const externals = ['@nomi-ai/bundle-ig-base', '@nomi-ai/bundle-ig-electron-caps'];

// tsup DTS 子编译会注入已弃用的 baseUrl（TypeScript 6），见 tsup.base.ts
const dts = { compilerOptions: { ignoreDeprecations: '6.0' } };

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    platform: 'browser',
    dts,
    splitting: false,
    clean: false,
    sourcemap: true,
    target: 'es2022',
    treeshake: true,
    external: [...externals, 'react', 'react-dom'],
  },
  {
    // 主进程（Electron main / ai-runtime）装载的插件：不含渲染进程守卫
    entry: { 'seams/index': 'src/seams/index.ts', 'plugins/index': 'src/plugins/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    dts,
    splitting: false,
    clean: false,
    sourcemap: true,
    target: 'es2022',
    treeshake: true,
    external: externals,
  },
]);
