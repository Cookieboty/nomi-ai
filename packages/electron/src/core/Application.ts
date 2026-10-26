/**
 * 应用程序主类 - 应用的核心控制器
 * 负责应用初始化、服务注册和生命周期管理
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSafeStorageCipher,
  envProviderConfig,
  findPreset,
  llmProvidersFromEnv,
  migrateStoreData,
} from '@nomi-ai/ai-runtime';
import { isBuiltinCliId } from '@nomi-ai/cli-plugins';
import type { ProviderQuirks } from '@nomi-ai/gateway';
import { app, BrowserWindow, safeStorage, session } from 'electron';

import { getAgentProgressService, initAgentProgressService } from '../agents/AgentProgressService';
import { startAIRuntime, type AIRuntimeBootHandle } from '../ai/AIRuntimeBoot';
import { ClipboardGateway } from '../ai/ClipboardGateway';
import { ScreenCapture } from '../ai/ScreenCapture';
import { TtsElectronNativeProvider } from '../ai/TtsElectronNativeProvider';
import { registerChatAssetProtocol } from '../chat/assetProtocol';
import { ChatBackgroundService } from '../chat/ChatBackgroundService';
import { AccountLogin, broadcastLogin } from '../cli/accounts/AccountLogin';
import { AccountService } from '../cli/accounts/AccountService';
import { ACCOUNT_KINDS, type AccountKind } from '../cli/accounts/types';
import { initCliHarnessService } from '../cli/CliHarnessService';
import { initCliPluginHost } from '../cli/CliPluginHost';
import { initCliUpdateService } from '../cli/CliUpdateService';
import { initDelegateService } from '../cli/delegate/DelegateService';
import { resolveCliBinAsync, readVersionAsync } from '../cli/detect';
import { cliChildEnv, isScript, spawnHarness } from '../cli/harness/spawn';
import { decryptLegacyCliKey } from '../cli/legacyCliKey';
import { initSessionHistoryService } from '../cli/SessionHistoryService';
import type { CliKind } from '../cli/types';
import { getDesktopService } from '../desktop/DesktopService';
import { DiagnosticsService } from '../diagnostics/DiagnosticsService';
import { initExtensionsService } from '../extensions/ExtensionsService';
import { getGatewayService, initGatewayService } from '../gateway/GatewayService';
import { harnessGateway } from '../gateway/harnessGateway';
import { revokeLegacyGlobalConfig, type RevokeLegacyResult } from '../gateway/revokeLegacy';
import {
  gatewayTerminalSource,
  initTerminalCommands,
  registerTerminalIpc,
} from '../gateway/TerminalCommands';
import { IpcRegistry } from '../handlers/ipc/IpcRegistry';
import { t as tr } from '../i18n';
import { LocaleService } from '../i18n';
import { getIslandService, initIslandService, notifyIsland } from '../island/IslandService';
import { initKnowledgeService } from '../knowledge/KnowledgeService';
import { getLocalHubService, initLocalHubService } from '../local/LocalHubService';
import { getLocalModelService, initLocalModelService } from '../local/LocalModelService';
import { getMemoryService, initMemoryService } from '../memory/MemoryService';
import { OnboardingService } from '../onboarding/OnboardingService';
import { getSchedulerService, initSchedulerService } from '../schedule/SchedulerService';
import { getScreenService, initScreenService } from '../screen/ScreenService';
import { appCspString } from '../security/csp';
import { AdvancedTTSEngine } from '../services/AdvancedTTSEngine';
import { CacheService } from '../services/CacheService';
import { ConfigService } from '../services/ConfigService';
import { LoggerService, LogLevel } from '../services/LoggerService';
import { getUpdateService } from '../services/UpdateService';
import {
  planStartup,
  shouldQuitOnMainClose,
  shouldRaiseMainOnReactivate,
  type StartupPlan,
} from '../startup/startupPlan';
import { StartupService } from '../startup/StartupService';
import { ThemeService } from '../theme/ThemeService';
import { registerTtsModel } from '../tts/registerTtsModel';
import {
  getGatewayRequestLog,
  initGatewayRequestLog,
  readLegacyGatewayTrace,
} from '../usage/GatewayRequestLog';
import { initQualityService } from '../usage/quality/QualityService';
import { getUsageService, initUsageService } from '../usage/UsageService';
import { GlobalErrorHandler } from '../utils/ErrorHandler';
import { perfMark } from '../utils/perfMarks';
import { getVoiceService } from '../voice/VoiceService';

import { initAppIcon } from './appIcon';
import { BootstrapManager } from './BootstrapManager';
import { eventBus } from './EventBus';
import { createShutdown, LifecycleRegistry } from './lifecycle';
import { ServiceContainer, type IServiceContainer } from './ServiceContainer';
import { applyTitleBarTheme } from './titleBar';
import { TrayManager } from './TrayManager';
import { WindowManager } from './WindowManager';

/** stop() 的总超时：超过后放弃等待，直接退出 */
export const STOP_TIMEOUT_MS = 5000;

export interface IApplication {
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getServiceContainer(): IServiceContainer;
}

