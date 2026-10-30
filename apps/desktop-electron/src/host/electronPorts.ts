/**
 * 宿主端口的 Electron 实现（docs/design/core-host-decoupling.md §6、§9）。
 *
 * 只做「端口 → Electron API」的薄翻译，业务策略（`enc:` 前缀、明文降级、netGuard 判定等）
 * 留在调用方。窗口端口是声明式的：经注入的 WindowHost（现有 WindowManager 结构上满足）
 * 表达「打开 / 聚焦 / 隐藏某个界面」，不暴露 BrowserWindow。
 *
 * 剪贴板与截屏复用现有的 ClipboardGateway / ScreenCapture，行为与 AI 能力层一致。
 * 系统通知的图标用应用当前图标（core/appIcon），工具子进程是 `utilityProcess`。
 */
import path from 'node:path';

import type { ChatNavEvent } from '@nomi-ai/core/core/chatNav';
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
  nativeImage,
  nativeTheme,
  Notification,
  type OpenDialogOptions,
  powerMonitor,
  safeStorage,
  type SaveDialogOptions,
  shell,
  utilityProcess,
} from 'electron';

import { iconImage } from '../core/appIcon';

import { ClipboardGateway } from './ClipboardGateway';
import { ScreenCapture } from './ScreenCapture';

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
  /** 桌面角色窗口（历史命名 main） */
  createMainWindow(opts?: { activate?: boolean }): Promise<unknown>;
  createAiChatWindow(opts?: { activate?: boolean }): Promise<unknown>;
  getMainWindow(): HostWindow | null;
  getAiChatWindow(): HostWindow | null;
  setMascotVisible(visible: boolean): void;
  /** 打开对话窗口并发布面板导航事件 */
  openProviderPanel(event?: ChatNavEvent): Promise<void>;
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
    openProviderPanel: (event) => need().openProviderPanel(event),
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
  /** 覆盖 / 补充 route → 对话窗口面板导航事件的映射 */
  routes?: Record<string, ChatNavEvent>;
}

/** 声明式 route 对应的对话窗口面板导航事件（WindowManager.openProviderPanel 发布的契约事件） */
export const ELECTRON_WINDOW_ROUTES: Readonly<Record<string, ChatNavEvent>> = Object.freeze({
  providers: 'providers.openPanel',
  desktop: 'nav.desktopPanelRequested',
  schedule: 'nav.scheduleRequested',
  voice: 'nav.voiceSettingsRequested',
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

/** 不复制地把 Uint8Array 视为 Buffer（nativeImage / safeStorage 只收 Buffer） */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
  const routes: Record<string, ChatNavEvent> = { ...ELECTRON_WINDOW_ROUTES, ...deps.routes };
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

  const routeEvent = (route: string | undefined): ChatNavEvent | undefined => {
    if (!route) return undefined;
    const event = routes[route];
    if (!event) logger?.warn('未知的窗口 route，只打开界面', { route });
    return event;
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
    const event =
      routeEvent(intent.route) ??
      (surface === 'settings' ? ELECTRON_WINDOW_ROUTES.providers : undefined);
    if (event) await windows.openProviderPanel(event);
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
      preferredLanguages: () => app.getPreferredSystemLanguages?.() ?? [],
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
      trashItem: (target) => shell.trashItem(target),
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

    notifications: {
      supported: () => Notification.isSupported(),
      show(n, onClick) {
        const note = new Notification({
          title: n.title,
          body: n.body,
          silent: n.silent ?? false,
          icon: iconImage(),
        });
        if (onClick) note.on('click', () => onClick());
        note.show();
      },
    },

    image: {
      async size(data) {
        const img = nativeImage.createFromBuffer(toBuffer(data));
        return img.isEmpty() ? null : img.getSize();
      },
      async resize(data, opts) {
        const img = nativeImage.createFromBuffer(toBuffer(data));
        if (img.isEmpty()) throw new Error('image decode failed');
        const out = img.resize({
          ...(opts.width !== undefined ? { width: opts.width } : {}),
          ...(opts.height !== undefined ? { height: opts.height } : {}),
          quality: 'best',
        });
        return toBytes(opts.format === 'png' ? out.toPNG() : out.toJPEG(opts.quality ?? 85));
      },
    },

    processes: {
      available: () => typeof utilityProcess?.fork === 'function',
      fork(modulePath, opts = {}) {
        const child = utilityProcess.fork(modulePath, opts.args ?? [], {
          ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
          ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
          stdio: opts.stdio ?? 'ignore',
        });
        return {
          postMessage: (message) => child.postMessage(message),
          on: (event: 'message' | 'exit', fn: (arg: never) => void) => {
            child.on(event as 'message', fn as (message: unknown) => void);
          },
          kill: () => child.kill(),
        };
      },
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
      // 所有窗口（含桌面角色、对话窗口与辅助窗口）里任一获得焦点
      anyFocused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused?.()),
    },

    capabilities: Object.freeze(electronCapabilities(platform)),
  };
}
