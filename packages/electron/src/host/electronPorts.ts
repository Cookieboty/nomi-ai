/**
 * 宿主端口的 Electron 实现（docs/design/core-host-decoupling.md §6、§9）。
 *
 * 只做「端口 → Electron API」的薄翻译，业务策略（`enc:` 前缀、明文降级、netGuard 判定等）
 * 留在调用方。窗口端口是声明式的：经注入的 WindowHost（现有 WindowManager 结构上满足）
 * 表达「打开 / 聚焦 / 隐藏某个界面」，不暴露 BrowserWindow。
 *
 * 剪贴板与截屏复用现有的 ClipboardGateway / ScreenCapture，行为与 AI 能力层一致。
 */
import path from 'node:path';

import type {
  DialogParent,
  HostCapabilities,
  HostPlatform,
  HostPorts,
  Surface,
  Unsubscribe,
  WindowIntent,
} from '@nomi-ai/host-ports';
import {
  app,
  BrowserWindow,
  dialog,
  nativeTheme,
  type OpenDialogOptions,
  powerMonitor,
  safeStorage,
  type SaveDialogOptions,
  shell,
} from 'electron';

import { ClipboardGateway } from '../ai/ClipboardGateway';
import { ScreenCapture } from '../ai/ScreenCapture';

/** 窗口端口需要的最小窗口能力（BrowserWindow 结构上满足） */
export interface HostWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
}

/** 窗口端口依赖的最小窗口管理接口（core/WindowManager 结构上满足） */
export interface WindowHost {
  /** 看板娘窗口（历史命名 main） */
  createMainWindow(opts?: { activate?: boolean }): Promise<unknown>;
  createAiChatWindow(opts?: { activate?: boolean }): Promise<unknown>;
  getMainWindow(): HostWindow | null;
  getAiChatWindow(): HostWindow | null;
  setMascotVisible(visible: boolean): void;
  /** 打开对话窗口并发送面板通道 */
  openProviderPanel(channel?: string): Promise<void>;
}

/**
 * 窗口管理器还没建好时也能先创建端口：每次调用时才取 WindowHost。
 * 取不到时查询返回「没有窗口」，打开类调用抛错（组合根的顺序问题，应尽早暴露）。
 */
export function lazyWindowHost(resolve: () => WindowHost | undefined): WindowHost {
  const need = (): WindowHost => {
    const host = resolve();
    if (!host) throw new Error('window host is not ready');
    return host;
  };
  return {
    createMainWindow: (opts) => need().createMainWindow(opts),
    createAiChatWindow: (opts) => need().createAiChatWindow(opts),
    getMainWindow: () => resolve()?.getMainWindow() ?? null,
    getAiChatWindow: () => resolve()?.getAiChatWindow() ?? null,
    setMascotVisible: (visible) => need().setMascotVisible(visible),
    openProviderPanel: (channel) => need().openProviderPanel(channel),
  };
}

export interface ElectronPortsLogger {
  warn(message: string, meta?: unknown): void;
}

export interface ElectronPortsDeps {
  windows: WindowHost;
  logger?: ElectronPortsLogger;
  /** 默认 process.platform（测试用） */
  platform?: HostPlatform;
  /** 默认 process.resourcesPath（测试用） */
  resourcesPath?: string;
  /** 覆盖 / 补充 route → 对话窗口面板通道的映射 */
  routes?: Record<string, string>;
}

/** 声明式 route 对应的对话窗口面板通道（与托盘、WindowIpcHandler 现用的通道一致） */
export const ELECTRON_WINDOW_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  providers: 'ai:providers:open-panel',
  desktop: 'ai:desktop:open-panel',
  schedule: 'ai:hub:open-schedule',
  voice: 'ai:settings:open-voice',
});

export function electronCapabilities(platform: HostPlatform): HostCapabilities {
  return {
    transparentWindow: true,
    clickThrough: true,
    tray: true,
    island: true,
    nativeTitleBar:
      platform === 'darwin' ? 'mac-traffic-lights' : platform === 'win32' ? 'win-controls' : 'none',
  };
}

function toBytes(buf: Uint8Array): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 只放入调用方给了的字段，保持与现有 dialog 调用的选项一致 */
function commonDialogOptions(o: { title?: string; buttonLabel?: string; defaultPath?: string }) {
  return {
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.buttonLabel !== undefined ? { buttonLabel: o.buttonLabel } : {}),
    ...(o.defaultPath !== undefined ? { defaultPath: o.defaultPath } : {}),
  };
}

