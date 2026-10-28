/**
 * Electron 宿主的组合根（docs/design/core-host-decoupling.md §7.1）。
 *
 * 内核（`@nomi-ai/core/createCore`）建服务、AI runtime、应用契约的 router 与事件总线；这里只做宿主的事：
 * - 创建 Electron 端口（`host/electronPorts.ts`）与日志，调用 `createCore`；
 * - 宿主钩子：看板娘 / 对话窗口、灵动岛、自动更新（electron-updater）、受控浏览器、`character-pack://`
 *   协议、系统 TTS 与用户画像存储插件（`bundle-ig-electron-caps`）；
 * - 契约的宿主片段（`host/contract`：看板娘窗口、灵动岛、旧窗口通道、应用图标），挂 IPC 传输；
 * - 窗口、托盘、协议（`chat-asset://`）、CSP、会话权限、应用事件（激活、退出）与进程信号。
 */

import path from 'node:path';

import { FileSessionStorePlugin } from '@nomi-ai/bundle-ig-electron-caps';
import { builtinPackDir } from '@nomi-ai/core/character/packResolve';
import { BootstrapManager } from '@nomi-ai/core/core/BootstrapManager';
import { createShutdown, LifecycleRegistry } from '@nomi-ai/core/core/lifecycle';
import type { IServiceContainer } from '@nomi-ai/core/core/ServiceContainer';
import { createCore, type Core } from '@nomi-ai/core/createCore';
import { LoggerService, LogLevel } from '@nomi-ai/core/services/LoggerService';
import type { UpdaterLike } from '@nomi-ai/core/services/UpdateService';
import {
  openAfterReady,
  planStartup,
  shouldQuitOnMainClose,
  shouldRaiseMainOnReactivate,
  type StartupPlan,
} from '@nomi-ai/core/startup/startupPlan';
import type { HostPorts } from '@nomi-ai/host-ports';
import { app, protocol, session } from 'electron';
import { autoUpdater } from 'electron-updater';

import { TtsElectronNativeProvider } from '../ai/TtsElectronNativeProvider';
import { getChatBackgroundPresetFile } from '../chat/backgroundPreset';
import { initAppIcon } from '../core/appIcon';
import { applyTitleBarTheme } from '../core/titleBar';
import { TrayManager } from '../core/TrayManager';
import { WindowManager } from '../core/WindowManager';
import { IslandService } from '../island/IslandService';
import { appCspString } from '../security/csp';
import { AdvancedTTSEngine } from '../services/AdvancedTTSEngine';
import { GlobalErrorHandler } from '../utils/ErrorHandler';
import { perfMark } from '../utils/perfMarks';

import { AgentBrowser } from './AgentBrowser';
import { registerChatAssetProtocol } from './assetProtocol';
import { createHostHandlers, electronCallerWindows } from './contract';
import { serveContractOverIpc } from './contractIpc';
import { createElectronPorts, lazyWindowHost } from './electronPorts';
import { countLiveWindows } from './liveWindows';
import { MascotWindowActions } from './mascotWindowActions';
import { serveNomiHostIpc } from './nomiHostIpc';

/** stop() 的总超时：超过后放弃等待，直接退出 */
export const STOP_TIMEOUT_MS = 5000;

export interface IApplication {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getServiceContainer(): IServiceContainer;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * 这个构建带的内置角色包目录（§10、§12）：打包后是 `resources/renderer/character`；未打包时是
 * `dist/renderer/character`（copy-renderer）或仓库里的包（开发态按 `CHARACTER_PACK`，缺省 `characters/nomi`）。
 * 环境变量只在宿主读一次，经 `createCore` 的选项交给内核。找不到时为 null（内核记 warn，人设为中性）。
 */
function bundledCharacterPack(ports: HostPorts): string | null {
  const packaged = ports.app.isPackaged();
  return builtinPackDir({
    packaged,
    dev: !packaged && process.env.NODE_ENV === 'development',
    resourcesPath: ports.paths.resources(),
    appPath: ports.paths.appPath(),
    characterPack: process.env.CHARACTER_PACK,
  });
}

export class Application implements IApplication {
  /** 宿主端口：窗口相关的部分每次调用时才找 WindowManager，所以先于窗口管理器创建也没问题 */
  private readonly ports: HostPorts;
  private readonly logger: LoggerService;
  private readonly core: Core;
  private readonly windowManager: WindowManager;
  private readonly bootstrapManager: BootstrapManager;
  /** 进程级的错误处理（uncaughtException 等）：一个进程只装一次，不属于内核 */
  private readonly errorHandler: GlobalErrorHandler;
  private windowActions?: MascotWindowActions;
  private island?: IslandService;
  private trayManager?: TrayManager;
  /** start() 走完后才为 true：之前的 macOS activate 等事件不应触发「打开主界面」 */
  private launched = false;
  private isInitialized = false;
  /** 宿主自己的资源（IPC 传输、拖入文件通道），退出时先于内核停止 */
  private readonly lifecycle = new LifecycleRegistry();
  /** 统一退出：stop() 重入守卫 + 5s 超时；before-quit / 信号共用 requestQuit()（stop → app.exit(0)） */
  private readonly shutdown = createShutdown({
    work: () => this.doStop(),
    timeoutMs: STOP_TIMEOUT_MS,
    exit: () => app.exit(0),
    onTimeout: () =>
      this.logger?.warn('停止应用超时，强制继续退出', { timeoutMs: STOP_TIMEOUT_MS }),
  });

