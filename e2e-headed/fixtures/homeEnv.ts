import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Environment that points the app at a throw-away HOME on every platform.
 *
 * Windows resolves os.homedir() from USERPROFILE, but Electron's `appData` from APPDATA /
 * LOCALAPPDATA and the known folders from %USERPROFILE%\<Folder>. They all have to point at
 * directories that exist, otherwise the main process dies with "Failed to get 'appData' path".
 */
export function isolatedHomeEnv(home: string): Record<string, string> {
  const appData = join(home, 'AppData', 'Roaming');
  const localAppData = join(home, 'AppData', 'Local');
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  for (const d of ['Documents', 'Desktop', 'Downloads', 'Music', 'Pictures', 'Videos'])
    mkdirSync(join(home, d), { recursive: true });
  return { HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData };
}

/**
 * 隔离 HOME 时 Electron 要加的启动参数：macOS 下没有登录钥匙串，safeStorage 加密 Key 会弹系统授权框、
 * 卡住主进程（表现为 electron.launch 超时），所以用 Chromium 的模拟钥匙串。
 */
export const ISOLATED_HOME_ARGS: readonly string[] =
  process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
