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