/** 环境变量供应商的显示名与提供 Key 的变量名（与 ai-runtime llmProvidersFromEnv 对应） */
const ENV_PROVIDER_NAME: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  claude: 'Anthropic',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
};
const ENV_PROVIDER_KEY: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export class Application implements IApplication {
  private container: IServiceContainer;
  private logger!: LoggerService;
  private configService!: ConfigService;
  private cacheService!: CacheService;
  private windowManager!: WindowManager;
  private errorHandler!: GlobalErrorHandler;
  private ipcRegistry!: IpcRegistry;
  private bootstrapManager!: BootstrapManager;
  private aiRuntime?: AIRuntimeBootHandle;
  private clipboardGateway?: ClipboardGateway;
  private trayManager?: TrayManager;
  private startupService?: StartupService;
  /** start() 走完后才为 true：之前的 macOS activate 等事件不应触发「打开主界面」 */
  private launched = false;
  private isInitialized = false;
  /** 有后台定时器 / 子进程 / 监听端口 / worker 的服务，退出时统一 stop */
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
    this.container = new ServiceContainer();
    this.setupServices();
  }

  /**
   * 初始化应用
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // 设置开发环境日志级别
      if (process.env.NODE_ENV === 'development') {
        this.logger.setLevel(LogLevel.DEBUG);
      }

      this.logger.info('开始初始化应用...');

      // 设置启动任务
      this.setupBootstrapTasks();

      // 执行启动任务
      const metrics = await this.bootstrapManager.start();
      this.logger.info('启动任务执行完成', {
        duration: metrics.totalDuration,
        taskCount: metrics.taskMetrics.length,
      });

      this.isInitialized = true;
      this.logger.info('应用初始化完成');

      eventBus.emit('app:initialized');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('应用初始化失败', { error: errorMessage });
      throw error;
    }
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      this.logger.info('启动应用...');

      // 等待Electron app ready事件
      await app.whenReady();
      perfMark('app-ready');

      // 界面语言（默认跟随系统：zh* → 中文，其余 → English）；须早于托盘 / 通知等主进程文案
      new LocaleService(path.join(app.getPath('userData'), 'locale.json')).registerIpc();
      // 应用图标变体（窗口 / 任务栏 / Dock / 托盘 / 通知）
      initAppIcon(path.join(app.getPath('userData'), 'app-icon.json'));

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
      registerChatAssetProtocol();

      // Auto-update (electron-updater → GitHub Releases). Packaged builds only.
      const updates = getUpdateService(this.logger);
      updates.registerIpc();
      updates.start();

      // 桌面能力（文件工具的权限 / 审计 / 撤销）：先于 AI runtime，插件注册工具时要用
      const desktop = getDesktopService(this.logger);
      desktop.registerIpc();
      desktop.attachWindows({
        main: () => this.windowManager.getMainWindow(),
        openChat: () => this.windowManager.createAiChatWindow(),
        mascotHidden: () => this.windowManager.mascotHidden(),
      });

      // 本地知识库：先于 AI runtime 创建（kb_search 工具随桌面工具注册），LLM 调用延迟绑定
      const kb = initKnowledgeService({
        root: path.join(app.getPath('userData'), 'knowledge'),
        logger: this.logger as never,
        desktop,
        listProviders: () => this.aiRuntime?.listProviders() ?? [],
        credentials: (id) => this.aiRuntime?.providerCredentials(id) ?? null,
        chatProvider: () => desktop.providerFor('chat'),
        complete: async (messages, signal) => {
          const rt = this.aiRuntime;
          if (!rt) throw new Error(tr('electron.common.ai-service-not-ready'));
          const resp = await rt.client.chat.sendMessage({
            role: 'chat',
            messages,
            signal,
          } as never);
          return typeof resp?.content === 'string' ? resp.content : '';
        },
      });
      kb.registerIpc();
      this.lifecycle.register({ name: 'knowledge', stop: () => kb.dispose() });
      this.lifecycle.register({ name: 'reminders', stop: () => desktop.reminders.stop() });

      // 长期记忆：对话摘要 + 召回（复用知识库的 BM25 / 向量服务），工具随桌面工具注册
      const mem = initMemoryService({
        root: path.join(app.getPath('userData'), 'memory'),
        logger: this.logger as never,
        desktop,
        complete: async (messages, signal) => {
          const rt = this.aiRuntime;
          if (!rt) throw new Error(tr('electron.common.ai-service-not-ready'));
          const resp = await rt.client.chat.sendMessage({
            role: 'chat',
            messages,
            signal,
          } as never);
          return typeof resp?.content === 'string' ? resp.content : '';
        },
        embed: (texts) => kb.embedTexts(texts),
        facade: () => (this.aiRuntime?.client.memory as never) ?? null,
      });
      mem.registerIpc();

      // 主动日程：免打扰 / 系统通知策略、定时任务（每日简报）、主动聊天（默认关闭）
      const sched = initSchedulerService({
        root: path.join(app.getPath('userData'), 'schedule'),
        logger: this.logger as never,
        desktop,
        complete: async (messages, signal) => {
          const rt = this.aiRuntime;
          if (!rt) throw new Error(tr('electron.common.ai-service-not-ready'));
          const resp = await rt.client.chat.sendMessage({
            role: 'chat',
            messages,
            signal,
          } as never);
          return typeof resp?.content === 'string' ? resp.content : '';
        },
        // 记忆 + 今日日历（日历服务在下方创建，这里按需读取）
        memory: async (q) => {
          const cal = (getLocalHubService()?.today() ?? [])
            .map((o) =>
              tr(
                '- {0} {1}',
                o.allDay
                  ? tr('electron.common.all-day')
                  : new Date(o.start).toTimeString().slice(0, 5),
                o.summary,
              ),
            )
            .join('\n');
          return [(await mem.context(q)).text, cal && tr('electron.common.today-s-calendar', cal)]
            .filter(Boolean)
            .join('\n\n');
        },
        openChat: () => void this.windowManager.createAiChatWindow(),
      });
      sched.registerIpc();

      // 截图提问 + 屏幕记忆（默认关闭；OCR 复用知识库语言包）
      const scr = initScreenService({
        root: path.join(app.getPath('userData'), 'screen-memory'),
        logger: this.logger as never,
        desktop,
        ocr: (img) => kb.ocr(img),
        ocrReady: () => kb.ocrLangsReady().length > 0,
        chatWindow: () => this.windowManager.getAiChatWindow(),
        openChat: () => this.windowManager.createAiChatWindow(),
        loadOverlay: (win) => this.windowManager.loadChatRoute(win, 'snip'),
      });
      scr.registerIpc();

      // 扩展：GUI 管理的 MCP 服务器 + SKILL.md 技能包
      const ext = initExtensionsService({
        root: path.join(app.getPath('userData'), 'extensions'),
        skillsRoot: path.join(app.getPath('userData'), 'skills'),
        logger: this.logger as never,
        desktop,
      });
      ext.registerIpc();

      // 本地中心：日历 / 剪贴板历史 / 数据导出；本地模型管理（llama.cpp + Ollama）
      const hub = initLocalHubService({
        root: path.join(app.getPath('userData'), 'local'),
        userData: app.getPath('userData'),
        logger: this.logger as never,
        desktop,
      });
      hub.registerIpc();
      const localLlm = initLocalModelService({
        root: path.join(app.getPath('userData'), 'local'),
        logger: this.logger as never,
        desktop,
        gateway: () => getGatewayService(),
      });
      localLlm.registerIpc();

      // 界面主题（设置 → 通用 → 主题），对话窗口与看板娘同步
      const themes = new ThemeService(path.join(app.getPath('userData'), 'theme.json'));
      themes.registerIpc();
      // 对话主面板背景（设置 → 通用 → 聊天背景）
      const chatBg = new ChatBackgroundService(
        path.join(app.getPath('userData'), 'chat-background.json'),
        path.join(app.getPath('userData'), 'chat', 'images'),
      );
      chatBg.registerIpc();
      // 对话窗口一体化标题栏跟随主题（窗口底色 + Windows / Linux 原生按钮配色）
      this.windowManager.chromeTheme = () => themes.get().resolved;
      themes.onChange((st) => {
        const w = this.windowManager.getAiChatWindow();
        if (w) applyTitleBarTheme(w, st.resolved);
      });

      // 首次启动引导（语言 / 主题 / 声音 / 称呼与语气 / 供应商 / 隐私），显示在对话窗口里
      const onboarding = new OnboardingService({
        userData: app.getPath('userData'),
        openChat: async () => {
          await this.windowManager.createAiChatWindow();
        },
      });
      onboarding.registerIpc();

      // 启动后默认界面（看板娘 / 软件主界面）：设置与引导里都能改，默认看板娘（历史行为）
      const startup = new StartupService(path.join(app.getPath('userData'), 'startup.json'));
      startup.registerIpc();
      this.startupService = startup;
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

      // 离线 TTS 模型按需下载（不再随安装包分发）；语音已开但缺模型时启动即下载
      registerTtsModel(this.configService).start();
      const startupPlan = planStartup({
        defaultView: startup.get().defaultView,
        onboardingPending: onboarding.shouldAutoOpen(),
      });
      // 关闭主界面时：quit → 完全退出（看板娘、托盘一起）；hide（默认）→ 只关窗口
      this.windowManager.shouldQuitOnChatClose = () =>
        shouldQuitOnMainClose(startup.get().closeMain, this.shutdown.isQuitting());
      if (startupPlan.openMain && startupPlan.delayMs > 0) {
        // 首次引导：等看板娘窗口先出来，再打开引导（她会在引导中打招呼）
        setTimeout(() => void this.windowManager.createAiChatWindow(), startupPlan.delayMs);
      }

      // 编程助手进度：监视本机 Codex / Claude Code 等会话文件，看板娘提醒完成/失败
      // 灵动岛式通知（macOS 刘海 / 顶部胶囊；免打扰时段内不弹）
      const island = initIslandService({
        file: path.join(app.getPath('userData'), 'island.json'),
        isQuiet: () => getSchedulerService()?.isQuiet() ?? false,
        openChat: () => void this.windowManager.createAiChatWindow(),
        logger: this.logger as never,
      });
      island.registerIpc();

      // 用量与计费：Nomi 对话 / 本地路由 / 编程工具会话日志，全部只存本机
      const usage = initUsageService({
        root: path.join(app.getPath('userData'), 'usage'),
        logger: this.logger as never,
        providerName: (id) => this.aiRuntime?.listProviders().find((p) => p.id === id)?.name,
        // Grok 额度指纹用账号模块记录的身份（来自 CLI 自己报告），不读 auth.json（§5.10 S7）
        grokAccountKey: () => accounts.identityKey('grok'),
        // 模型数据同步（models.dev）：同一份下载同时更新价格表与网关的模型目录
        onModelsData: (api) => getGatewayService()?.applyModelsData(api),
        needsFullModelsData: () => {
          const g = getGatewayService();
          return g ? !g.hasCatalogSync() : false;
        },
        // 额度跟着默认官方账号走：取额度的官方 CLI 在默认账号的账号目录里运行（§5.10）
        officialAccount: (kind, prepare) => {
          if (!prepare) return { dir: accounts.defaultDir(kind), args: [] };
          const l = accounts.officialLaunch(kind, null);
          return { dir: l.dir, args: l.args };
        },
        // 预算 / 单任务提醒：看板娘气泡（只显示，不朗读）+ 灵动岛；免打扰中不弹，稍后重试
        alert: (a) => {
          if (desktop.notifyPolicy?.quiet() ?? false) return false;
          desktop.say(a.text.slice(0, 140), { voice: 'none' });
          notifyIsland({ kind: 'info', status: 'attention', title: a.title, body: a.text });
          return true;
        },
      });
      usage.registerIpc();
      usage.start();

      const agents = initAgentProgressService({
        root: path.join(app.getPath('userData'), 'agents'),
        logger: this.logger as never,
        desktop,
        isQuiet: () => desktop.notifyPolicy?.quiet() ?? false,
        // CodingMonitor 显示会话累计用量；任务结束播报（总结播报开着时）附带「本次花费」
        usageOf: (source, session) =>
          getUsageService()?.sessionUsage(source as never, session) ?? null,
        taskCost: async (q) => {
          const u = getUsageService();
          if (!u) return null;
          // 日志有延迟：先追平一次再算（路由 / Nomi 对话的记录本来就是即时的）
          await u.scan().catch(() => undefined);
          return u.taskCostLine({ source: q.source as never, session: q.session, since: q.since });
        },
      });
      agents.registerIpc();
      if (agents.state().settings.enabled) agents.start();

      // 编程助手 CLI 接入 P0：版本更新 / 供应商桥 / 对话后端接管
      const cliUpdate = initCliUpdateService({
        root: path.join(app.getPath('userData'), 'cli-update'),
        logger: this.logger as never,
        // CLI 升级策略（P9.6）：Windows 上先排空（拆空闲进程，最多等 30 秒让进行中的轮次结束）；
        // 升级成功后空闲时用新版本重启会话并续接
        drain: async (kind) => {
          harness.restartForUpgrade(kind);
          for (let i = 0; i < 60 && harness.busyTurns(kind) > 0; i++)
            await new Promise((r) => setTimeout(r, 500));
          return harness.busyTurns(kind);
        },
        onUpdated: () => void cliPlugins.refreshVersions(),
      });
      cliUpdate.registerIpc();
      // 编程助手插件宿主（docs/design/cli-plugin-architecture.md §5、§7）：清单校验、有效能力、注册表快照
      const cliPlugins = initCliPluginHost({
        root: path.join(app.getPath('userData'), 'cli-plugins'),
        logger: this.logger as never,
        version: async (id) => {
          const bin = await resolveCliBinAsync(id as CliKind).catch(() => null);
          return bin ? readVersionAsync(bin) : null;
        },
        // 运行中 CLI 换了版本（应用内或终端里升级）：空闲时用新版本重启续接
        onVersionChange: (id) => {
          if (isBuiltinCliId(id)) harness.restartForUpgrade(id);
        },
        // 外部插件（§5.9）「测试」按钮：与标签同一套启动（Windows 垫片、诊断记录），不带网关 / 账号注入
        spawnExternal: (command, args, cwd) => {
          const useNode = isScript(command);
          return spawnHarness(
            useNode ? process.execPath : command,
            useNode ? [command, ...args] : args,
            {
              cwd,
              env: cliChildEnv(useNode),
            },
          );
        },
        onExternalRemoved: (id) => harness.externalRemoved(id),
      });
      cliPlugins.registerIpc();
      void cliPlugins.start();
      // 终端里升级了 CLI 也要发现：每 30 分钟重读一次版本（每个 CLI 起一次 --version）
      const versionTimer = setInterval(() => void cliPlugins.refreshVersions(), 30 * 60_000);
      versionTimer.unref?.();
      this.lifecycle.register({
        name: 'cli-plugins',
        stop: () => {
          clearInterval(versionTimer);
          cliPlugins.stop();
        },
      });
      const cliRoot = path.join(app.getPath('userData'), 'cli-providers');
      // 统一网关（docs/design/unified-gateway.md）：首次启动从旧存储迁移，网关跑在独立的 utilityProcess 里。
      // 旧版本写进 CLI 全局配置的第三方设置在迁移后撤销（§6.3 第 7 步）；撤销全部成功之前，
      // 终端里的 CLI 可能还带着旧路由令牌，网关继续接受它（§10.2）。
      let legacyRevoke: RevokeLegacyResult | null = null;
      const legacyToken = (): string | null => {
        if (!legacyRevoke?.failed.length) return null;
        try {
          return fs.readFileSync(path.join(cliRoot, 'routing.token'), 'utf8').trim() || null;
        } catch {
          return null;
        }
      };
      // 诊断日志（docs/design/cli-plugin-architecture.md §8）：开发版必开，正式版在「隐私与权限」里开；
      // 用量面板旧的「调试模式」并入这里（网关正文追踪跟随它，首次启动沿用旧开关）
      const diagnostics = new DiagnosticsService({
        userData: app.getPath('userData'),
        logger: this.logger,
        traceDir: path.join(app.getPath('userData'), 'gateway', 'trace'),
        legacyEnabled: () => readLegacyGatewayTrace(path.join(app.getPath('userData'), 'gateway')),
        onChange: () => {
          getGatewayRequestLog()?.traceStateChanged();
          getGatewayService()?.refresh();
        },
      });
      // 模型质量（docs/design/model-quality.md）：网关层 / CLI 层的请求质量，只存元数据，受用量总开关控制
      const providerOf = (pid: string) =>
        getGatewayService()
          ?.store.providers()
          .find((x) => x.id === pid);
      const quality = initQualityService({
        dir: path.join(app.getPath('userData'), 'usage', 'quality'),
        logger: this.logger as never,
        enabled: () => getUsageService()?.getSettings().enabled ?? true,
        cost: (model, tokens) => getUsageService()?.costOf(model, tokens),
        labelOf: (dim, key) => {
          if (dim === 'provider') return providerOf(key)?.name;
          if (dim !== 'key') return undefined;
          const [pid = '', kid = ''] = key.split('\u0000');
          const k = providerOf(pid)?.keys.find((x) => x.id === kid);
          return k ? (k.name ?? k.masked) : undefined;
        },
      });
      quality.registerIpc();
      this.lifecycle.register({ name: 'model-quality', stop: () => quality.dispose() });
      // 网关正文追踪目录（跟随诊断日志开关）；旧「最近请求」导入模型质量账本一次后删除
      const gatewayRequests = initGatewayRequestLog({
        root: path.join(app.getPath('userData'), 'gateway'),
        logger: this.logger as never,
        traceOn: () => diagnostics.bodyTrace(),
        importLegacy: (records) => quality.importLegacy(records),
      });
      diagnostics.registerIpc();
      this.lifecycle.register({ name: 'gateway-requests', stop: () => gatewayRequests.dispose() });
      const gateway = initGatewayService({
        root: path.join(app.getPath('userData'), 'gateway'),
        cipher: createSafeStorageCipher(safeStorage),
        logger: this.logger as never,
        // 网关事件不计入用量账本（CLI 以会话日志为准），进模型质量
        onUsage: (e) => quality.addGateway(e),
        traceDir: () => gatewayRequests.traceDir(),
        presetQuirks: (id) => findPreset(id)?.quirks as ProviderQuirks | undefined,
        presetModels: (id) => findPreset(id)?.modelMeta,
        longContextPrice: (model) => getUsageService()?.longContextPrice(model),
        // 环境变量提供的供应商（只读）：有 Key 的，以及显式设了地址 / 模型的 Ollama
        envProviders: () =>
          llmProvidersFromEnv()
            .filter((e) =>
              e.id === 'ollama'
                ? Boolean(process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL)
                : Boolean(e.apiKey),
            )
            .map((e) => {
              const c = envProviderConfig(e);
              return {
                id: e.id,
                name: `${ENV_PROVIDER_NAME[e.id] ?? e.id}（环境变量）`,
                wire: c.protocol === 'anthropic' ? ('messages' as const) : ('chat' as const),
                url: c.baseURL ?? '',
                ...(e.apiKey ? { key: e.apiKey, keyEnv: ENV_PROVIDER_KEY[e.id] } : {}),
                ...(c.defaultModel && c.defaultModel !== 'default'
                  ? { model: c.defaultModel }
                  : {}),
              };
            })
            .filter((e) => e.url),
        legacy: {
          nomiFile: path.join(app.getPath('userData'), 'ai-providers.json'),
          cliRoot,
          cliDecrypt: decryptLegacyCliKey,
          normalizeNomi: (raw) => migrateStoreData(raw).data,
          token: legacyToken,
          // 旧本地路由不再启动：网关接管它的端口
          routeListening: () => false,
        },
        broadcast: (channel, payload) => {
          for (const w of BrowserWindow.getAllWindows())
            if (!w.isDestroyed()) w.webContents.send(channel, payload);
        },
      });
      gateway.registerIpc();
      // 先迁移（读旧存储里「启用中」的标记），再撤销旧版本写进全局配置的东西（会清掉这些标记）
      gateway.init();
      // 启动时自动同步模型数据（用户可在「模型」页关闭；距上次核对不足 12 小时不联网）
      void usage.autoSync().catch((e) => this.logger.warn('models data auto sync failed', e));
      // 终端启动命令（unified-gateway §12.6，默认关）：端口 / 令牌 / 分配变化时重新生成脚本
      const terminal = initTerminalCommands({
        root: path.join(app.getPath('userData'), 'gateway'),
        source: gatewayTerminalSource(gateway),
        logger: this.logger as never,
      });
      registerTerminalIpc(terminal);
      terminal.refresh();
      gateway.onChange(() => terminal.refresh());
      try {
        legacyRevoke = revokeLegacyGlobalConfig({
          home: os.homedir(),
          cliRoot,
          backupRoot: path.join(app.getPath('userData'), 'gateway', 'backups'),
          decrypt: decryptLegacyCliKey,
          logger: this.logger as never,
        });
        gateway.setLegacyRevoke(legacyRevoke);
      } catch (e) {
        this.logger.warn('revoke legacy CLI config failed', e);
      }
      this.lifecycle.register({ name: 'gateway', stop: () => gateway.dispose() });
      // 官方账号（docs/design/cli-plugin-architecture.md §5.10）：一个账号 = 一个 CLI 配置目录，Nomi 不经手凭据。
      // 改默认账号只重启跟随默认的官方标签；第三方标签与网关不受影响（S5、S6）
      const accounts: AccountService = new AccountService({
        root: path.join(app.getPath('userData'), 'cli-accounts'),
        logger: this.logger as never,
        onDefaultChanged: (kind) => {
          harness.recycleDefaultAccount(kind);
          // 换了号：上一个账号的订阅额度不能再显示
          getUsageService()?.forgetAccountQuota(kind);
        },
        inUse: (kind, id) =>
          harness.officialAccountTabs(kind).filter((a) => accounts.resolve(kind, a) === id).length,
        onChanged: () => accounts.broadcastChanged(),
      });
      const harness = initCliHarnessService({
        root: path.join(app.getPath('userData'), 'harness'),
        logger: this.logger as never,
        defaultCwd: app.getPath('documents'),
        // 第三方会话经统一网关按进程注入（docs/design/unified-gateway.md §12），不写 CLI 全局配置
        gateway: harnessGateway(gateway),
        // 模型质量 CLI 层：Nomi 里运行的编程助手（官方账号与第三方）每轮一条（model-quality.md §4.4）
        quality: { addCli: (r) => void quality.addCli(r) },
        // 官方标签按账号目录启动（docs/design/cli-plugin-architecture.md §5.10）
        accounts: {
          launch: (kind, accountId) => accounts.officialLaunch(kind, accountId),
          noteSession: (kind, sessionId, accountId) =>
            accounts.noteSession(kind, sessionId, accountId),
        },
        // 外部插件（§5.9）：通用 ACP 后端；握手报告的能力只能收窄注册表里的能力位
        externals: {
          spec: (id) => cliPlugins.externalSpec(id),
          handshake: (id, caps) =>
            cliPlugins.setHandshake(id, { images: caps.images, resume: caps.resume }),
        },
        // 新建 / 切到 Claude 会话时预先拉起长驻进程；NOMI_HARNESS_PREWARM=0 关闭
        prewarmClaude: process.env.NOMI_HARNESS_PREWARM !== '0',
        // Grok 走 ACP 长驻会话（grok agent stdio）；NOMI_GROK_ACP=0 退回每轮一个进程的 grok -p
        grokAcp: process.env.NOMI_GROK_ACP !== '0',
        // Codex 走 app-server 长驻会话；NOMI_CODEX_APP_SERVER=0 退回每轮一个进程的 codex exec
        codexAppServer: process.env.NOMI_CODEX_APP_SERVER !== '0',
        // 右栏「生成提交信息」：辅助模型档（没设时跟主模型），经网关所以受外发保护；
        // 同样遵守「仅本地模型可读文件」，发给云端前按设置确认
        complete: async (messages, signal) => {
          const rt = this.aiRuntime;
          if (!rt) throw new Error(tr('electron.common.ai-service-not-ready'));
          const send = await desktop.broker.checkSend(
            desktop.providerFor('summary'),
            signal,
            tr('electron.common.code-changes'),
          );
          if (send === 'local_only')
            throw new Error(tr('electron.common.only-local-models-can-read-files-is-on'));
          if (send === 'user_denied') throw new Error(tr('electron.common.ok-not-sending'));
          const resp = await rt.client.chat.sendMessage({
            role: 'summary',
            messages,
            signal,
          } as never);
          return typeof resp?.content === 'string' ? resp.content : '';
        },
      });
      accounts.registerIpc();
      const accountLogin = new AccountLogin({
        accounts,
        logger: this.logger as never,
        emit: broadcastLogin,
      });
      accountLogin.registerIpc();
      this.lifecycle.register({ name: 'cli-account-login', stop: () => accountLogin.dispose() });
      harness.registerIpc();
      this.lifecycle.register({ name: 'cli-harness', stop: () => harness.dispose() });
      // Nomi 对话的权限模式（输入栏的权限按钮）作用在 Nomi 自己的工具上；「完全放开」不适用
      getDesktopService(this.logger).broker.permissionMode = () => {
        const m = harness.mainPermissionMode();
        return m === 'bypass' ? 'acceptEdits' : m;
      };
      // Nomi 把编程助手当子代理调用（工具 delegate_to_cli、/cli、设置 →「编程助手」→「委派」）
      initDelegateService({
        root: path.join(app.getPath('userData'), 'delegate'),
        harness,
        desktop: getDesktopService(this.logger),
        gateway: harnessGateway(gateway),
      }).registerIpc();
      initSessionHistoryService({
        logger: this.logger as never,
        openKeys: () => harness.openSessionKeys(),
        openTitle: (backend, sessionId, title) =>
          harness.syncOpenSessionTitle(backend, sessionId, title),
        openTab: (o) => harness.openHistorySession(o),
        gatewaySession: (backend, sessionId) => gateway.servedSession(backend, sessionId),
        accountLabel: (backend, accountId) => {
          // eslint-disable-next-line nomi/no-cli-literal -- 只有 Codex 的历史记录了 creator_account_id
          if (backend !== 'codex') return undefined;
          const a = accounts.findByAccountId('codex', accountId);
          return a ? (a.identity?.email ?? a.label) : undefined;
        },
        // Nomi 启动时记下的账号；只有一个账号时不标注
        sessionAccount: (backend, sessionId) => {
          // 没有官方账号的 CLI（dsh）不记会话归属
          if (!isAccountKind(backend)) return undefined;
          const a = accounts.sessionAccount(backend, sessionId);
          if (!a) return undefined;
          return accounts.list(backend).length > 1 ? a : { id: a.id };
        },
      }).registerIpc();
      // 监视器汇总 Nomi 标签；任一标签一轮结束 → 看板娘 / 灵动岛
      agents.attachHarness({
        // 外部插件（§5.9）没有进度监视能力：不进监视器
        tabs: () =>
          harness
            .listTabs()
            .tabs.filter(
              (x): x is typeof x & { backend: Exclude<typeof x.backend, 'external'> } =>
                x.backend !== 'external',
            ),
        onTabs: (fn) => harness.events.on('tabs', fn),
        onFinished: (fn) =>
          harness.events.on('tab-finished', (e) => {
            if (e.backend !== 'external') fn(e);
          }),
        onPermission: (fn) =>
          harness.events.on('permission-needed', (e) => {
            if (e.backend !== 'external') fn(e);
          }),
        progress: (id) => harness.progressHint(id),
      });

      // 启动 AI runtime（在窗口创建之前，preload 到 renderer 时 IPC 通道已就绪）
      await this.startAIRuntime();
      if (this.aiRuntime) {
        const rt = this.aiRuntime;
        desktop.attachRuntime({
          resolveProvider: (role) => rt.resolveProvider(role),
          lookupProvider: (id) => rt.lookupProvider(id),
          complete: async (messages, role, signal) => {
            const resp = await rt.client.chat.sendMessage({ role, messages, signal });
            return typeof resp?.content === 'string' ? resp.content : '';
          },
        });
      }
      perfMark('ai-runtime-ready');
      void ext.start();
      hub.start();
      void localLlm.autoStart();

      // 语音输入：本地 whisper.cpp / OpenAI 兼容识别、按需下载模型、打断 TTS、唤醒词
      const rtv = this.aiRuntime;
      const voice = getVoiceService({
        root: path.join(app.getPath('userData'), 'voice'),
        logger: this.logger as never,
        providers: () => rtv?.listProviders() ?? [],
        credentials: (id) => rtv?.providerCredentials(id) ?? null,
        localOnly: () => desktop.broker.view().localOnly,
        audit: (e) => desktop.audit.append({ ...e, source: 'voice' }),
        openChat: () => this.windowManager.createAiChatWindow(),
      });
      voice.registerIpc();
      // 麦克风：只允许本应用窗口申请「音频」采集（不允许摄像头 / 屏幕）；
      // 剪贴板只放行写入（复制按钮用 navigator.clipboard.writeText），读取仍拒绝；
      // 其余权限（geolocation / notifications / HID / MIDI / pointerLock 等）一律拒绝。
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

      // 创建看板娘窗口（始终创建：定时任务 / 提醒 / 编程助手进度都靠它播报；
      // 默认界面为「软件主界面」时它不抢焦点）
      await this.windowManager.createMainWindow({ activate: startupPlan.activateMascot });
      // 提醒调度：主窗口创建后开始（错过的提醒要在看板娘气泡里播报）
      desktop.startReminders();
      kb.start();
      mem.start();
      sched.start();
      scr.start();

      // 托盘：一键切换 AI provider
      this.startTray();

      // 默认界面为「软件主界面」：看板娘就绪后直接打开主界面；失败只记日志，仍可用看板娘
      this.launched = true;
      if (startupPlan.openMain && startupPlan.delayMs === 0) this.openMainInterface(startupPlan);

      this.logger.info('应用启动完成');
      eventBus.emit('app:started');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('应用启动失败', { error: errorMessage });
      throw error;
    }
  }

  /**
   * 启动 AI runtime（插件宿主 + IPC 通道 + seams）
   *
   * 幂等：重复调用会直接返回。失败时记录日志但不抛出——AI 功能对应用启动
   * 不是强依赖；后续可以通过 `getAIRuntime()` 判断可用性。
   */
  async startAIRuntime(): Promise<void> {
    if (this.aiRuntime) {
      this.logger.debug('AI runtime already started');
      return;
    }
    try {
      this.clipboardGateway = new ClipboardGateway();
      const screen = new ScreenCapture();
      const ttsEngine = new AdvancedTTSEngine();
      const electronNativeTts = new TtsElectronNativeProvider({ engine: ttsEngine });
      this.aiRuntime = await startAIRuntime(this.logger, {
        seams: {
          clipboard: this.clipboardGateway,
          screen,
        },
        ttsProviders: [electronNativeTts],
      });
      this.logger.info('AI runtime 启动完成', {
        profile: this.aiRuntime.profile,
        channelCount: this.aiRuntime.channels.business.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('AI runtime 启动失败', { error: errorMessage });
    }
  }

  private openMainInterface(plan?: Pick<StartupPlan, 'activateMain'>): void {
    this.windowManager.createAiChatWindow({ activate: plan?.activateMain ?? true }).catch((error) =>
      this.logger.warn('启动时打开主界面失败，保留看板娘', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /**
   * 已运行实例被再次唤起（第二实例 / macOS Dock / Windows 托盘左键）：
   * 默认界面为「软件主界面」时把主界面带到前台，返回 true；否则返回 false，调用方保持历史行为。
   */
  raiseMainOnReactivate(): boolean {
    if (!this.launched || !this.startupService) return false;
    if (!shouldRaiseMainOnReactivate(this.startupService.get().defaultView)) return false;
    this.openMainInterface();
    return true;
  }

  /** 系统托盘（provider 快速切换）；失败不影响启动。 */
  private startTray(): void {
    const providers = this.aiRuntime?.providers;
    if (!providers || this.trayManager) return;
    const gateway = getGatewayService();
    this.trayManager = new TrayManager({
      providers,
      models: gateway
        ? {
            state: () => gateway.state(),
            select: (ref) => gateway.setAssignment('nomi', { models: { main: ref } }),
            onChange: (fn) => gateway.onChange(fn),
          }
        : undefined,
      logger: this.logger,
      openChat: () => {
        void this.windowManager.createAiChatWindow();
      },
      openProviderPanel: () => {
        void this.windowManager.openProviderPanel();
      },
      openDesktopPanel: () => {
        void this.windowManager.openProviderPanel('ai:desktop:open-panel');
      },
      onActivate: () => this.raiseMainOnReactivate(),
      quit: () => app.quit(),
      screenMemory: getScreenService()
        ? {
            active: () => getScreenService()!.active(),
            onChange: (fn) => getScreenService()!.onChange(fn),
            pause: (m) => getScreenService()!.pause(m),
            open: () => void this.windowManager.openProviderPanel('ai:screen:open-panel'),
          }
        : undefined,
    });
    this.trayManager.start();
    // 兜底：应用被激活 / 窗口获得焦点时，如果托盘已被销毁就重建
    const heal = () => this.trayManager?.ensureAlive();
    app.on('activate', heal);
    app.on('browser-window-focus', heal);
  }

  /**
   * 停止 AI runtime；幂等。
   */
  async stopAIRuntime(): Promise<void> {
    getMemoryService()?.flush();
    getSchedulerService()?.stop();
    getIslandService()?.destroy();
    getScreenService()?.stop();
    getLocalHubService()?.stop();
    void getLocalModelService()?.stop();
    try {
      getUpdateService(this.logger).stop();
    } catch {
      /* not started */
    }
    getAgentProgressService()?.stop();
    getUsageService()?.stop();
    this.trayManager?.dispose();
    this.trayManager = undefined;
    // 其余有后台资源的服务（CLI 子进程树、本地路由监听、知识库索引 / OCR worker、缓存定时器…）
    await this.lifecycle.stopAll(this.logger);
    if (!this.aiRuntime) return;
    const handle = this.aiRuntime;
    this.aiRuntime = undefined;
    try {
      await handle.dispose();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn('AI runtime 停止时出现异常', { error: errorMessage });
    }
    try {
      this.clipboardGateway?.dispose();
    } catch {
      /* ignore */
    }
    this.clipboardGateway = undefined;
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

      // 停止 AI runtime（务必先于 IPC 清理，避免通道注册器空指针）
      await this.stopAIRuntime();

      // 保存配置
      await this.configService.save();

      // 清理IPC处理器
      this.ipcRegistry.cleanup();

      // 关闭所有窗口
      this.windowManager.closeAllWindows();

      // 清理资源
      this.cleanup();

      this.logger.info('应用已停止');
      eventBus.emit('app:stopped');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('应用停止失败', { error: errorMessage });
      throw error;
    }
  }

  /**
   * 获取服务容器
   */
  getServiceContainer(): IServiceContainer {
    return this.container;
  }

  /**
   * 设置服务
   */
  private setupServices(): void {
    // 注册日志服务（单例）
    this.container.registerSingleton('logger', () => {
      return new LoggerService();
    });
    this.logger = this.container.get<LoggerService>('logger');

    // 注册配置服务（单例）
    this.container.registerSingleton('config', () => {
      return new ConfigService(this.logger);
    });
    this.configService = this.container.get<ConfigService>('config');

    // 注册缓存服务（单例）
    this.container.registerSingleton('cache', () => {
      return new CacheService({ maxSize: 500, defaultTtl: 10 * 60 * 1000 }, this.logger);
    });
    this.cacheService = this.container.get<CacheService>('cache');
    this.lifecycle.register({ name: 'cache', stop: () => this.cacheService.destroy() });

    // 注册错误处理器（单例）
    this.container.registerSingleton('errorHandler', () => {
      return new GlobalErrorHandler(this.logger);
    });
    this.errorHandler = this.container.get<GlobalErrorHandler>('errorHandler');

    // 注册窗口管理器（单例）
    this.container.registerSingleton('windowManager', () => {
      return new WindowManager(this.logger, this.configService);
    });
    this.windowManager = this.container.get<WindowManager>('windowManager');

    // 注册IPC注册器（单例）
    this.container.registerSingleton('ipcRegistry', () => {
      return new IpcRegistry({
        logger: this.logger,
        configService: this.configService,
        cacheService: this.cacheService,
        windowManager: this.windowManager,
      });
    });
    this.ipcRegistry = this.container.get<IpcRegistry>('ipcRegistry');

    // 注册启动管理器（单例）
    this.container.registerSingleton('bootstrapManager', () => {
      return new BootstrapManager(this.logger);
    });
    this.bootstrapManager = this.container.get<BootstrapManager>('bootstrapManager');
  }

  /**
   * 设置启动任务
   */
  private setupBootstrapTasks(): void {
    // 关键任务：配置加载
    this.bootstrapManager.addTask({
      name: 'load-config',
      priority: 'critical',
      execute: async () => {
        await this.configService.load();
      },
    });

    // 关键任务：应用事件设置
    this.bootstrapManager.addTask({
      name: 'setup-app-events',
      priority: 'critical',
      execute: async () => {
        this.setupAppEvents();
      },
      dependencies: ['load-config'],
    });

    // 关键任务：IPC处理器初始化
    this.bootstrapManager.addTask({
      name: 'initialize-ipc',
      priority: 'critical',
      execute: async () => {
        this.ipcRegistry.initialize();
      },
      dependencies: ['load-config'],
    });

    // 高优先级任务：进程信号处理
    this.bootstrapManager.addTask({
      name: 'setup-process-handlers',
      priority: 'high',
      execute: async () => {
        this.setupProcessHandlers();
      },
    });

    // 中优先级任务：缓存预热
    this.bootstrapManager.addTask({
      name: 'cache-warmup',
      priority: 'medium',
      delay: 100,
      execute: async () => {
        // 预热常用配置缓存
        const config = this.configService.getConfig();
        this.cacheService.set('app:config', config, 30 * 60 * 1000); // 30分钟缓存

        // 预热应用信息缓存
        const appInfo = {
          version: app.getVersion(),
          name: app.getName(),
          isPackaged: app.isPackaged,
        };
        this.cacheService.set('app:info', appInfo, 60 * 60 * 1000); // 1小时缓存
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
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.warn('清理旧日志失败', { error: errorMessage });
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
    // 应用准备就绪
    app.whenReady().then(() => {
      this.logger.info('Electron应用准备就绪');
      eventBus.emit('electron:ready');
    });

    // 所有窗口关闭
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    // 应用激活
    app.on('activate', async () => {
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

    // 事件总线事件
    eventBus.on('app:quit', () => {
      app.quit();
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
   * 清理资源
   */
  private cleanup(): void {
    try {
      // 清理事件监听器
      eventBus.clear();

      // 清理服务容器
      this.container.clear();

      this.logger.info('资源清理完成');
    } catch (error) {
      console.error('资源清理失败:', error);
    }
  }

  /**
   * 获取应用状态
   */
  getStatus() {
    return {
      isInitialized: this.isInitialized,
      mainWindow: !!this.windowManager.getMainWindow(),
      aiChatWindow: !!this.windowManager.getAiChatWindow(),
      config: this.configService.getConfig(),
      ipc: this.ipcRegistry.getStats(),
      cache: this.cacheService.getStats(),
      bootstrap: {
        taskStatus: this.bootstrapManager.getTaskStatus(),
        performanceReport: this.bootstrapManager.getPerformanceReport(),
      },
    };
  }
}

/** 有官方账号的编程助手（清单 capabilities.officialAccount，见 cli/accounts/types.ts） */
function isAccountKind(k: string): k is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(k);
}