  constructor() {
    // 宿主端口最先创建（日志目录来自 ports.paths.logs()）；端口自己的告警经 this.logger 转发
    this.ports = createElectronPorts({
      windows: lazyWindowHost(() => this.windowManager),
      logger: { warn: (message, meta) => this.logger?.warn(message, meta) },
    });
    this.logger = new LoggerService({ ports: this.ports });
    this.core = createCore({
      ports: this.ports,
      logger: this.logger,
      config: {
        chatBackgroundPresetFile: getChatBackgroundPresetFile(
          this.ports.app.isPackaged(),
          this.ports.paths.resources(),
        ),
        // 内置角色包：打包进来的那个（开发态按构建时的 CHARACTER_PACK 从仓库读）
        builtinCharacterPack: bundledCharacterPack(this.ports),
      },
      host: {
        // Auto-update (electron-updater → GitHub Releases). Packaged builds only.
        updater: autoUpdater as unknown as UpdaterLike,
        browser: () => new AgentBrowser(),
        // 角色包的 character-pack:// 协议注册在宿主（内核只认结构类型）
        characterPackProtocol: protocol,
        desktopWindows: {
          main: () => this.windowManager.getMainWindow(),
          openChat: () => this.windowManager.createAiChatWindow(),
          mascotHidden: () => this.windowManager.mascotHidden(),
          island: (n) => this.island?.notify(n) ?? false,
        },
        voiceChatWindow: () => this.windowManager.createAiChatWindow(),
        liveWindows: countLiveWindows,
        callerWindows: electronCallerWindows(() => this.windowManager),
        // FileSessionStorePlugin 提供 ProfileStorageKey → 用户画像持久化到 userData/ai-chat/memory
        aiPlugins: () => [
          { plugin: FileSessionStorePlugin, config: { rootDir: this.ports.paths.userData() } },
        ],
        // 系统 TTS（say / PowerShell / espeak）注册为 electron-native TtsProvider
        ttsProviders: () => [
          new TtsElectronNativeProvider({ engine: new AdvancedTTSEngine(this.core.i18n.t) }),
        ],
      },
      contract: {
        hostHandlers: () =>
          createHostHandlers({
            windowManager: () => this.windowManager,
            windowActions: () => this.windowActions,
            island: () => this.island,
          }),
      },
    });
    this.errorHandler = new GlobalErrorHandler(this.logger, this.ports, this.core.i18n.t);
    this.windowManager = new WindowManager(this.logger, this.core.config, this.core.events);
    this.bootstrapManager = new BootstrapManager(this.logger);
  }

