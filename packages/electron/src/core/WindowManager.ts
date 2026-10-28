/**
 * 窗口管理器 - 统一管理所有窗口的创建、销毁和状态
 */

import * as path from 'path';
import * as url from 'url';

import { BrowserWindow, screen, app, type BrowserWindowConstructorOptions } from 'electron';

import { fitMascotScale, maxScaleForArea, mascotWindowSize } from '../mascot/mascotSize';
import { MascotWindowController } from '../mascot/MascotWindowController';
import { installWindowGuards } from '../security/windowGuards';
import { type IConfigService } from '../services/ConfigService';
import { type ILoggerService } from '../services/LoggerService';
import { perfEnabled, perfMark } from '../utils/perfMarks';
import { installPreloadGuard } from '../utils/preloadGuard';
import { setWindowBounds } from '../utils/windowBounds';

import type { AppEvents } from './appEvents';
import { windowIconPath } from './appIcon';
import { restoreChatBounds } from './chatWindowBounds';
import { devChatUrl, devRendererUrl } from './devPorts';
import { eventBus } from './EventBus';
import { type ChromeTheme, titleBarOptions } from './titleBar';
import { onGeometryChange } from './windowGeometryEvents';

/** 开发模式：未打包且显式声明 NODE_ENV，防止打包应用被注入环境变量后加载本机 dev server */
const isDevMode = (): boolean => !app.isPackaged && process.env.NODE_ENV === 'development';

export interface WindowOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  frame?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  resizable?: boolean;
  show?: boolean;
  /** 窗口准备好后显示但不抢占焦点（开机自启 / 看板娘让位给主界面） */
  showInactive?: boolean;
  title?: string;
  preloadScript?: string;
  /** 额外的 BrowserWindow 选项（标题栏样式等） */
  chrome?: Partial<BrowserWindowConstructorOptions>;
}

/** 窗口显示方式：默认抢占焦点；`activate: false` 时只显示、不抢焦点 */
export interface ShowOptions {
  activate?: boolean;
}

export interface IWindowManager {
  /** 创建看板娘窗口（历史命名 main） */
  createMainWindow(opts?: ShowOptions): Promise<BrowserWindow>;
  /** 创建 / 聚焦软件主界面（对话窗口） */
  createAiChatWindow(opts?: ShowOptions): Promise<BrowserWindow>;
  getMainWindow(): BrowserWindow | null;
  getAiChatWindow(): BrowserWindow | null;
  closeAllWindows(): void;
  setAlwaysOnTop(windowType: 'main' | 'aiChat', flag: boolean): void;
  /** 显示 / 隐藏桌面看板娘；隐藏时窗口保留（提醒、确认框仍有宿主）但静音 */
  setMascotVisible(visible: boolean): void;
  /** 打开对话窗口并发送面板通道（默认「供应商设置」） */
  openProviderPanel(channel?: string): Promise<void>;
}

/** 对话窗口的最小尺寸（设置是全窗布局，再小放不下） */
const CHAT_MIN_SIZE = { width: 760, height: 560 };

export class WindowManager implements IWindowManager {
  /** 当前主题（Application 注入，决定对话窗口标题栏配色） */
  chromeTheme: () => ChromeTheme = () => 'sunset';
  /** 主界面关闭后是否退出整个应用（「关闭主界面时：退出 Nomi」；Application 注入，默认不退出） */
  shouldQuitOnChatClose: () => boolean = () => false;
  /** 看板娘是否被关闭（「关闭看板娘」/ 设置；Application 注入，默认显示） */
  mascotHidden: () => boolean = () => false;
  private mainWindow: BrowserWindow | null = null;
  private aiChatWindow: BrowserWindow | null = null;
  /** 正在创建中的 AI 对话窗口（并发 createAiChatWindow 共用） */
  private aiChatWindowPromise?: Promise<BrowserWindow>;
  private logger: ILoggerService;
  private configService: IConfigService;

  /** 应用事件总线（面板导航、窗口鼠标进出）；测试里可以不给，推送直接丢弃 */
  private readonly events?: AppEvents;

  constructor(logger: ILoggerService, configService: IConfigService, events?: AppEvents) {
    this.logger = logger;
    this.configService = configService;
    this.events = events;
  }

