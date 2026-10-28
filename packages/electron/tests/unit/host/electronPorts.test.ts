import { EventEmitter } from 'node:events';
import path from 'node:path';

const mockApp = Object.assign(new EventEmitter(), {
  getPath: jest.fn((name: string) => `/p/${name}`),
  getAppPath: jest.fn(() => '/app'),
  getName: jest.fn(() => 'Nomi'),
  getVersion: jest.fn(() => '2.0.4'),
  getLocale: jest.fn(() => 'zh-CN'),
  getPreferredSystemLanguages: jest.fn((): string[] => ['en-GB', 'zh-Hans-CN']),
  isPackaged: false,
  whenReady: jest.fn(() => Promise.resolve()),
  quit: jest.fn(),
  exit: jest.fn(),
});
const mockPower = Object.assign(new EventEmitter(), {
  getSystemIdleTime: jest.fn(() => 42),
});
const mockFocused = { id: 'focused' };
const mockAllWindows: Array<{ isFocused?: () => boolean }> = [];

const mockNativeTheme = Object.assign(new EventEmitter(), {
  shouldUseDarkColors: false,
  themeSource: 'system' as 'system' | 'dark' | 'light',
});

jest.mock('electron', () => ({
  app: mockApp,
  nativeTheme: mockNativeTheme,
  powerMonitor: mockPower,
  BrowserWindow: {
    getFocusedWindow: jest.fn(() => mockFocused),
    getAllWindows: jest.fn(() => mockAllWindows),
  },
  dialog: {
    showOpenDialog: jest.fn(),
    showSaveDialog: jest.fn(),
    showErrorBox: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(async () => undefined),
    openPath: jest.fn(async () => ''),
    showItemInFolder: jest.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    getSelectedStorageBackend: jest.fn(() => 'gnome_libsecret'),
    encryptString: jest.fn((s: string) => Buffer.from(`enc(${s})`)),
    decryptString: jest.fn((b: Buffer) => b.toString().replace(/^enc\((.*)\)$/, '$1')),
  },
  clipboard: {
    readText: jest.fn(async () => 'clip'),
    writeText: jest.fn(async () => undefined),
    read: jest.fn(async () => []),
  },
  nativeImage: { createFromBuffer: jest.fn() },
  screen: {
    getAllDisplays: jest.fn(() => [
      { id: 7, label: 'Built-in', bounds: { x: 0, y: 0, width: 100, height: 50 }, scaleFactor: 2 },
    ]),
    getPrimaryDisplay: jest.fn(() => ({ id: 7 })),
  },
  desktopCapturer: { getSources: jest.fn() },
}));

import { BrowserWindow, clipboard, dialog, safeStorage, shell } from 'electron';

import type { WindowManager } from '../../../src/core/WindowManager';
import {
  createElectronPorts,
  ELECTRON_WINDOW_ROUTES,
  lazyWindowHost,
  type HostWindow,
  type WindowHost,
} from '../../../src/host/electronPorts';

function fakeWindow(visible = true): jest.Mocked<HostWindow> {
  let shown = visible;
  return {
    isDestroyed: jest.fn(() => false),
    isVisible: jest.fn(() => shown),
    isMinimized: jest.fn(() => false),
    restore: jest.fn(),
    show: jest.fn(() => void (shown = true)),
    hide: jest.fn(() => void (shown = false)),
    focus: jest.fn(),
  };
}

function fakeHost(main: HostWindow | null = null, chat: HostWindow | null = null) {
  const host: jest.Mocked<WindowHost> = {
    createMainWindow: jest.fn(async () => undefined),
    createAiChatWindow: jest.fn(async () => undefined),
    getMainWindow: jest.fn(() => main),
    getAiChatWindow: jest.fn(() => chat),
    setMascotVisible: jest.fn(),
    openProviderPanel: jest.fn(async () => undefined),
  };
  return host;
}

