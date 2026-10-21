/**
 * Electron应用主入口文件 - 重构版本
 * 简化架构，使用Application类管理应用生命周期
 */

import * as path from 'path';

import { app, BrowserWindow } from 'electron';

import { defaultProbe } from './cli/CliUpdateService';
import { forgetMissingCliBins, npmPrefixBinDir, rememberCliDir } from './cli/detect';
import { loadLoginShellPath } from './cli/shellPath';
import { Application } from './core/Application';
import { registerAppSchemePrivileges } from './schemePrivileges';
import { LEGACY_DEV_NAMES, migrateLegacyUserData } from './utils/legacyUserData';
import { createMainLogger } from './utils/log';
import { perfMark } from './utils/perfMarks';

const log = createMainLogger('main');

perfMark('main-entry');

/**
 * 单实例锁：避免多开导致全局快捷键 / 本地模型服务 / userData 竞争。
 * 打包应用的 deep link（nomi://，Windows/Linux 经第二实例 argv 传入）统一聚焦到已有窗口；
 * host 白名单当前为空——未来实现具体动作时必须在此显式登记，默认一律忽略。
 */
const DEEP_LINK_ALLOWED_HOSTS = new Set<string>([]);

function focusExistingWindow(): void {
  // 默认界面为「软件主界面」：第二次启动直接把主界面带到前台
  if (application?.raiseMainOnReactivate()) return;
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function consumeDeepLink(url: string | undefined): void {
  if (!url || !/^nomi:/i.test(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!DEEP_LINK_ALLOWED_HOSTS.has(parsed.host)) return;
  // 白名单为空：当前没有任何可执行的 deep link 动作，仅聚焦窗口
  focusExistingWindow();
}

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  // 第二实例：立即退出，且不得继续执行 userData 迁移 / 应用启动（见下方守卫）
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    consumeDeepLink(argv.find((a) => /^nomi:/i.test(a)));
    focusExistingWindow();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    consumeDeepLink(url);
  });
}

// 开发态包名变更后沿用旧 userData（需在 ready 之前）。打包产物不迁移旧品牌目录。
// 仅当 userData 是默认目录时迁移（测试 / --user-data-dir 指定的目录不动）。
// 第二实例跳过，避免与正在运行的实例争用目录。
if (isPrimaryInstance && !app.isPackaged) {
  const appData = app.getPath('appData');
  const userData = app.getPath('userData');
  try {
    const isDefault = path.resolve(userData) === path.resolve(appData, app.getName());
    const res = isDefault
      ? migrateLegacyUserData(appData, userData, LEGACY_DEV_NAMES)
      : { migrated: false as const, from: '', to: userData };
    if (res.migrated) log.info(`📦 已迁移开发态用户数据: ${res.from} → ${res.to}`);
  } catch (error) {
    console.warn('开发态用户数据迁移失败:', error);
  }
}

// chat-asset://（会话 Markdown 图片）需在 app ready 之前注册为特权协议
// （registerSchemesAsPrivileged 多次调用会互相覆盖，见 schemePrivileges.ts）
registerAppSchemePrivileges();

// 全局应用实例
let application: Application | null = null;

/**
 * 应用入口函数
 */
async function main(): Promise<void> {
  // 读登录 shell 的 PATH（不阻塞启动；探测 CLI 的异步路径会等它），见 cli/shellPath.ts（#76）
  void loadLoginShellPath((added) => {
    forgetMissingCliBins();
    log.info(`已从登录 shell 补全 PATH（新增 ${added.length} 个目录）`);
  }).then(() => {
    // 再记住 npm 实际的全局 bin（自定义 prefix 且 shell 里没配 PATH 时也能找到已装的 CLI）；
    // 稍后再跑，不和启动抢资源
    setTimeout(() => {
      void Promise.resolve(defaultProbe.npmPrefix())
        .then((prefix) => prefix && rememberCliDir(npmPrefixBinDir(prefix)))
        .catch(() => undefined);
    }, 3000).unref();
  });
  try {
    // 创建应用实例
    application = new Application();

    // 初始化并启动应用
    await application.initialize();
    await application.start();

    log.info('✅ Nomi 启动成功');
  } catch (error) {
    console.error('❌ 应用启动失败:', error);
    process.exit(1);
  }
}

// 退出（before-quit / SIGTERM / SIGINT）统一由 Application 处理，这里不再注册信号监听

// 启动应用（仅主实例）
if (isPrimaryInstance)
  main().catch((error) => {
    console.error('主程序异常:', error);
    process.exit(1);
  });