  /**
   * 创建主窗口
   */
  async createMainWindow(opts: ShowOptions = {}): Promise<BrowserWindow> {
    if (this.mainWindow) {
      if (!this.mascotHidden()) this.mainWindow.focus();
      return this.mainWindow;
    }

    try {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize;
      const config = this.configService.getConfig();

      // 检查位置是否有效
      let x = config.windowPosition.x;
      let y = config.windowPosition.y;

      // 窗口 = 角色框（默认原尺寸的一半）+ 工具栏 / 气泡的透明边距（逐像素点击穿透）
      // 缩放按屏幕可用区域夹紧（小屏幕上不会超出工作区）；偏好值不改写
      const scale = fitMascotScale(
        config.mascotScale,
        maxScaleForArea(screen.getPrimaryDisplay().workArea),
      );
      const size = mascotWindowSize(scale);
      if (x <= 0 || x >= width || y <= 0 || y >= height) {
        x = width - size.width;
        y = height - size.height;
      }

      const windowOptions: WindowOptions = {
        width: size.width,
        height: size.height,
        x,
        y,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        show: false,
        showInactive: opts.activate === false,
        preloadScript: 'preload.bundle.js',
      };

      this.mainWindow = await this.createWindow(windowOptions, 'main');
      if (process.platform === 'win32') setWindowBounds(this.mainWindow, { x, y, ...size });
      // 看板娘已关闭：整窗静音（音效 / TTS 音频），渲染端另外跳过朗读
      this.mainWindow.webContents.setAudioMuted(this.mascotHidden());

      // 设置窗口事件监听
      this.setupMainWindowEvents(this.mainWindow);

      // 加载应用页面
      await this.loadMainWindowContent(this.mainWindow);

      this.logger.info('主窗口创建成功');
      eventBus.emit('window:main:created', this.mainWindow);

      return this.mainWindow;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('主窗口创建失败', { error: errorMessage });
      throw error;
    }
  }

  /**
   * 创建AI对话窗口
   */
  async createAiChatWindow(opts: ShowOptions = {}): Promise<BrowserWindow> {
    if (this.aiChatWindow) {
      const win = this.aiChatWindow;
      // 最小化的窗口先还原（Windows 上从任务栏 / 托盘 / 第二实例唤起时需要）
      if (win.isMinimized()) win.restore();
      if (opts.activate === false) {
        win.showInactive();
      } else {
        win.show();
        win.focus();
      }
      return win;
    }
    // 创建过程是异步的（await createWindow / 加载页面）：并发调用共用同一次创建，避免开出两个窗口
    this.aiChatWindowPromise ??= this.buildAiChatWindow(opts).finally(() => {
      this.aiChatWindowPromise = undefined;
    });
    return this.aiChatWindowPromise;
  }