  /**
   * 初始化应用（app ready 之前）：应用事件、进程信号与低优先级的启动任务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    try {
      if (process.env.NODE_ENV === 'development') this.logger.setLevel(LogLevel.DEBUG);
      this.logger.info('开始初始化应用...');
      this.setupBootstrapTasks();
      const metrics = await this.bootstrapManager.start();
      this.logger.info('启动任务执行完成', {
        duration: metrics.totalDuration,
        taskCount: metrics.taskMetrics.length,
      });
      this.isInitialized = true;
      this.logger.info('应用初始化完成');
    } catch (error) {
      this.logger.error('应用初始化失败', { error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    if (!this.isInitialized) await this.initialize();

    try {
      this.logger.info('启动应用...');

      // 等待Electron app ready事件
      await app.whenReady();
      perfMark('app-ready');

      // 应用图标变体（窗口 / 任务栏 / Dock / 托盘 / 通知）
      initAppIcon(path.join(this.ports.paths.userData(), 'app-icon.json'));

      // 统一 CSP 响应头：作用于 http(s) 加载的页面。打包后的 file:// 页面不经过响应头，
      // 由构建期注入的 <meta> CSP 覆盖（renderer / ai-chat 的 vite 配置）；dev HMR 需要内联脚本，跳过。
      // 沙箱浏览器 AgentBrowser 使用独立内存分区，不受影响。
      if (app.isPackaged || process.env.NODE_ENV !== 'development') {
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              'Content-Security-Policy': [appCspString()],
            },
          });
        });
      }
      this.logger.info('Electron应用准备就绪');

      // 会话消息中的 Markdown 图片本地协议：chat-asset:// → userData/chat/images/<rel>
      registerChatAssetProtocol(this.ports);

      // 内核：配置、界面语言、角色包与人设、各业务服务、AI runtime、应用契约（窗口创建之前）
      await this.core.start();
      perfMark('ai-runtime-ready');
      const services = this.core.services;
      this.windowActions = new MascotWindowActions(this.logger, this.windowManager);

      // 编程助手进度 / 提醒的灵动岛式通知（macOS 刘海 / 顶部胶囊；免打扰时段内不弹）
      this.island = new IslandService({
        file: path.join(this.ports.paths.userData(), 'island.json'),
        t: this.core.i18n.t,
        isQuiet: () => services.sched?.isQuiet() ?? false,
        openChat: () => void this.windowManager.createAiChatWindow(),
        logger: this.logger as never,
      });

      // 应用契约（AI 门面 + 各域 + 宿主片段）经 window.nomiTransport 暴露给视图；窗口导航 / 销毁时
      // 传输层断开该窗口的会话（host/contractIpc.ts）
      this.serveContract();
      // 拖到看板娘身上的文件：preload 从真实 File 取路径后经专用通道直接提交（不经契约，视图选不了路径）
      const desktop = services.desktop;
      if (desktop) {
        const stopNomiHost = serveNomiHostIpc({ dropFile: (id, p) => desktop.dropFile(id, p) });
        this.lifecycle.register({ name: 'nomi-host-ipc', stop: stopNomiHost });
      }

      const startupPlan = this.wireWindowsToCore();
      this.setupPermissions();

      // 默认界面为「软件主界面」：对话窗口与看板娘窗口并行创建 / 加载，不再排在看板娘页面加载之后；
      // 看板娘以 showInactive 出现，不会从主界面抢走焦点。失败只记日志，仍可用看板娘
      if (startupPlan.openMain && startupPlan.delayMs === 0) this.openMainInterface(startupPlan);

      // 创建看板娘窗口（始终创建：定时任务 / 提醒 / 编程助手进度都靠它播报；
      // 默认界面为「软件主界面」时它不抢焦点）
      await this.windowManager.createMainWindow({ activate: startupPlan.activateMascot });
      // 提醒调度与定时任务：主窗口创建后开始（错过的提醒要在看板娘气泡里播报）
      this.core.startReminders();

      // 托盘：一键切换 AI provider
      this.startTray();

      this.launched = true;
      this.logger.info('应用启动完成');
    } catch (error) {
      this.logger.error('应用启动失败', { error: errorMessage(error) });
      throw error;
    }
  }

  /**
   * 把内核的偏好接到窗口：主题 → 标题栏，启动偏好 → 看板娘显隐与关闭主界面的行为；返回启动计划。
   */
  private wireWindowsToCore(): StartupPlan {
    const { theme, startup, onboarding } = this.core.services;

    // 对话窗口一体化标题栏跟随主题（窗口底色 + Windows / Linux 原生按钮配色）
    if (theme) {
      this.windowManager.chromeTheme = () => theme.get().resolved;
      theme.onChange((st) => {
        const w = this.windowManager.getAiChatWindow();
        if (w) applyTitleBarTheme(w, st.resolved);
      });
    }

    if (startup) {
      // 看板娘显示开关（工具栏「关闭看板娘」/ 设置里重新打开）：立即显隐，隐藏时静音
      this.windowManager.mascotHidden = () => !startup.get().showMascot;
      let showMascot = startup.get().showMascot;
      startup.onChange((st) => {
        if (st.showMascot === showMascot) return;
        showMascot = st.showMascot;
        this.windowManager.setMascotVisible(showMascot);
        // 关掉看板娘后保证主界面可达（#55）：主界面没开 / 被藏起时把它打开，避免进入无界面状态
        if (!showMascot && this.launched) {
          const chat = this.windowManager.getAiChatWindow();
          if (!chat || chat.isDestroyed() || !chat.isVisible()) this.openMainInterface();
        }
      });
      // 关闭主界面时：quit → 完全退出（看板娘、托盘一起）；hide（默认）→ 只关窗口
      this.windowManager.shouldQuitOnChatClose = () =>
        shouldQuitOnMainClose(startup.get().closeMain, this.shutdown.isQuitting());
    }

    // 启动后默认界面（看板娘 / 软件主界面）：设置与引导里都能改，默认看板娘（历史行为）
    const plan = planStartup({
      defaultView: startup?.get().defaultView ?? 'mascot',
      onboardingPending: onboarding?.shouldAutoOpen() ?? false,
    });
    if (plan.openMain && plan.delayMs > 0) {
      // 首次引导：等看板娘窗口先出来，再打开引导（她会在引导中打招呼）。契约此时已挂上 IPC
      openAfterReady(
        Promise.resolve(),
        plan.delayMs,
        () => void this.windowManager.createAiChatWindow(),
      );
    }
    return plan;
  }

