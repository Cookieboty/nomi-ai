// 截图用的 Go 版应用：构建视图与 Go 程序，在隔离环境里启动，把视图经回环 HTTP 交给 Playwright 的浏览器。
//
// 用到 Go 程序的开发 / CI 开关（apps/desktop-go/main.go，只在设置了 NOMI_POC_CTL 时生效）：
//   - NOMI_POC_CTL=127.0.0.1:<端口>：本机控制口；`/ctl?op=web-url&surface=chat|mascot` 给一个带本次 token 的页面地址；
//   - NOMI_WEB_VIEWS=127.0.0.1:0：把应用里的视图资源（含 /__scheme/ 资源网关）也在回环 HTTP 上提供，内核接受这个来源的 WebSocket；
//   - NOMI_TEST_PICK_DIR / NOMI_TEST_PICK_FILES：系统对话框「选文件夹 / 选文件」直接返回这些路径（不弹窗）；
//   - CD_LOCALE：固定界面语言；NOMI_APP_DATA：userData 放在临时目录。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** 系统分配一个空闲端口 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`[site-shots] ${cmd} ${args.join(' ')} failed (${r.status})`);
}

/** Go 的构建标签：macOS 透明窗口要 private_mac_apis，Linux 用 GTK3 */
function buildTags() {
  if (process.platform === 'darwin') return ['-tags', 'private_mac_apis'];
  if (process.platform === 'linux') return ['-tags', 'gtk3'];
  return [];
}

/**
 * 构建视图与 Go 程序，返回可执行文件路径。要在改 HOME 之前调：Go 的模块缓存与工具链在真实 HOME 下。
 * opts：root 仓库根；work 临时目录；version 显示的版本号
 */
export function buildGoApp({ root, work, version }) {
  const appDir = path.join(root, 'apps', 'desktop-go');
  const bin = path.join(work, 'bin', process.platform === 'win32' ? 'nomi.exe' : 'nomi');
  // 视图：与安装包同一份构建产物（turbo build renderer + ai-chat → frontend/dist）
  run(process.execPath, [path.join(appDir, 'frontend', 'build.mjs')], { cwd: root });
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  run(
    'go',
    [
      'build',
      ...buildTags(),
      '-ldflags',
      `-X github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports.AppVersion=${version}`,
      '-o',
      bin,
      '.',
    ],
    { cwd: appDir },
  );
  return bin;
}

/**
 * 在当前（已隔离的）环境里启动 Go 版应用。返回 { chatPageUrl, mascotPageUrl, userData, logFile, stop }。
 * opts：bin 可执行文件；work 临时目录；locale；pickDir / pickFiles 对话框预设答案
 */
export async function startGoApp({ bin, work, locale = 'zh-CN', pickDir, pickFiles = [] }) {
  const appData = path.join(work, 'data');
  const userData = path.join(appData, 'Nomi');
  fs.mkdirSync(userData, { recursive: true });
  // 截图时不检查更新（不读 Release、不下载）
  fs.writeFileSync(
    path.join(userData, 'update-settings.json'),
    '{"version":1,"autoCheck":false}\n',
  );

  const ctl = `127.0.0.1:${await freePort()}`;
  const logFile = path.join(work, 'nomi.log');
  const log = fs.openSync(logFile, 'a');
  const child = spawn(bin, [], {
    cwd: work,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      NOMI_APP_DATA: appData,
      NOMI_POC_CTL: ctl,
      NOMI_WEB_VIEWS: '127.0.0.1:0',
      NOMI_TEST_MEMORY_KEYRING: '1',
      CD_LOCALE: locale,
      ...(pickDir ? { NOMI_TEST_PICK_DIR: pickDir } : {}),
      ...(pickFiles.length ? { NOMI_TEST_PICK_FILES: pickFiles.join(path.delimiter) } : {}),
    },
  });
  let exited = false;
  child.on('exit', () => (exited = true));

  const pageUrl = async (surface) => {
    for (let i = 0; i < 120; i++) {
      if (exited) throw new Error(`[site-shots] Nomi exited early; see ${logFile}`);
      try {
        const r = await fetch(`http://${ctl}/ctl?op=web-url&surface=${surface}`);
        const text = (await r.text()).trim();
        if (r.ok && text.startsWith('http')) return text;
      } catch {
        /* 还没起来 */
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`[site-shots] Nomi did not answer on ${ctl}; see ${logFile}`);
  };
  let chatPageUrl, mascotPageUrl;
  try {
    chatPageUrl = await pageUrl('chat');
    mascotPageUrl = await pageUrl('mascot');
  } catch (e) {
    // 起不来（卡住或提前退出）：不留进程
    if (!exited) child.kill('SIGKILL');
    throw e;
  }

  return {
    chatPageUrl,
    mascotPageUrl,
    userData,
    logFile,
    async stop() {
      if (exited) return;
      await fetch(`http://${ctl}/ctl?op=quit`).catch(() => {});
      for (let i = 0; i < 20 && !exited; i++) await new Promise((res) => setTimeout(res, 250));
      if (!exited) child.kill();
    },
  };
}
