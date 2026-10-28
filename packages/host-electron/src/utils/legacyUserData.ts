/**
 * 开发态包名变更（@ig-live/electron → @nomi-ai/electron）后，Electron 的 userData
 * 目录会随之变化。未打包运行时，若新目录尚无应用数据而旧目录存在，则复制过来
 * （不删除旧目录）。打包产物不再从旧品牌目录迁移。必须在 `app.whenReady()` 之前调用。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 未打包（开发）运行时 Electron 用 package.json name 作为目录名 */
export const LEGACY_DEV_NAMES = ['@ig-live/electron'] as const;

export interface MigrateResult {
  migrated: boolean;
  from?: string;
  to: string;
}

export function migrateLegacyUserData(
  appDataDir: string,
  userDataDir: string,
  legacyNames: readonly string[] = LEGACY_DEV_NAMES,
): MigrateResult {
  if (hasUserData(userDataDir)) return { migrated: false, to: userDataDir };
  for (const name of legacyNames) {
    const from = path.join(appDataDir, name);
    if (from === userDataDir || !fs.existsSync(from)) continue;
    fs.cpSync(from, userDataDir, { recursive: true, errorOnExist: false });
    return { migrated: true, from, to: userDataDir };
  }
  return { migrated: false, to: userDataDir };
}

/**
 * Chromium 在主脚本运行前就会在 userData 下建 Crashpad 等目录，因此不能用
 * “目录是否存在”判断新目录是否已被使用；只要还没有任何应用自己的数据，就视为全新。
 */
const BOOT_ENTRIES = new Set([
  'Crashpad',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Dictionaries',
  'Local State',
  'Network Persistent State',
  'Preferences',
  'Shared Dictionary',
  'SharedStorage',
  'blob_storage',
  'logs',
]);

export function hasUserData(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((e) => !BOOT_ENTRIES.has(e));
}
