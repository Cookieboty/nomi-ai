#!/usr/bin/env node
// pnpm dev:web —— 视图在普通浏览器里运行（docs/design/core-host-decoupling.md §11.3「视图在普通浏览器运行」）。
//
// 在 Node 里用无界面宿主（@nomi-ai/host-node）起一个内核，挂上只监听 127.0.0.1 的 WebSocket 传输，再起 ai-chat
// （对话窗口）与 renderer（桌面角色）的 Vite 开发服务器；开发服务器只把 WebSocket 地址注入页面
// （scripts/dev-web/vite-plugin.mjs），本次的随机 token 只在打印出来的地址片段里（`#nomi-token=…`）。在 Chrome 里
// 打开打印出来的完整地址即可（页面把 token 存进 sessionStorage 并从地址栏抹掉），页面经 WebSocket 调内核、收事件。
//
//   pnpm build                       # 先构建（内核与 host-node 从 dist 加载）
//   pnpm dev:web                     # 数据放在临时目录，退出时删除
//   pnpm dev:web -- --data .nomi-web # 数据放在指定目录，保留（.nomi-web/ 已在 .gitignore 里）
//
// 注意：无界面宿主的 secrets 只是可逆编码、不是加密，在浏览器里填的 API Key 会以明文存在数据目录里；
// 指定目录时别放在会被提交的位置，启动时也会打一条警告。
//
// 只用于开发：没有窗口、托盘；桌面角色页面画角色、收事件，但没有透明窗口（拖拽、点击穿透、窗口大小这些要用窗口
// 对象的过程返回 UNAVAILABLE，页面不调）；token 只在日志里露前 4 位。
// 统一网关在 Node 子进程里跑、监听系统分配的端口（不和本机装着的 Nomi 抢默认端口），对话照常经网关。
// Ctrl+C 退出。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEV_HOST, PORT_ENV, PORTS } from '../ports.mjs';

import { DEV_WS_URL_ENV, devPageUrl } from './vite-plugin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const REQUIRED_BUILDS = [
  'apps/desktop-electron/internal/host-node/dist/core.js',
  'apps/desktop-electron/internal/host-node/dist/websocket.js',
  'apps/desktop-electron/internal/core/dist/createCore.js',
  'packages/contract/dist/index.js',
];

/** 系统分配一个空闲端口（冒烟测试避开正在跑的开发服务器） */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, DEV_HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 停子进程及其子孙（POSIX：整个进程组） */
function killTree(child, signal = 'SIGTERM') {
  if (child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // 已经退出
  }
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {
        // 还没起来
      }
      if (Date.now() > deadline) return reject(new Error(`[dev-web] ${url} did not come up`));
      setTimeout(tryOnce, 250);
    };
    void tryOnce();
  });
}

/**
 * 起开发态内核 + WebSocket 传输 + ai-chat 开发服务器。
 * @param {object} [opts]
 * @param {string} [opts.dataDir] 数据目录（缺省临时目录，stop 时删除）
 * @param {number} [opts.chatPort] ai-chat 开发服务器端口（缺省 dev-ports.json 的 chat）
 * @param {number} [opts.mascotPort] renderer（桌面角色）开发服务器端口（缺省 dev-ports.json 的 renderer）
 * @param {boolean} [opts.vite] 是否起 Vite（默认 true）
 * @param {boolean} [opts.mascot] 是否也起桌面角色页面（默认 true）
 * @param {'error'|'warn'|'info'|'debug'} [opts.logLevel]
 * @param {'inherit'|'pipe'|'ignore'} [opts.viteStdio]
 * @param {object} [opts.contract] 传给 createCore 的契约选项（冒烟测试用中间件记录调用）
 * @param {boolean} [opts.processes] 用 Node 子进程跑统一网关等工具子进程（默认 true，对话要经网关）
 */