describe('createElectronPorts', () => {
  beforeEach(() => {
    mockApp.removeAllListeners();
    mockPower.removeAllListeners();
  });

  it('paths / app 映射到 app.getPath 等', () => {
    const ports = createElectronPorts({ windows: fakeHost(), resourcesPath: '/res' });
    expect(ports.paths.userData()).toBe('/p/userData');
    expect(ports.paths.logs()).toBe(path.join('/p/userData', 'logs'));
    expect(ports.paths.temp()).toBe('/p/temp');
    expect(ports.paths.home()).toBe('/p/home');
    expect(ports.paths.documents()).toBe('/p/documents');
    expect(ports.paths.appPath()).toBe('/app');
    expect(ports.paths.resources()).toBe('/res');
    expect(ports.app.name()).toBe('Nomi');
    expect(ports.app.version()).toBe('2.0.4');
    expect(ports.app.locale()).toBe('zh-CN');
    expect(ports.app.preferredLanguages()).toEqual(['en-GB', 'zh-Hans-CN']);
    expect(ports.app.isPackaged()).toBe(false);
  });

  it('app.preferredLanguages：拿不到时返回空数组', () => {
    const ports = createElectronPorts({ windows: fakeHost() });
    mockApp.getPreferredSystemLanguages.mockReturnValueOnce(undefined as never);
    expect(ports.app.preferredLanguages()).toEqual([]);
  });

  it('secrets 用 safeStorage，返回普通 Uint8Array', () => {
    const ports = createElectronPorts({ windows: fakeHost() });
    expect(ports.secrets.available()).toBe(true);
    expect(ports.secrets.backend()).toBe('gnome_libsecret');
    const c = ports.secrets.encrypt('k');
    expect(Buffer.isBuffer(c)).toBe(false);
    expect(c).toBeInstanceOf(Uint8Array);
    expect(ports.secrets.decrypt(c)).toBe('k');
    expect(safeStorage.encryptString).toHaveBeenCalledWith('k');
  });

  describe('dialogs', () => {
    it('pickDirectory：选项 1:1 传给 showOpenDialog，挂到焦点窗口', async () => {
      (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
        canceled: false,
        filePaths: ['/d'],
      });
      const ports = createElectronPorts({ windows: fakeHost() });
      const r = await ports.dialogs.pickDirectory({
        title: 't',
        buttonLabel: 'ok',
        createDirectory: true,
        parent: 'focused',
      });
      expect(r).toBe('/d');
      expect(BrowserWindow.getFocusedWindow).toHaveBeenCalled();
      expect(dialog.showOpenDialog).toHaveBeenCalledWith(mockFocused, {
        title: 't',
        buttonLabel: 'ok',
        properties: ['openDirectory', 'createDirectory'],
      });
    });

    it('pickFiles：默认不挂父窗口；取消返回空数组；可挂到对话窗口', async () => {
      const chat = fakeWindow();
      const ports = createElectronPorts({ windows: fakeHost(null, chat) });
      (dialog.showOpenDialog as jest.Mock).mockResolvedValue({ canceled: true, filePaths: [] });
      expect(await ports.dialogs.pickFiles({ multiple: true })).toEqual([]);
      expect(dialog.showOpenDialog).toHaveBeenLastCalledWith({
        properties: ['openFile', 'multiSelections'],
      });

      (dialog.showOpenDialog as jest.Mock).mockResolvedValue({
        canceled: false,
        filePaths: ['/a.png'],
      });
      const filters = [{ name: 'Images', extensions: ['png'] }];
      expect(await ports.dialogs.pickFiles({ filters, parent: 'chat' })).toEqual(['/a.png']);
      expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(chat, {
        properties: ['openFile'],
        filters,
      });
    });

    it('saveFile：取消返回 null', async () => {
      const ports = createElectronPorts({ windows: fakeHost() });
      (dialog.showSaveDialog as jest.Mock).mockResolvedValue({
        canceled: false,
        filePath: '/x.zip',
      });
      expect(await ports.dialogs.saveFile({ defaultPath: 'x.zip' })).toBe('/x.zip');
      expect(dialog.showSaveDialog).toHaveBeenLastCalledWith({ defaultPath: 'x.zip' });
      (dialog.showSaveDialog as jest.Mock).mockResolvedValue({ canceled: true, filePath: '' });
      expect(await ports.dialogs.saveFile()).toBeNull();
    });

    it('showError 用 showErrorBox', () => {
      createElectronPorts({ windows: fakeHost() }).dialogs.showError('a', 'b');
      expect(dialog.showErrorBox).toHaveBeenCalledWith('a', 'b');
    });
  });

  it('shell 与 clipboard 直通', async () => {
    const ports = createElectronPorts({ windows: fakeHost() });
    await ports.shell.openExternal('https://x');
    expect(await ports.shell.openPath('/f')).toBe('');
    ports.shell.showItemInFolder('/f');
    expect(shell.openExternal).toHaveBeenCalledWith('https://x');
    expect(shell.openPath).toHaveBeenCalledWith('/f');
    expect(shell.showItemInFolder).toHaveBeenCalledWith('/f');
    expect(await ports.clipboard.readText()).toBe('clip');
    await ports.clipboard.writeText('w');
    expect(clipboard.writeText).toHaveBeenCalledWith('w');
    expect(await ports.clipboard.readImage()).toBeNull();
    expect(await ports.screenCapture.listDisplays()).toEqual([
      {
        id: '7',
        name: 'Built-in',
        primary: true,
        bounds: { x: 0, y: 0, width: 100, height: 50 },
        scaleFactor: 2,
      },
    ]);
  });

  it('power：空闲时间与挂起 / 恢复订阅可退订', () => {
    const ports = createElectronPorts({ windows: fakeHost() });
    expect(ports.power.idleSeconds()).toBe(42);
    const onSuspend = jest.fn();
    const off = ports.power.onSuspend(onSuspend);
    const onResume = jest.fn();
    ports.power.onResume(onResume);
    mockPower.emit('suspend');
    off();
    mockPower.emit('suspend');
    mockPower.emit('resume');
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('lifecycle：before-quit 回调出错只记日志；quit / exit 直通', async () => {
    const logger = { warn: jest.fn() };
    const ports = createElectronPorts({ windows: fakeHost(), logger });
    await ports.lifecycle.whenReady();
    const ok = jest.fn();
    const off = ports.lifecycle.onBeforeQuit(ok);
    ports.lifecycle.onBeforeQuit(async () => {
      throw new Error('boom');
    });
    mockApp.emit('before-quit', { preventDefault: jest.fn() });
    await new Promise((r) => setImmediate(r));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('before-quit 回调失败', { error: 'boom' });
    off();
    const onActivate = jest.fn();
    ports.lifecycle.onActivate(onActivate);
    mockApp.emit('activate');
    expect(onActivate).toHaveBeenCalledTimes(1);
    ports.lifecycle.quit();
    ports.lifecycle.exit();
    expect(mockApp.quit).toHaveBeenCalled();
    expect(mockApp.exit).toHaveBeenCalledWith(0);
  });

  describe('windows（声明式）', () => {
    it('open chat：无 route 时创建 / 聚焦对话窗口；有 route 时发面板通道', async () => {
      const host = fakeHost();
      const ports = createElectronPorts({ windows: host });
      await ports.windows.open('chat', { activate: false });
      expect(host.createAiChatWindow).toHaveBeenCalledWith({ activate: false });
      await ports.windows.open('chat', { route: 'schedule' });
      expect(host.openProviderPanel).toHaveBeenLastCalledWith(ELECTRON_WINDOW_ROUTES.schedule);
      await ports.windows.open('settings');
      expect(host.openProviderPanel).toHaveBeenLastCalledWith(ELECTRON_WINDOW_ROUTES.providers);
    });

    it('未知 route 记警告并只打开界面', async () => {
      const host = fakeHost();
      const logger = { warn: jest.fn() };
      const ports = createElectronPorts({ windows: host, logger });
      await ports.windows.open('chat', { route: 'nope' });
      expect(logger.warn).toHaveBeenCalled();
      expect(host.createAiChatWindow).toHaveBeenCalledWith({ activate: true });
      expect(host.openProviderPanel).not.toHaveBeenCalled();
    });

    it('open mascot：窗口不存在时创建，存在时显示并按需聚焦', async () => {
      const host = fakeHost();
      const ports = createElectronPorts({ windows: host });
      await ports.windows.open('mascot', { activate: false });
      expect(host.createMainWindow).toHaveBeenCalledWith({ activate: false });

      const mascot = fakeWindow(false);
      host.getMainWindow.mockReturnValue(mascot);
      await ports.windows.open('mascot');
      expect(host.setMascotVisible).toHaveBeenCalledWith(true);
      expect(mascot.focus).toHaveBeenCalled();
    });

    it('focus / isVisible / hide', () => {
      const chat = fakeWindow(false);
      chat.isMinimized.mockReturnValue(true);
      const host = fakeHost(null, chat);
      const ports = createElectronPorts({ windows: host });
      expect(ports.windows.isVisible('chat')).toBe(false);
      expect(ports.windows.isVisible('mascot')).toBe(false);
      ports.windows.focus('chat');
      expect(chat.restore).toHaveBeenCalled();
      expect(chat.focus).toHaveBeenCalled();
      expect(ports.windows.isVisible('settings')).toBe(true);
      ports.windows.hide('chat');
      expect(chat.hide).toHaveBeenCalled();
      ports.windows.hide('mascot');
      expect(host.setMascotVisible).toHaveBeenCalledWith(false);
      ports.windows.focus('mascot'); // 不存在时什么都不做
    });

    it('anyFocused：所有窗口里任一获得焦点即为 true', () => {
      const ports = createElectronPorts({ windows: fakeHost() });
      mockAllWindows.splice(0);
      expect(ports.windows.anyFocused()).toBe(false);
      mockAllWindows.push({ isFocused: () => false }, {});
      expect(ports.windows.anyFocused()).toBe(false);
      mockAllWindows.push({ isFocused: () => true });
      expect(ports.windows.anyFocused()).toBe(true);
      mockAllWindows.splice(0);
    });

    it('已销毁的窗口视为不存在', () => {
      const chat = fakeWindow(true);
      chat.isDestroyed.mockReturnValue(true);
      const ports = createElectronPorts({ windows: fakeHost(null, chat) });
      expect(ports.windows.isVisible('chat')).toBe(false);
      ports.windows.focus('chat');
      expect(chat.focus).not.toHaveBeenCalled();
    });
  });

  it('capabilities 按平台声明且只读', () => {
    const mac = createElectronPorts({ windows: fakeHost(), platform: 'darwin' }).capabilities;
    expect(mac).toEqual({
      transparentWindow: true,
      clickThrough: true,
      tray: true,
      island: true,
      nativeTitleBar: 'mac-traffic-lights',
    });
    expect(Object.isFrozen(mac)).toBe(true);
    expect(
      createElectronPorts({ windows: fakeHost(), platform: 'win32' }).capabilities.nativeTitleBar,
    ).toBe('win-controls');
    expect(
      createElectronPorts({ windows: fakeHost(), platform: 'linux' }).capabilities.nativeTitleBar,
    ).toBe('none');
  });

  it('appearance：读写 nativeTheme，相同外观不重复设置，updated 订阅可退订', () => {
    const ports = createElectronPorts({ windows: fakeHost() });
    mockNativeTheme.shouldUseDarkColors = true;
    expect(ports.appearance.isDark()).toBe(true);
    const set = jest.fn();
    let source: 'system' | 'dark' | 'light' = 'system';
    Object.defineProperty(mockNativeTheme, 'themeSource', {
      configurable: true,
      get: () => source,
      set: (v: typeof source) => {
        set(v);
        source = v;
      },
    });
    ports.appearance.setWindowAppearance('dark');
    ports.appearance.setWindowAppearance('dark');
    expect(set).toHaveBeenCalledTimes(1);
    expect(ports.appearance.windowAppearance()).toBe('dark');
    const fn = jest.fn();
    const off = ports.appearance.onChange(fn);
    mockNativeTheme.emit('updated');
    off();
    mockNativeTheme.emit('updated');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('lazyWindowHost：窗口管理器建好之前查询返回空、打开类调用抛错，之后直通', async () => {
    const slot: { host?: WindowHost } = {};
    const ports = createElectronPorts({ windows: lazyWindowHost(() => slot.host) });
    expect(ports.windows.isVisible('chat')).toBe(false);
    ports.windows.focus('mascot');
    await expect(ports.windows.open('chat')).rejects.toThrow(/not ready/);
    const chat = fakeWindow();
    const real = fakeHost(null, chat);
    slot.host = real;
    expect(ports.windows.isVisible('chat')).toBe(true);
    await ports.windows.open('chat', { route: 'voice' });
    expect(real.openProviderPanel).toHaveBeenCalledWith(ELECTRON_WINDOW_ROUTES.voice);
  });

  it('现有 WindowManager 结构上满足 WindowHost', () => {
    // 只做类型层面的检查：编译失败即说明接口漂移
    const check = (wm: WindowManager): WindowHost => wm;
    expect(typeof check).toBe('function');
  });
});
