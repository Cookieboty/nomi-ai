/**
 * 把两个视图的构建产物复制进 host-electron 的 dist，供未打包的生产模式加载（`electron .`、e2e-headed、
 * 测量脚本）：
 *
 *   packages/renderer/dist → dist/renderer（看板娘窗口；dist/renderer/character 是构建时选定的内置角色包）
 *   packages/ai-chat/dist  → dist/ai-chat（对话窗口，WindowManager 在未打包时从这里加载）
 *
 * `build` 的最后一步就是它（turbo 的 `@nomi-ai/host-electron#build` 依赖两个视图的 build），所以
 * `pnpm build` 之后 dist 就是完整可运行的；单独重建了某个视图后也可以手动跑 `pnpm --filter
 * @nomi-ai/host-electron copy-renderer`。打包时两个视图走 electron-builder 的 extraResources，
 * 这里的副本不进 asar（electron-builder.yml 的 files 排除了它们）。
 */
const fs = require('fs');
const path = require('path');

const VIEWS = [
  { name: '@nomi-ai/renderer', src: '../../../packages/renderer/dist', dest: '../dist/renderer' },
  { name: '@nomi-ai/ai-chat', src: '../../../packages/ai-chat/dist', dest: '../dist/ai-chat' },
];

for (const view of VIEWS) {
  const src = path.join(__dirname, view.src);
  const dest = path.join(__dirname, view.dest);
  if (!fs.existsSync(path.join(src, 'index.html'))) {
    console.error(`错误: ${view.name} 的构建产物不存在 (${src})，先构建它（pnpm build）`);
    process.exit(1);
  }
  // 先删再复制：带 hash 的旧 chunk 不留在副本里
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`已复制 ${view.name} 的构建产物到 ${dest}`);
}
