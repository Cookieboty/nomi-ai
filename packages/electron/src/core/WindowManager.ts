/**
 * 窗口管理器 - 统一管理所有窗口的创建、销毁和状态
 */

import * as path from 'path';
import * as url from 'url';

import { BrowserWindow, screen, app, type BrowserWindowConstructorOptions } from 'electron';

import { t } from '../i18n';
import { fitMascotScale, maxScaleForArea, mascotWindowSize } from '../mascot/mascotSize';
import { MascotWindowController } from '../mascot/MascotWindowController';
import { installWindowGuards } from '../security/windowGuards';
import { type IConfigService } from '../services/ConfigService';
import { type ILoggerService } from '../services/LoggerService';
import { perfEnabled, perfMark } from '../utils/perfMarks';
import { installPreloadGuard } from '../utils/preloadGuard';

import { windowIconPath } from './appIcon';
import { devChatUrl, devRendererUrl } from './devPorts';
import { eventBus } from './EventBus';
import { type ChromeTheme, titleBarOptions } from './titleBar';

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
  title?: string;
  preloadScript?: string;
  /** 额外的 BrowserWindow 选项（标题栏样式等） */
  chrome?: Partial<BrowserWindowConstructorOptions>;
}

export interface IWindowManager {
  createMainWindow(): Promise<BrowserWindow>;
  createAiChatWindow(): Promise<BrowserWindow>;
  createTTSConfigWindow(): Promise<BrowserWindow>;
  getMainWindow(): BrowserWindow | null;
  getAiChatWindow(): BrowserWindow | null;
  getTTSConfigWindow(): BrowserWindow | null;
  closeAllWindows(): void;
  setAlwaysOnTop(windowType: 'main' | 'aiChat' | 'ttsConfig', flag: boolean): void;
}

export class WindowManager implements IWindowManager {
  /** 当前主题（Application 注入，决定对话窗口标题栏配色） */
  chromeTheme: () => ChromeTheme = () => 'ink';
  private mainWindow: BrowserWindow | null = null;
  private aiChatWindow: BrowserWindow | null = null;
  /** 正在创建中的 AI 对话窗口（并发 createAiChatWindow 共用） */
  private aiChatWindowPromise?: Promise<BrowserWindow>;
  private ttsConfigWindow: BrowserWindow | null = null;
  private logger: ILoggerService;
  private configService: IConfigService;

  constructor(logger: ILoggerService, configService: IConfigService) {
    this.logger = logger;
    this.configService = configService;
  }

  /**
   * 创建主窗口
   */
  async createMainWindow(): Promise<BrowserWindow> {
    if (this.mainWindow) {
      this.mainWindow.focus();
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
        preloadScript: 'preload.bundle.js',
      };

      this.mainWindow = await this.createWindow(windowOptions, 'main');

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
  async createAiChatWindow(): Promise<BrowserWindow> {
    if (this.aiChatWindow) {
      this.aiChatWindow.focus();
      this.aiChatWindow.show();
      return this.aiChatWindow;
    }
    // 创建过程是异步的（await createWindow / 加载页面）：并发调用共用同一次创建，避免开出两个窗口
    this.aiChatWindowPromise ??= this.buildAiChatWindow().finally(() => {
      this.aiChatWindowPromise = undefined;
    });
    return this.aiChatWindowPromise;
  }

  private async buildAiChatWindow(): Promise<BrowserWindow> {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

      // 设置是全窗布局，给足空间；小屏按工作区收缩
      const windowWidth = Math.min(1120, screenWidth - 40);
      const windowHeight = Math.min(820, screenHeight - 40);
      const x = Math.round((screenWidth - windowWidth) / 2);
      const y = Math.round((screenHeight - windowHeight) / 2);

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
        title: 'Nomi',
        preloadScript: 'ai-chat-preload.bundle.js',
        chrome: {
          ...titleBarOptions(process.platform, this.chromeTheme()),
          minWidth: 760,
          minHeight: 560,
        },
      };

      this.aiChatWindow = await this.createWindow(windowOptions, 'aiChat');

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
   * 打开 AI 对话窗口并弹出 Provider 配置面板（托盘 / 菜单入口）。
   */
  async openProviderPanel(channel = 'ai:providers:open-panel'): Promise<void> {
    const existed = Boolean(this.aiChatWindow);
    const win = await this.createAiChatWindow();
    // 新建窗口时给 React 挂载监听留一点时间
    setTimeout(
      () => {
        if (!win.isDestroyed()) win.webContents.send(channel, {});
      },
      existed ? 0 : 400,
    );
  }

  /**
   * 创建TTS配置窗口
   */
  async createTTSConfigWindow(): Promise<BrowserWindow> {
    if (this.ttsConfigWindow) {
      this.ttsConfigWindow.focus();
      this.ttsConfigWindow.show();
      return this.ttsConfigWindow;
    }

    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

      const windowWidth = 850;
      const windowHeight = 950;
      const x = Math.round((screenWidth - windowWidth) / 2);
      const y = Math.round((screenHeight - windowHeight) / 2);

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
        title: t('TTS语音配置'),
        preloadScript: 'preload.bundle.js',
      };

      this.ttsConfigWindow = await this.createWindow(windowOptions, 'ttsConfig');

      // 设置窗口事件监听
      this.setupTTSConfigWindowEvents(this.ttsConfigWindow);

      // 加载TTS配置页面
      await this.loadTTSConfigWindowContent(this.ttsConfigWindow);

      this.logger.info('TTS配置窗口创建成功');
      eventBus.emit('window:ttsConfig:created', this.ttsConfigWindow);

      return this.ttsConfigWindow;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('TTS配置窗口创建失败', { error: errorMessage });
      throw error;
    }
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
   * 获取TTS配置窗口
   */
  getTTSConfigWindow(): BrowserWindow | null {
    return this.ttsConfigWindow;
  }

