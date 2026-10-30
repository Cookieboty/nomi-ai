#!/usr/bin/env node
// Go 版开发态（视图热更新）：pnpm dev:go
//
// 1. 构建视图依赖的工作区包（= turbo dev 的 ^build；改了 contract / ui 等包时另开终端 pnpm dev:libs 监听）；
// 2. 用 Vite 开发服务器跑 packages/renderer（/mascot/）与 packages/ai-chat（/chat/）（视图运行时识别 Go 宿主）；
// 3. 编译并启动 Go 程序，NOMI_DEV_VIEWS 让资产服务器把 /mascot/*、/chat/* 代理到这两个开发服务器
//    （internal/shell/devviews）。WebView 里仍是 wails:// 同源页面，HMR 由 Vite 客户端直连 ws://127.0.0.1:<端口>。
//
// 改视图源码：热更新；改 Go 代码：Ctrl+C 后重新运行（视图服务器重启很快）。
// 参数原样传给 Go 程序；--skip-deps 跳过第 1 步。端口与 Electron 开发态相同（dev-ports.json，可用 CD_*_PORT 覆盖）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const args = process.argv.slice(2);
const skipDeps = args.includes('--skip-deps');
const appArgs = args.filter((a) => a !== '--skip-deps');
const { DEV_HOST, PORTS } = await import(pathToFileURL(path.join(root, 'scripts/ports.mjs')).href);
const runBin = path.join(root, 'scripts/run-bin.mjs');

function runSync(cmd, argv, opts = {}) {
  console.info(`== ${[cmd, ...argv].join(' ')}`);
  const r = spawnSync(cmd, argv, {
    stdio: 'inherit',
    ...opts,
    env: { ...process.env, ...opts.env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!skipDeps) {
  runSync(
    process.execPath,
    [
      runBin,
      'turbo',
      'run',
      'build',
      '--filter=@nomi-ai/renderer^...',
      '--filter=@nomi-ai/ai-chat^...',
      '--output-logs=errors-only',
    ],
    { cwd: root },
  );
}

// main.go 的 //go:embed all:frontend/dist 要求目录存在；开发态页面走代理，这里只放占位页
const dist = path.join(here, 'frontend/dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html>\n<meta charset="utf-8" />\n');
}

// 视图开发服务器：用各包自己的 vite 配置，只覆盖 base 与 HMR 地址（页面在 wails:// 源下，HMR 不能连页面所在的主机）
const views = [
  { pkg: 'renderer', name: 'mascot', port: PORTS.renderer },
  { pkg: 'ai-chat', name: 'chat', port: PORTS.chat },
];
const servers = [];
for (const v of views) {
  const pkgDir = path.join(root, 'packages', v.pkg);
  const configFile = ['vite.config.mts', 'vite.config.ts']
    .map((f) => path.join(pkgDir, f))
    .find(existsSync);
  const server = await createServer({
    configFile,
    root: pkgDir,
    base: `/${v.name}/`,
    server: {
      host: DEV_HOST,
      port: v.port,
      strictPort: true,
      ws: { protocol: 'ws', host: DEV_HOST, clientPort: v.port },
    },
  });
  await server.listen();
  servers.push(server);
  console.info(`== ${v.pkg} → http://${DEV_HOST}:${v.port}/${v.name}/`);
}

// Go 程序（与 run-dev.sh 相同的平台标签）
const tags = { darwin: 'private_mac_apis', linux: 'gtk3' }[process.platform];
const goEnv = { CGO_ENABLED: '1' };
if (process.platform === 'darwin') {
  Object.assign(goEnv, {
    MACOSX_DEPLOYMENT_TARGET: '11.0',
    CGO_CFLAGS: '-mmacosx-version-min=11.0',
    CGO_LDFLAGS: '-mmacosx-version-min=11.0',
  });
}
const bin = path.join(here, 'build/bin', process.platform === 'win32' ? 'nomi.exe' : 'nomi');
runSync('go', ['build', ...(tags ? ['-tags', tags] : []), '-o', bin, '.'], {
  cwd: here,
  env: goEnv,
});

const app = spawn(bin, appArgs, {
  cwd: here,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    NOMI_DEV_VIEWS: views.map((v) => `${v.name}=http://${DEV_HOST}:${v.port}`).join(','),
  },
});

let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  if (app.exitCode === null) app.kill();
  await Promise.allSettled(servers.map((s) => s.close()));
  process.exit(code);
}
app.on('exit', (code) => void shutdown(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void shutdown(0));
