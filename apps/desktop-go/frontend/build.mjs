#!/usr/bin/env node
// Go 宿主的视图：与 Electron 同一份构建产物（packages/renderer、packages/ai-chat 的 dist），原样复制后嵌进 Go 程序
// （main.go 的 //go:embed all:frontend/dist）。
//
//   dist/mascot/  ← packages/renderer/dist（看板娘窗口）
//   dist/chat/    ← packages/ai-chat/dist（对话窗口）
//
// 宿主差异不靠构建开关：视图运行时识别 Go 宿主（services/api.ts 读页面地址片段里的 WebSocket 配置），Go 提供页面时
// 改写 CSP、插入 Wails 运行时（internal/shell/viewpage）。灵动岛页由 Go 直接生成（main.go islandPageMiddleware）。
//
// 用法（仓库根先 pnpm install）：node apps/desktop-go/frontend/build.mjs [--skip-build]
//   --skip-build  不跑 turbo build，直接复制两个包现有的 dist
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const dist = path.join(here, 'dist');

if (!process.argv.includes('--skip-build')) {
  // 与 Electron 的 pnpm build 同一个任务（含依赖与 turbo 缓存）
  const argv = [
    path.join(root, 'scripts/run-bin.mjs'),
    'turbo',
    'run',
    'build',
    '--filter=@nomi-ai/renderer',
    '--filter=@nomi-ai/ai-chat',
    '--output-logs=errors-only',
  ];
  console.info(`== turbo build renderer + ai-chat`);
  const r = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync(dist, { recursive: true, force: true });
for (const [pkg, out] of [
  ['renderer', 'mascot'],
  ['ai-chat', 'chat'],
]) {
  const from = path.join(root, 'packages', pkg, 'dist');
  if (!existsSync(path.join(from, 'index.html'))) {
    console.error(`${from} has no index.html: build @nomi-ai/${pkg} first`);
    process.exit(1);
  }
  cpSync(from, path.join(dist, out), { recursive: true });
}

// Wails 的资产服务器以「第一个含 index.html 的目录」为根（assetserver findPathToFile）：根目录没有 index.html 时
// 会把 mascot/ 或 chat/ 当根，/mascot/assets/… 全部 404。这里放一个空页面把根固定在 dist/
writeFileSync(
  path.join(dist, 'index.html'),
  '<!doctype html>\n<meta charset="utf-8" />\n<title>Nomi</title>\n',
);