export function createElectronPorts(deps: ElectronPortsDeps): HostPorts {
  const { windows, logger } = deps;
  const platform = deps.platform ?? process.platform;
  const routes: Record<string, string> = { ...ELECTRON_WINDOW_ROUTES, ...deps.routes };
  const clipboard = new ClipboardGateway({ pollIntervalMs: 0 });
  const screen = new ScreenCapture();

  const windowOf = (surface: Surface): HostWindow | null => {
    const win = surface === 'mascot' ? windows.getMainWindow() : windows.getAiChatWindow();
    return win && !win.isDestroyed() ? win : null;
  };

  const parentOf = (parent: DialogParent | undefined): BrowserWindow | null => {
    if (!parent || parent === 'none') return null;
    if (parent === 'focused') return BrowserWindow.getFocusedWindow();
    // WindowManager 返回的就是 BrowserWindow；HostWindow 只是它的结构子集
    return windowOf(parent) as BrowserWindow | null;
  };

  const showOpen = async (opts: OpenDialogOptions, parent?: DialogParent) => {
    const win = parentOf(parent);
    return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
  };

  const showSave = async (opts: SaveDialogOptions, parent?: DialogParent) => {
    const win = parentOf(parent);
    return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts);
  };

  const subscribe = (
    emitter: {
      on(event: string, fn: (...args: unknown[]) => void): unknown;
      removeListener(event: string, fn: (...args: unknown[]) => void): unknown;
    },
    event: string,
    fn: () => void,
  ): Unsubscribe => {
    const listener = () => fn();
    emitter.on(event, listener);
    return () => {
      emitter.removeListener(event, listener);
    };
  };

  const routeChannel = (route: string | undefined): string | undefined => {
    if (!route) return undefined;
    const channel = routes[route];
    if (!channel) logger?.warn('未知的窗口 route，只打开界面', { route });
    return channel;
  };

  const openSurface = async (surface: Surface, intent: WindowIntent = {}): Promise<void> => {
    const activate = intent.activate ?? true;
    if (surface === 'mascot') {
      if (!windowOf('mascot')) {
        await windows.createMainWindow({ activate });
        return;
      }
      windows.setMascotVisible(true);
      if (activate) windowOf('mascot')?.focus();
      return;
    }
    const channel =
      routeChannel(intent.route) ??
      (surface === 'settings' ? ELECTRON_WINDOW_ROUTES.providers : undefined);
    if (channel) await windows.openProviderPanel(channel);
    else await windows.createAiChatWindow({ activate });
  };

  return {
    paths: {
      userData: () => app.getPath('userData'),
      logs: () => path.join(app.getPath('userData'), 'logs'),
      temp: () => app.getPath('temp'),
      resources: () => deps.resourcesPath ?? process.resourcesPath,
      appPath: () => app.getAppPath(),
      home: () => app.getPath('home'),
      documents: () => app.getPath('documents'),
    },

    app: {
      name: () => app.getName(),
      version: () => app.getVersion(),
      locale: () => app.getLocale(),
      isPackaged: () => app.isPackaged,
      platform: () => platform,
    },

    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      backend: () =>
        typeof safeStorage.getSelectedStorageBackend === 'function'
          ? safeStorage.getSelectedStorageBackend()
          : null,
      encrypt: (plain) => toBytes(safeStorage.encryptString(plain)),
      decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher)),
    },

    dialogs: {
      async pickFiles(opts = {}) {
        const r = await showOpen(
          {
            ...commonDialogOptions(opts),
            properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
            ...(opts.filters ? { filters: opts.filters } : {}),
          },
          opts.parent,
        );
        return r.canceled ? [] : r.filePaths;
      },
      async pickDirectory(opts = {}) {
        const r = await showOpen(
          {
            ...commonDialogOptions(opts),
            properties: opts.createDirectory
              ? ['openDirectory', 'createDirectory']
              : ['openDirectory'],
          },
          opts.parent,
        );
        return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
      },
      async saveFile(opts = {}) {
        const r = await showSave(
          { ...commonDialogOptions(opts), ...(opts.filters ? { filters: opts.filters } : {}) },
          opts.parent,
        );
        return r.canceled || !r.filePath ? null : r.filePath;
      },
      showError: (title, message) => dialog.showErrorBox(title, message),
    },

    shell: {
      openExternal: (url) => shell.openExternal(url),
      openPath: (target) => shell.openPath(target),
      showItemInFolder: (target) => shell.showItemInFolder(target),
    },

    clipboard: {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
      readImage: async () => (await clipboard.readImage()) ?? null,
    },

    screenCapture: {
      listDisplays: () => screen.listDisplays(),
      capture: (opts) => screen.capture(opts),
    },

    power: {
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      onSuspend: (fn) => subscribe(powerMonitor, 'suspend', fn),
      onResume: (fn) => subscribe(powerMonitor, 'resume', fn),
    },

    lifecycle: {
      whenReady: async () => {
        await app.whenReady();
      },
      // Electron 不等待异步监听器：可靠收尾由组合根的退出流程（createShutdown）负责
      onBeforeQuit: (fn) =>
        subscribe(app, 'before-quit', () => {
          void Promise.resolve()
            .then(fn)
            .catch((error: unknown) =>
              logger?.warn('before-quit 回调失败', {
                error: error instanceof Error ? error.message : String(error),
              }),
            );
        }),
      onActivate: (fn) => subscribe(app, 'activate', fn),
      quit: () => app.quit(),
      exit: (code = 0) => app.exit(code),
    },

    appearance: {
      isDark: () => nativeTheme.shouldUseDarkColors,
      windowAppearance: () => nativeTheme.themeSource,
      setWindowAppearance(mode) {
        if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
      },
      onChange: (fn) => subscribe(nativeTheme, 'updated', fn),
    },

    windows: {
      open: openSurface,
      focus(surface) {
        const win = windowOf(surface);
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      },
      isVisible: (surface) => windowOf(surface)?.isVisible() ?? false,
      hide(surface) {
        if (surface === 'mascot') windows.setMascotVisible(false);
        else windowOf(surface)?.hide();
      },
    },

    capabilities: Object.freeze(electronCapabilities(platform)),
  };
}
