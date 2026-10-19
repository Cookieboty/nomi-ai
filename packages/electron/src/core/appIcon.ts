/**
 * 应用图标变体（sunset 默认 / cream / ink）的运行时切换。
 *
 * 能换的：窗口图标与 Windows 任务栏（win.setIcon）、托盘（tray.setImage）、
 * macOS Dock（app.dock.setIcon，仅本次运行）、系统通知图标。
 * 换不了的：安装包 / 可执行文件 / Finder / 开始菜单里的静态图标，始终是打包时嵌入的 ink。
 */
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, ipcMain, nativeImage, type NativeImage } from 'electron';

export const ICON_VARIANTS = ['ink', 'cream', 'sunset'] as const;
export type IconVariant = (typeof ICON_VARIANTS)[number];
export const DEFAULT_ICON: IconVariant = 'sunset';

export const sanitizeVariant = (v: unknown): IconVariant =>
  ICON_VARIANTS.includes(v as IconVariant) ? (v as IconVariant) : DEFAULT_ICON;

export type IconPart = 'window' | 'dock' | 'tray';

/** assets/app-icons/<variant>/<part>.png；纯函数，便于单测 */
export function iconFile(assetsDir: string, v: IconVariant, part: IconPart): string {
  return path.join(assetsDir, 'app-icons', v, `${part}.png`);
}

/** dev：packages/electron/assets；打包：asar 内同一相对路径（files 含 assets/**） */
export const assetsDir = (): string => path.join(__dirname, '..', '..', 'assets');

let current: IconVariant = DEFAULT_ICON;
let file = '';
const trayListeners = new Set<(img: NativeImage) => void>();

export const currentIcon = (): IconVariant => current;
export const iconImage = (part: IconPart = 'window', v: IconVariant = current): NativeImage =>
  nativeImage.createFromPath(iconFile(assetsDir(), v, part));
export const windowIconPath = (): string => iconFile(assetsDir(), current, 'window');

/** 非 macOS 托盘跟随变体；macOS 托盘保持单色 Template（菜单栏规范） */
export function onTrayIcon(cb: (img: NativeImage) => void): () => void {
  trayListeners.add(cb);
  return () => trayListeners.delete(cb);
}

function apply(): void {
  const win = iconImage('window');
  if (process.platform === 'darwin') {
    app.dock?.setIcon(iconImage('dock'));
  } else {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setIcon(win);
    const tray = iconImage('tray');
    for (const cb of trayListeners) cb(tray);
  }
}

export function setIconVariant(v: unknown): IconVariant {
  current = sanitizeVariant(v);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ variant: current }));
  } catch {
    /* 持久化失败不影响本次切换 */
  }
  apply();
  return current;
}

export function initAppIcon(configFile: string): void {
  file = configFile;
  try {
    current = sanitizeVariant(JSON.parse(fs.readFileSync(file, 'utf8')).variant);
  } catch {
    current = DEFAULT_ICON;
  }
  // 启动即应用：dev 下也不再显示默认 Electron 图标（Dock / 窗口）
  apply();
  ipcMain.handle('app-icon:get', () => ({
    variant: current,
    platform: process.platform,
    previews: Object.fromEntries(
      ICON_VARIANTS.map((v) => [
        v,
        iconImage(process.platform === 'darwin' ? 'dock' : 'window', v)
          .resize({ width: 96 })
          .toDataURL(),
      ]),
    ),
  }));
  ipcMain.handle('app-icon:set', (_e, v: unknown) => setIconVariant(v));
}