  /** 挂 IPC 传输；视图的第一批调用不能早于它（窗口在它之后才创建） */
  private serveContract(): void {
    const ipc = serveContractOverIpc({
      router: this.core.router,
      logger: { warn: (msg, data) => this.logger.warn(msg, data as Record<string, unknown>) },
    });
    this.lifecycle.register({ name: 'contract-ipc', stop: () => ipc.stop() });
  }

  /**
   * 麦克风：只允许本应用窗口申请「音频」采集（不允许摄像头 / 屏幕）；
   * 剪贴板只放行写入（复制按钮用 navigator.clipboard.writeText），读取仍拒绝；
   * 其余权限（geolocation / notifications / HID / MIDI / pointerLock 等）一律拒绝。
   */
  private setupPermissions(): void {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission === 'clipboard-sanitized-write') {
        callback(true);
        return;
      }
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        callback(types.length > 0 && types.every((t) => t === 'audio'));
        return;
      }
      callback(false);
    });
    // 权限检查（持久化授权查询等）同样默认拒绝，媒体与剪贴板写入例外
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return permission === 'media' || permission === 'clipboard-sanitized-write';
    });
  }

  private openMainInterface(plan?: Pick<StartupPlan, 'activateMain'>): void {
    this.windowManager
      .createAiChatWindow({ activate: plan?.activateMain ?? true })
      .catch((error) =>
        this.logger.warn('启动时打开主界面失败，保留看板娘', { error: errorMessage(error) }),
      );
  }

  /**
   * 已运行实例被再次唤起（第二实例 / macOS Dock / Windows 托盘左键）：
   * 默认界面为「软件主界面」时把主界面带到前台，返回 true；否则返回 false，调用方保持历史行为。
   */
  raiseMainOnReactivate(): boolean {
    const startup = this.core.services.startup;
    if (!this.launched || !startup) return false;
    if (!shouldRaiseMainOnReactivate(startup.get().defaultView)) return false;
    this.openMainInterface();
    return true;
  }

  /** 系统托盘（provider 快速切换）；失败不影响启动。 */
  private startTray(): void {
    const providers = this.core.services.aiRuntime?.providers;
    if (!providers || this.trayManager) return;
    const gateway = this.core.services.gateway;
    this.trayManager = new TrayManager({
      providers,
      characterName: () => {
        const p = this.core.services.persona?.get();
        return p?.shortName || p?.displayName;
      },
      onCharacterChange: (fn) => this.core.services.persona?.onChange(() => fn()) ?? (() => {}),
      models: gateway
        ? {
            state: () => gateway.state(),
            select: (ref) => gateway.setAssignment('nomi', { models: { main: ref } }),
            onChange: (fn) => gateway.onChange(fn),
          }
        : undefined,
      i18n: this.core.i18n,
      logger: this.logger,
      events: this.core.events,
      openChat: () => {
        void this.windowManager.createAiChatWindow();
      },
      openProviderPanel: () => {
        void this.windowManager.openProviderPanel();
      },
      openDesktopPanel: () => {
        void this.windowManager.openProviderPanel('nav.desktopPanelRequested');
      },
      onActivate: () => this.raiseMainOnReactivate(),
      quit: () => app.quit(),
    });
    this.trayManager.start();
    // 兜底：应用被激活 / 窗口获得焦点时，如果托盘已被销毁就重建
    const heal = () => this.trayManager?.ensureAlive();
    app.on('activate', heal);
    app.on('browser-window-focus', heal);
  }

  /**
   * 停止应用。重入安全（并发 / 重复调用共用同一次执行），并带 5s 超时兜底：
   * 某个服务卡住时放弃等待，不让退出被无限拖住。
   */
  stop(): Promise<void> {
    return this.shutdown.stop();
  }

  private async doStop(): Promise<void> {
    try {
      this.logger.info('停止应用...');
      this.trayManager?.dispose();
      this.trayManager = undefined;
      this.island?.destroy();
      // 先断开传输（视图的调用不再进来），再停内核（后台服务、AI runtime、配置落盘）
      await this.lifecycle.stopAll(this.logger);
      await this.core.stop();
      this.windowManager.closeAllWindows();
      this.logger.info('应用已停止');
    } catch (error) {
      this.logger.error('应用停止失败', { error: errorMessage(error) });
      throw error;
    }
  }

  /** 内核的服务容器（端口、事件、日志、配置） */
  getServiceContainer(): IServiceContainer {
    return this.core.container;
  }

  /**
   * 设置启动任务（app ready 之前）；配置加载、朗读配置与旧配置清理在内核的 start() 里
   */
  private setupBootstrapTasks(): void {
    // 关键任务：应用事件设置
    this.bootstrapManager.addTask({
      name: 'setup-app-events',
      priority: 'critical',
      execute: async () => {
        this.setupAppEvents();
      },
    });

    // 高优先级任务：进程信号处理
    this.bootstrapManager.addTask({
      name: 'setup-process-handlers',
      priority: 'high',
      execute: async () => {
        this.setupProcessHandlers();
      },
    });

    // 低优先级任务：日志清理
    this.bootstrapManager.addTask({
      name: 'cleanup-old-logs',
      priority: 'low',
      delay: 1000,
      execute: async () => {
        try {
          this.logger.cleanOldLogs(7); // 清理7天前的日志
        } catch (error) {
          this.logger.warn('清理旧日志失败', { error: errorMessage(error) });
        }
      },
    });

    // 低优先级任务：系统信息收集
    this.bootstrapManager.addTask({
      name: 'collect-system-info',
      priority: 'low',
      delay: 2000,
      execute: async () => {
        const systemInfo = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          memory: process.memoryUsage(),
        };
        this.logger.info('系统信息', systemInfo);
      },
    });
  }

  /**
   * 设置应用事件
   */
  private setupAppEvents(): void {
    // 所有窗口关闭
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    // 应用激活（macOS 首次启动也会触发：start() 走完之前看板娘窗口由 start() 自己创建，配置那时才加载）
    app.on('activate', async () => {
      if (!this.launched) return;
      if (this.windowManager.getMainWindow() === null) {
        await this.windowManager.createMainWindow();
      }
      // 默认界面为「软件主界面」时，点 Dock 图标回到主界面
      this.raiseMainOnReactivate();
    });

    // 应用退出前：必须同步 preventDefault，等 stop() 真正完成后再 app.exit(0)；
    // 否则 async 监听器返回后 Electron 立刻退出，子进程 / 端口 / 配置保存都来不及收尾。
    // app.exit() 不会再触发 before-quit，因此不会循环。
    app.on('before-quit', (event) => {
      event.preventDefault();
      this.shutdown.requestQuit();
    });
  }

  /**
   * 设置进程信号处理
   */
  private setupProcessHandlers(): void {
    // 处理未捕获的异常
    process.on('uncaughtException', (error) => {
      this.logger.error('未捕获的异常', { error: error.message, stack: error.stack });
      // 在生产环境中，可能需要重启应用
      if (process.env.NODE_ENV === 'production') {
        app.quit();
      }
    });

    // 处理未处理的Promise拒绝
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('未处理的Promise拒绝', { reason, promise });
    });

    // 优雅关闭：信号注册只在这里一处（main.ts 不再注册），与 before-quit 共用同一条退出路径
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => {
        this.logger.info(`收到${sig}信号，开始优雅关闭...`);
        this.shutdown.requestQuit();
      });
    }
  }

  /**
   * 获取应用状态
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      launched: this.launched,
      mainWindow: !!this.windowManager.getMainWindow(),
      aiChatWindow: !!this.windowManager.getAiChatWindow(),
      config: this.core.config.getConfig(),
      bootstrap: {
        taskStatus: this.bootstrapManager.getTaskStatus(),
        performanceReport: this.bootstrapManager.getPerformanceReport(),
      },
    };
  }
}
