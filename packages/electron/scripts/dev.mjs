// Electron 开发模式：
//   1. 先编译一次主进程（tsc）并打包 preload —— 保证 dist/main.js 存在再启动 Electron
//   2. 之后 tsc -w / preload --watch 增量编译
//   3. 等渲染进程（:6127）与对话窗口（:6128）（见 dev-ports.json）的 Vite 开发服务器就绪，再以 NODE_ENV=development 启动 Electron
// 由根目录 `pnpm dev`（turbo）与渲染进程 / 对话窗口的 dev 任务并行启动。
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_HOST, PORTS as DEV_PORTS, portEnv } from '../../../scripts/ports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');
const node = process.execPath;
const PORTS = [
  { port: DEV_PORTS.renderer, what: 'renderer (packages/renderer)' },
  { port: DEV_PORTS.chat, what: 'chat window (packages/ai-chat)' },
];

const log = (m) => console.log(`[electron:dev] ${m}`);
const run = (args, label) => {
  const r = spawnSync(node, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[electron:dev] ${label} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
};

// 兜底：离线 TTS 模型缺失 / 不完整时先补齐（已完整毫秒级跳过；失败只报错不阻塞 dev，运行时仍会后台下载 + 系统语音回退）。
// CI / 不想下载：NOMI_SKIP_TTS_MODEL=1
spawnSync(node, [path.join(root, 'scripts/ensure-tts-model.mjs')], { cwd: root, stdio: 'inherit' });

log('compiling main process…');
run([tsc, '-p', 'tsconfig.json'], 'tsc');
run([path.join(root, 'scripts/bundle-preload.mjs')], 'preload bundle');

const children = [];
const start = (cmd, args, env) => {
  const c = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...portEnv(), ...env },
  });
  children.push(c);
  return c;
};
start(node, [tsc, '-w', '-p', 'tsconfig.json', '--preserveWatchOutput']);
start(node, [path.join(root, 'scripts/bundle-preload.mjs'), '--watch']);

// Vite 监听 `localhost`，在 Node >= 17 / macOS 上可能只绑定 ::1，所以 IPv4 与 IPv6 都要探测
const probe = (port, host) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
const portOpen = async (port) => (await probe(port, DEV_HOST)) || (await probe(port, '::1'));
for (const { port, what } of PORTS) {
  const t0 = Date.now();
  while (!(await portOpen(port))) {
    if (Date.now() - t0 > 120_000) {
      console.error(
        `[electron:dev] ${what} dev server is not listening on :${port} after 120 s.\n` +
          '  Run the whole stack with `pnpm dev` from the repo root (it starts all three), or check that the port is free.',
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`${what} ready on :${port}`);
}

const electron = require('electron'); // 首次运行会自动下载对应平台的 Electron 二进制
log(`starting Electron (${electron})`);
// 额外的 Electron/Chromium 参数（例如 CI / xvfb 下的 --enable-unsafe-swiftshader、--user-data-dir=...）
const extra = (process.env.ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean);
// Codex's Windows AppContainer cannot traverse arbitrary host paths, so Electron's
// Chromium sandbox exits before the dev window is created. Keep this dev-only
// fallback scoped to that environment; normal local development remains sandboxed.
if (process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY && !extra.includes('--no-sandbox')) {
  extra.unshift('--no-sandbox');
}
const app = start(electron, ['.', ...extra], { NODE_ENV: 'development' });
const stop = (code) => {
  for (const c of children) if (!c.killed) c.kill();
  process.exit(code ?? 0);
};
app.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