  /**
   * 关闭所有窗口
   */
  closeAllWindows(): void {
    if (this.ttsConfigWindow) {
      this.ttsConfigWindow.close();
    }
    if (this.aiChatWindow) {
      this.aiChatWindow.close();
    }
    if (this.mainWindow) {
      this.mainWindow.close();
    }
  }

  /**
   * 设置窗口置顶状态
   */
  setAlwaysOnTop(windowType: 'main' | 'aiChat' | 'ttsConfig', flag: boolean): void {
    let window: BrowserWindow | null = null;
    switch (windowType) {
      case 'main':
        window = this.mainWindow;
        break;
      case 'aiChat':
        window = this.aiChatWindow;
        break;
      case 'ttsConfig':
        window = this.ttsConfigWindow;
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
      hasShadow: false,
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

    // preload 抛错或渲染进程退出时 renderer 会缺少 window.electronAPI 而表现为空白窗口；
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
      globals: ['electronAPI', 'aiIPC'],
      logger: this.logger,
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.logger.error(`[${type}] 渲染进程退出`, { ...details });
    });

    // 通用窗口事件
    window.once('ready-to-show', () => {
      perfMark(`${type}-shown`);
      window.show();

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
    window.on('moved', () => {
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
      changed: (state) => {
        const chat = this.aiChatWindow;
        if (chat && !chat.isDestroyed()) chat.webContents.send('mascot:scale-changed', state);
      },
      trusted: (sender) =>
        sender === window.webContents ||
        (!!this.aiChatWindow &&
          !this.aiChatWindow.isDestroyed() &&
          sender === this.aiChatWindow.webContents),
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

    window.on('closed', () => {
      this.aiChatWindow = null;
      this.logger.info('AI对话窗口已关闭');
    });
  }

  /**
   * 设置TTS配置窗口事件监听
   */
  private setupTTSConfigWindowEvents(window: BrowserWindow): void {
    window.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      this.logger.error('TTS配置窗口加载失败', { errorCode, errorDescription });
    });

    window.webContents.on('did-finish-load', () => {
      this.logger.info('TTS配置窗口内容加载完成');
    });

    window.on('closed', () => {
      this.ttsConfigWindow = null;
      this.logger.info('TTS配置窗口已关闭');
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
          window.webContents.send(eventName);
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

  /** 用对话页的某个 hash 路由加载任意窗口（例如截图遮罩 #snip） */
  async loadChatRoute(window: BrowserWindow, hash: string): Promise<void> {
    if (isDevMode()) await window.loadURL(`${devChatUrl()}#${hash}`);
    else await window.loadFile(this.getAiChatPath(), { hash });
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
   * 加载TTS配置窗口内容
   */
  private async loadTTSConfigWindowContent(window: BrowserWindow): Promise<void> {
    const isDev = isDevMode();

    try {
      if (isDev) {
        // 开发环境：由 renderer 的 vite dev server 提供（多页面入口）
        const devUrl = devRendererUrl('/tts-config.html');
        this.logger.info('TTS配置窗口加载地址', { url: devUrl });
        await window.loadURL(devUrl);
      } else {
        // 生产：页面由 renderer 的 vite 构建输出（renderer/dist/tts-config.html）
        // 打包后在 resources/renderer/ 下；未打包运行时用 copy-renderer 复制的 dist/renderer/
        const ttsConfigPath = app.isPackaged
          ? path.join(process.resourcesPath, 'renderer', 'tts-config.html')
          : path.join(app.getAppPath(), 'dist', 'renderer', 'tts-config.html');
        this.logger.info('TTS配置窗口加载路径', { path: ttsConfigPath });
        await window.loadFile(ttsConfigPath);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('TTS配置窗口加载失败', { error: errorMessage });
      throw error;
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
