/**
 * 应用图标变体（sunset 默认 / cream / ink）的运行时切换。
 *
 * 能换的（立即）：
 * - 所有窗口图标（win.setIcon，含之后新建的窗口：browser-window-created）；
 * - Windows 任务栏按钮：每个窗口 win.setAppDetails({ appId, appIconPath: <变体>/app.ico })，
 *   即 System.AppUserModel.RelaunchIconResource——带显式 AppUserModelID 的窗口，任务栏分组图标取它（#56）；
 * - 托盘（tray.setImage）、macOS Dock（app.dock.setIcon，每次启动按保存的变体重设）、系统通知图标。
 * 换不了的：安装包 / 可执行文件 / Finder / 开始菜单 / 桌面快捷方式的静态图标（打包时嵌入的 ink）；
 * 已固定到任务栏的快捷方式图标由 Windows 图标缓存决定，通常重启应用（或取消固定后重新固定）才会变。
 */
import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

export const ICON_VARIANTS = ['ink', 'cream', 'sunset'] as const;
export type IconVariant = (typeof ICON_VARIANTS)[number];
export const DEFAULT_ICON: IconVariant = 'sunset';

export const sanitizeVariant = (v: unknown): IconVariant =>
  ICON_VARIANTS.includes(v as IconVariant) ? (v as IconVariant) : DEFAULT_ICON;

export type IconPart = 'window' | 'dock' | 'tray';

/** 与 electron-builder.yml 的 appId 一致：NSIS 快捷方式的 AppUserModelID 也是它，窗口才能与快捷方式归为一组 */
export const APP_USER_MODEL_ID = 'com.cookieboty.nomi';

/** assets/app-icons/<variant>/<part>.png；纯函数，便于单测 */
export function iconFile(assetsDir: string, v: IconVariant, part: IconPart): string {
  return path.join(assetsDir, 'app-icons', v, `${part}.png`);
}

/** Windows .ico（16–256px，多尺寸；scripts/brand/build-variant-ico.py 生成） */
export function icoFile(assetsDir: string, v: IconVariant): string {
  return path.join(assetsDir, 'app-icons', v, 'app.ico');
}

/** dev：packages/electron/assets；打包后请用 diskAssetsDir（extraResources → resources/assets），勿读 asar 内 assets */
export const assetsDir = (): string => path.join(__dirname, '..', '..', 'assets');

/**
 * 磁盘上真实存在的 assets 目录（Windows Shell 读不了 asar 内的文件）：
 * 打包后 extraResources 把 assets 复制到 resources/assets；dev 直接用源码目录。
 */
export function diskAssetsDir(
  packaged = app.isPackaged,
  resourcesPath: string | undefined = process.resourcesPath,
): string {
  return packaged && resourcesPath ? path.join(resourcesPath, 'assets') : assetsDir();
}

interface IconTarget {
  isDestroyed(): boolean;
  setIcon?(icon: NativeImage): void;
  setAppDetails?(o: { appId?: string; appIconPath?: string; appIconIndex?: number }): void;
}

/** 给单个窗口套用当前变体：窗口图标 +（Windows）任务栏 AppUserModel 图标。纯依赖注入，便于单测 */
export function applyToWindow(
  w: IconTarget,
  opts: { platform: string; image: NativeImage; ico: string | null },
): void {
  if (w.isDestroyed() || opts.platform === 'darwin') return; // setIcon 仅 Windows / Linux
  try {
    w.setIcon?.(opts.image);
  } catch {
    /* 个别窗口（已销毁中）失败不影响其它窗口 */
  }
  if (opts.platform === 'win32' && opts.ico) {
    try {
      w.setAppDetails?.({ appId: APP_USER_MODEL_ID, appIconPath: opts.ico, appIconIndex: 0 });
    } catch {
      /* ignore */
    }
  }
}

const currentIco = (): string | null => {
  const f = icoFile(diskAssetsDir(), current);
  return fs.existsSync(f) ? f : null;
};

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
  if (process.platform === 'darwin') {
    app.dock?.setIcon(iconImage('dock'));
    return;
  }
  const opts = { platform: process.platform, image: iconImage('window'), ico: currentIco() };
  for (const w of BrowserWindow.getAllWindows()) applyToWindow(w, opts);
  const tray = iconImage('tray');
  for (const cb of trayListeners) cb(tray);
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

/** 设置 → 外观里的应用图标：当前变体、平台与各变体的预览（data URL） */
export function appIconState(): {
  variant: IconVariant;
  platform: string;
  previews: Record<IconVariant, string>;
} {
  return {
    variant: current,
    platform: process.platform,
    previews: Object.fromEntries(
      ICON_VARIANTS.map((v) => [
        v,
        iconImage(process.platform === 'darwin' ? 'dock' : 'window', v)
          .resize({ width: 96 })
          .toDataURL(),
      ]),
    ) as Record<IconVariant, string>,
  };
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
  // 之后新建的窗口（看板娘 / 灵动岛 / 截图等）也跟随当前变体，而不是只有主窗口
  app.on?.('browser-window-created', (_e, w) =>
    applyToWindow(w, { platform: process.platform, image: iconImage('window'), ico: currentIco() }),
  );
  guardedHandle('app-icon:get', () => appIconState(), { owner: 'AppIcon', wrapErrors: false });
  guardedHandle('app-icon:set', (v: unknown) => setIconVariant(v), {
    owner: 'AppIcon',
    wrapErrors: false,
  });
}