export async function startDevWeb(opts = {}) {
  const missing = REQUIRED_BUILDS.filter((f) => !existsSync(path.join(ROOT, f)));
  if (missing.length) {
    throw new Error(`[dev-web] missing build output (${missing.join(', ')}); run pnpm build first`);
  }
  const { startHeadlessCore } = await import(
    pathToFileURL(path.join(ROOT, 'apps/desktop-electron/internal/host-node/dist/core.js')).href
  );
  const ws = await import(
    pathToFileURL(path.join(ROOT, 'apps/desktop-electron/internal/host-node/dist/websocket.js'))
      .href
  );

  const chatPort = opts.chatPort ?? PORTS.chat;
  const withMascot = opts.mascot !== false;
  const mascotPort = opts.mascotPort ?? PORTS.renderer;
  const headless = await startHeadlessCore({
    ports: opts.dataDir ? { root: path.resolve(opts.dataDir) } : {},
    // 内置角色包：仓库里的包（CHARACTER_PACK 相对仓库根，缺省官方包），与 Electron 开发态一致
    characterPack: path.resolve(ROOT, process.env.CHARACTER_PACK?.trim() || 'characters/nomi'),
    logLevel: opts.logLevel ?? 'info',
    processes: opts.processes ?? true,
    ...(opts.contract ? { contract: opts.contract } : {}),
  });
  const log = headless.core.logger;
  if (opts.dataDir) {
    // host-node 的 secrets 是可逆编码，不是加密：浏览器里填的 API Key 会以明文落在数据目录
    log.warn('[dev-web] secrets in the data dir are NOT encrypted; keep it out of git', {
      data: headless.control.root,
    });
  }
  const token = ws.createDevToken();
  let server;
  try {
    server = await ws.serveContractOverWebSocket(headless.router, {
      token,
      allowedOrigins: [
        `http://${DEV_HOST}:${chatPort}`,
        `http://localhost:${chatPort}`,
        ...(withMascot
          ? [`http://${DEV_HOST}:${mascotPort}`, `http://localhost:${mascotPort}`]
          : []),
      ],
      surfaces: withMascot ? ['chat', 'mascot'] : ['chat'],
      logger: {
        info: (m, d) => log.info(m, d),
        warn: (m, d) => log.warn(m, d),
        error: (m, d) => log.error(m, d),
      },
    });
  } catch (err) {
    await headless.stop();
    throw err;
  }

  /** 起一个视图包的 Vite 开发服务器，等它能访问 */
  const startVite = async (pkg, portEnv, port) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/run-bin.mjs'), 'vite'], {
      cwd: path.join(ROOT, 'packages', pkg),
      stdio: opts.viteStdio ?? 'inherit',
      // 自己一个进程组：run-bin 再起 vite，停的时候整组一起停，不留孤儿进程占着端口
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        [portEnv]: String(port),
        [DEV_WS_URL_ENV]: server.url,
      },
    });
    vites.push(child);
    await Promise.race([
      waitForHttp(`http://${DEV_HOST}:${port}/`, 60_000),
      new Promise((_, reject) =>
        child.once('exit', (code) =>
          reject(new Error(`[dev-web] vite (${pkg}) exited early (code ${code})`)),
        ),
      ),
    ]);
  };

  /** @type {import('node:child_process').ChildProcess[]} */
  const vites = [];
  const chatUrl = `http://${DEV_HOST}:${chatPort}/`;
  const mascotUrl = withMascot ? `http://${DEV_HOST}:${mascotPort}/` : null;
  if (opts.vite !== false) {
    try {
      await Promise.all([
        startVite('ai-chat', PORT_ENV.chat, chatPort),
        ...(withMascot ? [startVite('renderer', PORT_ENV.renderer, mascotPort)] : []),
      ]);
    } catch (err) {
      for (const v of vites) killTree(v);
      await server.close();
      await headless.stop();
      throw err;
    }
  }

  // 日志里不带 token；完整地址（片段里带 token）只打印到终端（见文件末尾）/ 返回给冒烟脚本
  log.info('[dev-web] ready', {
    chat: chatUrl,
    ...(mascotUrl ? { mascot: mascotUrl } : {}),
    core: server.url,
    token: ws.redactToken(token),
    data: headless.control.root,
  });

  // 父进程意外退出时也别留下开发服务器
  const onExit = () => vites.forEach((v) => killTree(v));
  process.once('exit', onExit);

  let stopping;
  return {
    headless,
    server,
    chatUrl,
    mascotUrl,
    /** 带 token 片段的页面地址：在浏览器里打开它们 */
    chatPageUrl: devPageUrl(chatUrl, token),
    mascotPageUrl: mascotUrl ? devPageUrl(mascotUrl, token) : null,
    stop() {
      stopping ??= (async () => {
        await Promise.all(
          vites
            .filter((v) => v.exitCode === null)
            .map(async (v) => {
              const exited = new Promise((r) => v.once('exit', r));
              killTree(v);
              await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
            }),
        );
        process.off('exit', onExit);
        await server.close();
        await headless.stop();
      })();
      return stopping;
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') out.dataDir = argv[++i];
    else if (a === '--no-vite') out.vite = false;
    else if (a === '--no-mascot') out.mascot = false;
    else if (a === '--') continue;
    else throw new Error(`[dev-web] unknown argument: ${a}`);
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dev = await startDevWeb(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `\n  Nomi dev:web — open ${dev.chatPageUrl} in Chrome` +
      (dev.mascotPageUrl ? `, mascot: ${dev.mascotPageUrl}` : '') +
      ` (core: ${dev.server.url})\n\n`,
  );
  let exiting = false;
  const quit = async () => {
    if (exiting) return;
    exiting = true;
    await dev.stop();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
