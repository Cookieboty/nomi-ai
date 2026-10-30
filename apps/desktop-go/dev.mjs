#!/usr/bin/env node
// Go 版开发态（视图热更新）：pnpm dev:go
//
// 1. 构建视图依赖的工作区包（= turbo dev 的 ^build；改了 contract / ui 等包时另开终端 pnpm dev:libs 监听）；
// 2. 用 Vite 开发服务器跑 packages/renderer（/mascot/）与 packages/ai-chat（/chat/）（视图运行时识别 Go 宿主）；
// 3. 编译并启动 Go 程序，NOMI_DEV_VIEWS 让资产服务器把 /mascot/*、/chat/* 代理到这两个开发服务器
//    （internal/shell/devviews）。WebView 里仍是 wails:// 同源页面，HMR 由 Vite 客户端直连 ws://127.0.0.1:<端口>。
//
// 改视图源码：热更新；改 Go 代码（含内嵌的 locales / json 等）：自动重新编译并重启 Go 程序，视图服务器不动；
// 编译失败时旧进程照常跑，修好再存一次即可。关掉应用（退出）= 结束开发态。
// 参数原样传给 Go 程序；--skip-deps 跳过第 1 步。端口与 Electron 开发态相同（dev-ports.json，可用 CD_*_PORT 覆盖）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, watch, writeFileSync } from 'node:fs';
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
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = path.join(here, 'build/bin', `nomi${exe}`);
const nextBin = path.join(here, 'build/bin', `nomi.next${exe}`);

/** 异步编译（编译期间视图服务器照常响应）；返回是否成功 */
function goBuild(out) {
  console.info(`== go build${tags ? ` -tags ${tags}` : ''}`);
  return new Promise((resolve) => {
    const p = spawn('go', ['build', ...(tags ? ['-tags', tags] : []), '-o', out, '.'], {
      cwd: here,
      stdio: 'inherit',
      env: { ...process.env, ...goEnv },
    });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

if (!(await goBuild(bin))) {
  await Promise.allSettled(servers.map((s) => s.close()));
  process.exit(1);
}

let app = null;
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  watcher?.close();
  if (app && app.exitCode === null) app.kill();
  await Promise.allSettled(servers.map((s) => s.close()));
  process.exit(code);
}

function startApp() {
  const child = spawn(bin, appArgs, {
    cwd: here,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NOMI_DEV_VIEWS: views.map((v) => `${v.name}=http://${DEV_HOST}:${v.port}`).join(','),
    },
  });
  // 用户退出应用 = 结束开发态；重启时换下来的旧进程退出不算
  child.on('exit', (code) => {
    if (child === app) void shutdown(code ?? 0);
  });
  app = child;
}

/** 让旧进程正常退出（SIGTERM → Wails 的 app.Quit，保存窗口位置等）；5 秒没退再强杀 */
function stopApp() {
  const child = app;
  app = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

// 改了 Go 代码：先编译到 nomi.next，成功了才停旧进程、换上新的（单实例锁要求先退旧的）
let building = false;
let again = false;
async function rebuild() {
  if (building) {
    again = true;
    return;
  }
  building = true;
  do {
    again = false;
    console.info('== Go 代码有改动，重新编译');
    if (!(await goBuild(nextBin))) {
      console.warn('== 编译失败，旧版本继续运行');
      continue;
    }
    if (closing) break;
    await stopApp();
    renameSync(nextBin, bin);
    console.info('== 重启 Go 程序');
    startApp();
  } while (again && !closing);
  building = false;
}

// 编译输入：Go 源码（不含测试）、go.mod / go.sum，以及 //go:embed 进程序的文件（locales、json、cjs、png）
const IGNORED_DIRS = /^(build|frontend|packaging|ci|node_modules)([\\/]|$)|[\\/]testdata[\\/]/;
const isInput = (file) =>
  !IGNORED_DIRS.test(file) &&
  (file === 'go.mod' ||
    file === 'go.sum' ||
    (file.endsWith('.go') && !file.endsWith('_test.go')) ||
    (/^internal[\\/]/.test(file) && /\.(json|cjs|png)$/.test(file)));
let timer = null;
const watcher = watch(here, { recursive: true }, (_event, file) => {
  if (!file || !isInput(file)) return;
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 300); // 编辑器一次保存会触发好几次事件
});

startApp();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void shutdown(0));