  private async buildAiChatWindow(opts: ShowOptions = {}): Promise<BrowserWindow> {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

      // 设置是全窗布局，给足空间；小屏按工作区收缩
      const defaultWidth = Math.min(1120, screenWidth - 40);
      const defaultHeight = Math.min(820, screenHeight - 40);
      // 上次关闭时的位置与大小（按现在的显示器校正）；没有时居中默认尺寸
      const restored = restoreChatBounds(
        this.configService.getConfig().chatWindowBounds,
        [primaryDisplay, ...screen.getAllDisplays().filter((d) => d.id !== primaryDisplay.id)].map(
          (d) => d.workArea,
        ),
        CHAT_MIN_SIZE,
      );
      const windowWidth = restored?.width ?? defaultWidth;
      const windowHeight = restored?.height ?? defaultHeight;
      const x = restored?.x ?? Math.round((screenWidth - windowWidth) / 2);
      const y = restored?.y ?? Math.round((screenHeight - windowHeight) / 2);

      const windowOptions: WindowOptions = {
        width: windowWidth,
        height: windowHeight,
        x,
        y,
        frame: true,
        transparent: false,
        alwaysOnTop: false,
        resizable: true,
        show: false,
        showInactive: opts.activate === false,
        title: 'Nomi',
        preloadScript: 'ai-chat-preload.bundle.js',
        chrome: {
          ...titleBarOptions(process.platform, this.chromeTheme()),
          minWidth: CHAT_MIN_SIZE.width,
          minHeight: CHAT_MIN_SIZE.height,
        },
      };

      this.aiChatWindow = await this.createWindow(windowOptions, 'aiChat');
      if (restored?.maximized) this.aiChatWindow.maximize();

      // 设置窗口事件监听
      this.setupAiChatWindowEvents(this.aiChatWindow);

      // 加载AI对话页面
      await this.loadAiChatWindowContent(this.aiChatWindow);

      this.logger.info('AI对话窗口创建成功');
      eventBus.emit('window:aiChat:created', this.aiChatWindow);

      return this.aiChatWindow;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('AI对话窗口创建失败', { error: errorMessage });
      throw error;
    }
  }

  /**
   * 打开 AI 对话窗口并弹出某个面板（托盘 / 菜单 / 看板娘入口）。`channel` 是面板的应用事件
   * （`ai:providers:open-panel` 等），事件桥转成契约事件（`providers.openPanel` / `nav.*`），只发给对话窗口。
   */
  async openProviderPanel(channel = 'ai:providers:open-panel'): Promise<void> {
    const existed = Boolean(this.aiChatWindow);
    const win = await this.createAiChatWindow();
    // 新建窗口时给 React 挂载、订阅契约事件留一点时间
    setTimeout(
      () => {
        if (!win.isDestroyed()) this.events?.publish(channel, {}, { surface: 'chat' });
      },
      existed ? 0 : 400,
    );
  }

  /**
   * 获取主窗口
   */
  /** 看板娘窗口控制器（托盘 / 测试读取状态） */
  mascotController: MascotWindowController | null = null;

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /**
   * 获取AI对话窗口
   */
  getAiChatWindow(): BrowserWindow | null {
    return this.aiChatWindow;
  }

  /**
   * 关闭所有窗口
   */
  closeAllWindows(): void {
    if (this.aiChatWindow) {
      this.aiChatWindow.close();
    }
    if (this.mainWindow) {
      this.mainWindow.close();
    }
  }

  setMascotVisible(visible: boolean): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) {
      if (visible) void this.createMainWindow({ activate: false });
      return;
    }
    win.webContents.setAudioMuted(!visible);
    if (visible) win.showInactive();
    else win.hide();
    this.logger.info(visible ? '看板娘已显示' : '看板娘已关闭');
  }

  /**
   * 设置窗口置顶状态
   */
  setAlwaysOnTop(windowType: 'main' | 'aiChat', flag: boolean): void {
    let window: BrowserWindow | null = null;
    switch (windowType) {
      case 'main':
        window = this.mainWindow;
        break;
      case 'aiChat':
        window = this.aiChatWindow;
        break;
    }

    if (window) {
      window.setAlwaysOnTop(flag);
      this.logger.debug(`窗口置顶状态已更新`, { windowType, flag });
    }
  }

  /**
   * 通用窗口创建方法
   */
  private async createWindow(options: WindowOptions, type: string): Promise<BrowserWindow> {
    const window = new BrowserWindow({
      width: options.width,
      height: options.height,
      x: options.x,
      y: options.y,
      frame: options.frame,
      transparent: options.transparent,
      resizable: options.resizable,
      alwaysOnTop: options.alwaysOnTop,
      show: options.show,
      title: options.title,
      icon: windowIconPath(),
      skipTaskbar: type === 'main',
      // macOS 对话窗口使用系统原生阴影；透明看板娘不绘制整窗阴影。
      hasShadow: process.platform === 'darwin' && type === 'aiChat',
      backgroundColor: type === 'main' ? '#00000000' : undefined,
      ...(options.chrome ?? {}),
      webPreferences: {
        preload: path.join(__dirname, '..', options.preloadScript || 'preload.bundle.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 同源策略是 XSS 后窃取本地文件/跨域读内网的核心防线，仅未打包的开发环境关闭
        webSecurity: !app.isPackaged && process.env.NODE_ENV === 'development' ? false : true,
      },
    });

    // 禁止整页导航到外部站点、拒绝应用内开窗（http(s) 外链转系统浏览器）
    installWindowGuards(window);

    // preload 抛错或渲染进程退出时页面会缺少 window.nomiTransport 而表现为空白窗口；
    // 记到主进程日志里，便于定位（例如 E6 在全新 userData 首启时偶发的空白窗口）
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      this.logger.error(`[${type}] preload 脚本执行失败`, {
        preloadPath,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    });
    if (perfEnabled) {
      window.webContents.once('did-finish-load', () => perfMark(`${type}-did-finish-load`));
      window.webContents.on('console-message', (e: unknown) => {
        const m = (e as { message?: string }).message ?? '';
        const hit = /^\[perf\] (\S+)/.exec(m);
        if (hit) perfMark(`${type}:${hit[1]}`);
      });
    }

    // 「页面加载完但 preload 没跑」的空白窗口：探测 + 自动恢复（见 utils/preloadGuard.ts）
    installPreloadGuard(window.webContents, {
      label: type,
      globals: ['nomiTransport', 'nomiHost'],
      logger: this.logger,
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.logger.error(`[${type}] 渲染进程退出`, { ...details });
    });

    // 通用窗口事件
    window.once('ready-to-show', () => {
      perfMark(`${type}-shown`);
      // 看板娘已关闭：窗口保持隐藏（已静音），设置里重新打开时再显示
      const keepHidden = type === 'main' && this.mascotHidden();
      if (keepHidden) this.logger.info('看板娘已关闭，窗口保持隐藏');
      else if (options.showInactive) window.showInactive();
      else window.show();
      if (type === 'main' && process.platform === 'win32') {
        setWindowBounds(window, {
          x: options.x!,
          y: options.y!,
          width: options.width!,
          height: options.height!,
        });
      }

      // 开发环境打开开发者工具
      if (isDevMode()) {
        window.webContents.openDevTools({ mode: 'detach' });
      }

      eventBus.emit(`window:${type}:ready`, window);
    });

    window.on('closed', () => {
      if (type === 'main') {
        this.mainWindow = null;
      } else if (type === 'aiChat') {
        this.aiChatWindow = null;
      }
      eventBus.emit(`window:${type}:closed`);
    });

    return window;
  }

  /**
   * 设置主窗口事件监听
   */
  private setupMainWindowEvents(window: BrowserWindow): void {
    // 鼠标位置检查
    this.setupMousePositionTracking(window);

    // 窗口移动事件：物理 / 拖拽时每秒会移动很多次，防抖后再落盘
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    onGeometryChange(window, () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (window.isDestroyed()) return;
        const position = window.getPosition();
        this.configService.set('windowPosition.x', position[0]);
        this.configService.set('windowPosition.y', position[1]);
        this.configService.save().catch((error) => {
          this.logger.error('保存窗口位置失败', { error: error.message });
        });
      }, 800);
    });

    // 桌面互动：点击穿透 / 拖拽 / 重力 / 漫步 / 全局光标
    this.mascotController?.dispose();
    let scaleSaveTimer: ReturnType<typeof setTimeout> | null = null;
    this.mascotController = new MascotWindowController(window, this.logger, Math.random, {
      get: () => this.configService.getConfig().mascotScale,
      save: (scale) => {
        // 滚轮缩放时每秒很多次：防抖后连同新位置（脚底中心不动，左上角会变）一起落盘
        this.configService.set('mascotScale', scale);
        if (scaleSaveTimer) clearTimeout(scaleSaveTimer);
        scaleSaveTimer = setTimeout(() => {
          if (window.isDestroyed()) return;
          const [px, py] = window.getPosition();
          this.configService.set('windowPosition.x', px);
          this.configService.set('windowPosition.y', py);
          this.configService.save().catch((error) => {
            this.logger.error('保存看板娘大小失败', { error: error.message });
          });
        }, 400);
      },
    });
    this.mascotController.start();

    // 窗口关闭事件
    window.on('close', () => {
      eventBus.emit('app:quit');
    });
  }

  /**
   * 设置AI对话窗口事件监听
   */
  private setupAiChatWindowEvents(window: BrowserWindow): void {
    window.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      this.logger.error('AI对话窗口加载失败', { errorCode, errorDescription });
    });

    window.webContents.on('did-finish-load', () => {
      this.logger.info('AI对话窗口内容加载完成');
    });

    // 记住位置与大小：移动 / 缩放停下来后、关闭时各存一次（最大化时存的是还原后的大小）
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    const saveBounds = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
      const b = window.getNormalBounds();
      this.configService.set('chatWindowBounds', {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        ...(window.isMaximized() ? { maximized: true } : {}),
      });
      this.configService.save().catch((error) => {
        this.logger.warn('保存对话窗口大小失败', { error: String(error) });
      });
    };
    const saveSoon = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveBounds, 500);
    };
    // Linux 没有 moved / resized，改听连续的 move / resize（saveSoon 自带防抖）
    onGeometryChange(window, saveSoon, { resize: true });
    window.on('maximize', saveSoon);
    window.on('unmaximize', saveSoon);
    window.on('close', saveBounds);

    window.on('closed', () => {
      if (saveTimer) clearTimeout(saveTimer);
      this.aiChatWindow = null;
      this.logger.info('AI对话窗口已关闭');
      // 「关闭主界面时：退出 Nomi」：走统一退出流程（看板娘、托盘、后台服务一起收尾）
      if (this.shouldQuitOnChatClose()) {
        this.logger.info('关闭主界面 → 退出 Nomi');
        eventBus.emit('app:quit');
      }
    });
  }

  /**
   * 设置鼠标位置追踪
   */
  private setupMousePositionTracking(window: BrowserWindow): void {
    let mouseInWindow = false;

    const checkMousePosition = () => {
      if (!window || window.isDestroyed()) return;

      try {
        const cursorPos = screen.getCursorScreenPoint();
        const windowBounds = window.getBounds();

        const isInWindow =
          cursorPos.x >= windowBounds.x &&
          cursorPos.x <= windowBounds.x + windowBounds.width &&
          cursorPos.y >= windowBounds.y &&
          cursorPos.y <= windowBounds.y + windowBounds.height;

        if (isInWindow !== mouseInWindow) {
          mouseInWindow = isInWindow;
          const eventName = isInWindow ? 'window-mouse-enter' : 'window-mouse-leave';
          // 事件桥转成契约事件 window.mouseEnter / mouseLeave
          this.events?.publish(eventName, null, { surface: 'mascot' });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error('检查鼠标位置时出错', { error: errorMessage });
      }
    };

    const mouseCheckInterval = setInterval(checkMousePosition, 100);

    window.on('closed', () => {
      clearInterval(mouseCheckInterval);
    });
  }

  /**
   * 加载主窗口内容
   */
  private async loadMainWindowContent(window: BrowserWindow): Promise<void> {
    const isDev = isDevMode();
    let startUrl: string;

    if (isDev) {
      startUrl = devRendererUrl();
    } else {
      // 生产环境路径处理
      const rendererPath = this.getRendererPath();
      // pathToFileURL：Windows 下 `file://C:\...` 会被当成主机名，必须生成 file:///C:/...
      startUrl = url.pathToFileURL(rendererPath).href;
    }

    await window.loadURL(startUrl);
  }

  /**
   * 加载AI对话窗口内容
   */
  private async loadAiChatWindowContent(window: BrowserWindow): Promise<void> {
    const isDev = isDevMode();

    if (isDev) {
      const devUrl = devChatUrl();
      await window.loadURL(devUrl);
    } else {
      const aiChatPath = this.getAiChatPath();
      this.logger.info('AI对话窗口加载路径', { path: aiChatPath });
      await window.loadFile(aiChatPath);
    }
  }

  /**
   * 获取 AI 对话窗口页面路径（生产环境）
   *
   * - 打包后：electron-builder 的 extraResources 把 ../ai-chat/dist 放到 resources/ai-chat
   * - 本地未打包：scripts/copy-renderer.js 把 ai-chat/dist 复制到 dist/ai-chat
   */
  private getAiChatPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'ai-chat', 'index.html');
    }
    return path.join(app.getAppPath(), 'dist', 'ai-chat', 'index.html');
  }

  /**
   * 获取渲染器路径
   */
  private getRendererPath(): string {
    const isDev = isDevMode();
    const isDebugBuild = process.env.DEBUG === 'true';

    if (isDev) {
      // 开发环境
      return devRendererUrl();
    }

    if (app.isPackaged) {
      if (isDebugBuild) {
        // Debug构建：asar被禁用，文件在Resources目录下
        return path.join(process.resourcesPath, 'renderer', 'index.html');
      } else {
        // 生产构建：文件在asar中
        return path.join(process.resourcesPath, 'renderer', 'index.html');
      }
    }

    // 本地构建
    return path.join(app.getAppPath(), 'dist', 'renderer', 'index.html');
  }
}
