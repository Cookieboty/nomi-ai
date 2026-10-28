/**
 * 内核组合根（docs/design/core-host-decoupling.md §7.1）：`createCore(deps)` 建好内核的服务、应用契约的
 * router 与事件桥，宿主只负责端口、窗口、托盘、协议与传输。
 *
 * ```ts
 * const core = createCore({ ports, logger, host: { … } });
 * await core.start();                         // 服务 + AI runtime + router（宿主就绪之后调用）
 * const stop = serveContract(core.router);    // 宿主挂传输（Electron IPC / in-process / WebSocket）
 * // …宿主创建窗口…
 * core.startReminders();                      // 能播报的界面就绪后：提醒与定时任务
 * await core.stop();
 * ```
 *
 * - **没有模块级单例**：服务实例都在这一次调用的闭包里，`core.services` 是只读视图；一个进程里可以有
 *   多个内核（P4 的无界面 e2e），彼此的服务、事件总线与 router 互不相干。仍是进程级的只有：界面语言
 *   （`i18n` 的 `t()`）、日志开关与私有文件根目录（宿主的进程设置）、诊断日志的写入器（`cliTrace`），
 *   以及子进程 / worker 的缓存，见 §12 P4 进度说明；
 * - **宿主片段**：要用窗口的契约过程（Electron：看板娘窗口互动、灵动岛、旧窗口通道、应用图标）由宿主在
 *   `contract.hostHandlers` 里传进来，与内核的处理函数在同一次 `implement` 里组装；宿主片段只能补内核
 *   没有实现的过程，谁都没实现的以 UNAVAILABLE 失败（无界面宿主没有窗口片段）；
 * - **宿主钩子**（`host`）：内核不认识窗口，打开 / 判断界面走 `ports.windows`；只有少数地方要宿主的窗口对象
 *   或宿主的插件（桌面服务的看板娘窗口、语音投递到对话窗口、自动更新、受控浏览器、系统 TTS、用户画像存储），
 *   都是可选的，缺省时对应能力报不可用或不做。
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
  type IgPluginEntry,
} from '@nomi-ai/ai-runtime';
import { isBuiltinCliId } from '@nomi-ai/cli-plugins';
import type { Router } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import type { ProviderQuirks } from '@nomi-ai/gateway';
import type { HostPorts } from '@nomi-ai/host-ports';

import { AgentProgressService } from './agents/AgentProgressService';
import { startAIRuntime, type AIRuntimeBootHandle, type TtsProviderLike } from './ai/AIRuntimeBoot';
import {
  CharacterPackService,
  type CharacterPackProtocolHost,
} from './character/CharacterPackService';
import { ChatBackgroundService } from './chat/ChatBackgroundService';
import { AccountLogin, loginBroadcaster } from './cli/accounts/AccountLogin';
import { AccountService } from './cli/accounts/AccountService';
import { ACCOUNT_KINDS, type AccountKind } from './cli/accounts/types';
import { CliPluginHost } from './cli/CliPluginHost';
import { CliUpdateService } from './cli/CliUpdateService';
import { DelegateService } from './cli/delegate/DelegateService';
import { resolveCliBinAsync, readVersionAsync } from './cli/detect';
import { HarnessOrchestrator } from './cli/harness/Orchestrator';
import { cliChildEnv, isScript, spawnHarness } from './cli/harness/spawn';
import { legacyCliKeyDecryptor } from './cli/legacyCliKey';
import { SessionHistoryService } from './cli/SessionHistoryService';
import type { CliKind } from './cli/types';
import { createContractEventBridge, type ContractEventBridge } from './contract/eventBridge';
import type { CallerWindows } from './contract/media/voiceSenders';
import { APP_EVENT_BRIDGE, createAppRouter, type AppRouterHandle } from './contract/router';
import type { CoreContractServices } from './contract/services';
import type { AppHandlers, ContractDeps, Middleware } from './contract/types';
import { createShutdown, LifecycleRegistry } from './core/lifecycle';
import { ServiceContainer, type IServiceContainer } from './core/ServiceContainer';
import { APP_EVENTS, HOST_PORTS } from './core/serviceTokens';
import { createDesktopService, type DesktopWindows } from './desktop/DesktopService';
import { guardOutboundMessages } from './desktop/outboundGuard';
import { DiagnosticsService } from './diagnostics/DiagnosticsService';
import { ExtensionsService } from './extensions/ExtensionsService';
import { GatewayService } from './gateway/GatewayService';
import { harnessGateway } from './gateway/harnessGateway';
import { revokeLegacyGlobalConfig, type RevokeLegacyResult } from './gateway/revokeLegacy';
import { gatewayTerminalSource, TerminalCommands } from './gateway/TerminalCommands';
import { getLocale, LocaleService, onLocaleChange, t as tr } from './i18n';
import { KnowledgeService } from './knowledge/KnowledgeService';
import { LocalHubService } from './local/LocalHubService';
import { LocalModelService } from './local/LocalModelService';
import { MemoryService } from './memory/MemoryService';
import { OnboardingService } from './onboarding/OnboardingService';
import { forwardPersonaChanges } from './persona/events';
import { neutralPersonaSource, packPersonaSource, PersonaService } from './persona/PersonaService';
import { SchedulerService } from './schedule/SchedulerService';
import { ScreenService } from './screen/ScreenService';
import { safeStorageFromSecrets } from './security/secretStorage';
import { CacheService } from './services/CacheService';
import { ConfigService } from './services/ConfigService';
import { LoggerService } from './services/LoggerService';
import { UpdateService, type UpdaterLike } from './services/UpdateService';
import { StartupService } from './startup/StartupService';
import { ThemeService } from './theme/ThemeService';
import { TtsService } from './tts/TtsService';
import { GatewayRequestLog, readLegacyGatewayTrace } from './usage/GatewayRequestLog';
import { QualityService } from './usage/quality/QualityService';
import { UsageService } from './usage/UsageService';
import { createMainLogger } from './utils/log';
import { whenPrivateWritesIdle } from './utils/privateFile';
import { VoiceService, type VoiceChatWindow } from './voice/VoiceService';

/** 停止内核的总超时：超过后放弃等待（宿主照常退出） */
export const CORE_STOP_TIMEOUT_MS = 5000;

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

/** 内核的配置（与平台无关的选项） */
export interface CoreConfig {
  /** AI 插件 profile；默认 `IG_AI_PROFILE` 环境变量，再缺省为 `waifu` */
  aiProfile?: string;
  /** 内置的聊天背景预设图（宿主按打包方式给路径）；缺省按正式包的布局 `<resources>/assets/backgrounds/` */
  chatBackgroundPresetFile?: string;
  /** 启动时按计划同步模型数据（models.dev，联网），默认 true；测试关掉 */
  autoSyncModels?: boolean;
  /**
   * 统一网关本次运行监听的端口（0 = 系统分配），覆盖用户设置但不保存；缺省用设置里的端口。
   * 无界面宿主用它，不和本机装着的 Nomi 抢默认端口
   */
  gatewayPort?: number;
}

/** 宿主钩子：都是可选的，缺省时对应能力不可用或不做 */
export interface CoreHostHooks {
  /** 自动更新（Electron：electron-updater 的 autoUpdater）；缺省时检查更新报不可用 */
  updater?: UpdaterLike;
  /** 受控浏览器（`browser_*` 工具）；缺省时这些工具报不可用 */
  browser?: () => unknown;
  /** 注册 `character-pack://` 协议的宿主对象（Electron：`protocol`）；缺省只解析角色包 */
  characterPackProtocol?: CharacterPackProtocolHost;
  /** 桌面服务用到的看板娘 / 对话窗口与灵动岛（确认框、提醒、拖入总结） */
  desktopWindows?: DesktopWindows;
  /** 把语音识别结果投递到对话窗口时要等页面加载（Electron：打开对话窗口并返回它） */
  voiceChatWindow?: () => Promise<VoiceChatWindow>;
  /** 宿主当前存活的窗口数（引导里的看板娘指令据此判断是否送达）；缺省按 0 */
  liveWindows?: () => number;
  /** 调用方窗口的存活（语音会话随窗口释放）；缺省时会话只随契约连接断开释放 */
  callerWindows?: CallerWindows;
  /** 宿主的 AI 插件，装在内置插件之前（Electron：FileSessionStorePlugin）；启动 AI runtime 时才取 */
  aiPlugins?: () => IgPluginEntry[];
  /**
   * 宿主的 AI 插件，装在内置插件之后（后 provide 的服务覆盖前面的）。无界面宿主的 e2e 用它换上假的
   * LLM / 工具、拿到插件上下文发插件事件；Electron 宿主不用。启动 AI runtime 时才取
   */
  aiPluginsAfter?: () => IgPluginEntry[];
  /** 宿主的本地 TtsProvider（Electron：系统 TTS）；启动 AI runtime 时才建 */
  ttsProviders?: () => TtsProviderLike[];
}

export interface CoreContractOptions {
  /** 宿主片段：要用窗口的过程（只能补内核没有实现的过程） */
  hostHandlers?: (deps: ContractDeps) => Partial<AppHandlers>;
  middleware?: readonly Middleware[];
}

export interface CoreDeps {
  ports: HostPorts;
  /** 根日志；缺省按 `ports.paths.logs()` 新建 */
  logger?: LoggerService;
  config?: CoreConfig;
  host?: CoreHostHooks;
  contract?: CoreContractOptions;
}

/** 内核服务的只读视图（start() 之后才齐） */
export type CoreServices = Readonly<CoreContractServices>;

export interface Core {
  readonly ports: HostPorts;
  readonly logger: LoggerService;
  /** 应用事件总线（已接上契约事件桥）：服务与宿主的窗口控制器 `events.publish(<旧通道>, …)` */
  readonly events: ContractEventBridge;
  /** 配置（config.json）；createCore 时就有，start() 里加载 */
  readonly config: ConfigService;
  readonly container: IServiceContainer;
  readonly services: CoreServices;
  /** 应用契约的 router；start() 之后才有，之前读取会抛错 */
  readonly router: Router<AppContract>;
  /** start() 走完后为 true */
  readonly started: boolean;
  /** 建服务、启动 AI runtime、组装 router；宿主就绪（Electron：app ready）之后调用 */
  start(): Promise<void>;
  /** 提醒与定时任务：能播报的界面就绪（Electron：看板娘窗口建好）后调用；无界面宿主在 start() 后调用 */
  startReminders(): void;
  /** 停止后台服务、落盘；重入安全，带总超时 */
  stop(): Promise<void>;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 有官方账号的编程助手（清单 capabilities.officialAccount，见 cli/accounts/types.ts） */
function isAccountKind(k: string): k is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(k);
}

/** 没有自动更新的宿主：检查更新永远没有结果（打包状态由 ports.app 决定，开发态本来就是 unavailable） */
function noopUpdater(): UpdaterLike {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    logger: null,
    checkForUpdates: async () => null,
    downloadUpdate: async () => [],
    quitAndInstall: () => undefined,
    on: () => undefined,
    removeAllListeners: () => undefined,
  };
}

export function createCore(deps: CoreDeps): Core {
  const { ports } = deps;
  const host = deps.host ?? {};
  const cfg = deps.config ?? {};
  const logger = deps.logger ?? new LoggerService({ ports });
  const userData = (...p: string[]) => path.join(ports.paths.userData(), ...p);

  const container = new ServiceContainer();
  container.registerSingleton(HOST_PORTS, () => ports);
  container.registerSingleton('logger', () => logger);
  // 应用事件 → 契约事件（router 建好后 attach）；只推给订阅了的窗口
  const events = createContractEventBridge(null, APP_EVENT_BRIDGE, logger);
  container.registerSingleton(APP_EVENTS, () => events);
  const config = new ConfigService({ ports, logger });
  container.registerSingleton('config', () => config);
  const cache = new CacheService({ maxSize: 500, defaultTtl: 10 * 60 * 1000 }, logger);
  container.registerSingleton('cache', () => cache);

  /** 有后台定时器 / 子进程 / 监听端口 / worker 的服务，stop() 时逆序停止 */
  const lifecycle = new LifecycleRegistry();
  lifecycle.register({ name: 'cache', stop: () => cache.destroy() });
  /** 契约处理函数在调用时读取的服务实例（创建服务时登记） */
  const services: CoreContractServices = { config, callerWindows: host.callerWindows };

  let appRouter: AppRouterHandle | undefined;
  let started = false;
  let starting: Promise<void> | undefined;
  /** stop() 时按顺序停的服务（不在 lifecycle 里的） */
  const stoppers: Array<() => void | Promise<void>> = [];

  const contractDeps: ContractDeps = { services, ports, events, logger };

  /** 用户可见的 AI 补全（知识库 / 记忆 / 日程）：AI runtime 没起来时报「AI 服务未就绪」 */
  const complete = async (
    messages: unknown,
    signal?: AbortSignal,
    role: 'chat' | 'summary' = 'chat',
  ): Promise<string> => {
    const rt = services.aiRuntime;
    if (!rt) throw new Error(tr('electron.common.ai-service-not-ready'));
    const resp = await rt.client.chat.sendMessage({ role, messages, signal } as never);
    return typeof resp?.content === 'string' ? resp.content : '';
  };

  /** 旧版 displayMode（'live2d' / 'custom-image'）不再使用：读取到就删掉，避免残留配置 */
  const migrateLegacyDisplayMode = (): void => {
    try {
      const legacy = config.get<unknown>('displayMode', undefined);
      if (legacy === undefined) return;
      config.set('displayMode', undefined);
      void config.save();
      logger.info('已清理旧的显示模式配置', { legacy });
    } catch (error) {
      logger.warn('清理旧显示模式配置失败', { error: errorMessage(error) });
    }
  };

  /**
   * 人设服务（§10.4）：当前角色包优先，内置角色包兜底；角色包重新解析或界面语言变化时重新取人设，
   * 有变化才推送给窗口。
   */
  const startPersona = (characterPack: CharacterPackService): PersonaService => {
    const plog = createMainLogger('persona');
    const persona = new PersonaService({
      sources: [
        packPersonaSource(() => characterPack.getResolved(), { logger: plog }),
        packPersonaSource(() => characterPack.getBuiltin(), { id: 'builtin-pack', logger: plog }),
        neutralPersonaSource(),
      ],
      locale: getLocale,
      logger: plog,
    });
    characterPack.onChange(() => persona.reload());
    const offLocale = onLocaleChange(() => persona.localeChanged());
    if (typeof offLocale === 'function') stoppers.push(offLocale);
    forwardPersonaChanges(persona, (channel, payload) => events.publish(channel, payload));
    const p = persona.get();
    logger.info(`persona: ${p.characterId} (${p.displayName})`);
    return persona;
  };

  const doStart = async (): Promise<void> => {
    // 配置先加载（窗口位置、看板娘大小等由宿主在建窗口时读）
    await config.load();
    // 朗读配置服务（契约 `tts.*`）与旧配置清理
    services.tts = new TtsService({ paths: ports.paths, logger, events });
    migrateLegacyDisplayMode();
    cache.set('app:config', config.getConfig(), 30 * 60 * 1000);
    cache.set(
      'app:info',
      { version: ports.app.version(), name: ports.app.name(), isPackaged: ports.app.isPackaged() },
      60 * 60 * 1000,
    );

    // 界面语言（默认跟随系统：zh* → 中文，其余 → English）；须早于托盘 / 通知等主进程文案
    services.locale = new LocaleService({ file: userData('locale.json'), ports, events });

    // 角色包：userData/character-pack → resources/character-pack → 内置包（默认 characters/nomi）
    const characterPack = new CharacterPackService({ ports });
    if (host.characterPackProtocol) characterPack.init(host.characterPackProtocol, logger);
    else characterPack.reload(logger);
    services.characterPack = characterPack;
    // 角色人设唯一来源（当前角色包 → 内置角色包），须早于 AI runtime 与界面窗口
    services.persona = startPersona(characterPack);

    // 自动更新：检查与下载状态在内核，安装重启由宿主的 updater 做（§7.2）
    const updates = new UpdateService(logger, {
      ports,
      events,
      updater: host.updater ?? noopUpdater(),
    });
    services.updates = updates;
    updates.start();
    stoppers.push(() => updates.stop());

    // 桌面能力（文件工具的权限 / 审计 / 撤销）：先于 AI runtime，插件注册工具时要用
    const desktop = createDesktopService(logger, {
      ports,
      events,
      ...(host.browser ? { browser: host.browser as never } : {}),
    });
    services.desktop = desktop;
    if (host.desktopWindows) desktop.attachWindows(host.desktopWindows);

    // 本地知识库：先于 AI runtime 创建（kb_search 工具随桌面工具注册），LLM 调用延迟绑定
    const kb = new KnowledgeService({
      root: userData('knowledge'),
      logger: logger as never,
      desktop,
      ports,
      events,
      listProviders: () => services.aiRuntime?.listProviders() ?? [],
      credentials: (id) => services.aiRuntime?.providerCredentials(id) ?? null,
      chatProvider: () => desktop.providerFor('chat'),
      complete: (messages, signal) => complete(messages, signal),
    });
    services.kb = kb;
    lifecycle.register({ name: 'knowledge', stop: () => kb.dispose() });
    lifecycle.register({ name: 'reminders', stop: () => desktop.reminders.stop() });

    // 长期记忆：对话摘要 + 召回（复用知识库的 BM25 / 向量服务），工具随桌面工具注册
    const mem = new MemoryService({
      root: userData('memory'),
      logger: logger as never,
      desktop,
      ports,
      events,
      complete: (messages, signal) => complete(messages, signal),
      embed: (texts) => kb.embedTexts(texts),
      facade: () => (services.aiRuntime?.client.memory as never) ?? null,
    });
    services.mem = mem;
    stoppers.push(() => mem.flush());

    // 主动日程：免打扰 / 系统通知策略、定时任务（每日简报）、主动聊天（默认关闭）
    const sched = new SchedulerService({
      root: userData('schedule'),
      logger: logger as never,
      desktop,
      ports,
      events,
      complete: (messages, signal) => complete(messages, signal),
      memory: async (q) => (await mem.context(q)).text,
      openChat: () => void ports.windows.open('chat'),
    });
    services.sched = sched;
    stoppers.push(() => sched.stop());

    // 图片发送前的云端告知 / 仅本地检查；顺带清掉旧版本的屏幕记忆目录
    services.screen = new ScreenService({
      root: userData('screen-memory'),
      logger: logger as never,
      desktop,
    });

    // 扩展：GUI 管理的 MCP 服务器 + SKILL.md 技能包
    const ext = new ExtensionsService({
      root: userData('extensions'),
      skillsRoot: userData('skills'),
      logger: logger as never,
      desktop,
      ports,
      events,
    });
    services.ext = ext;

    // 本地数据导出；本地模型管理（llama.cpp + Ollama）
    services.localHub = new LocalHubService({
      root: userData('local'),
      userData: ports.paths.userData(),
      logger: logger as never,
      desktop,
      ports,
      events,
    });
    const localLlm = new LocalModelService({
      root: userData('local'),
      logger: logger as never,
      desktop,
      gateway: () => services.gateway ?? null,
      events,
    });
    services.localModels = localLlm;
    stoppers.push(() => void localLlm.stop());

    // 界面主题（设置 → 通用 → 主题），对话窗口与看板娘同步
    services.theme = new ThemeService({ file: userData('theme.json'), ports, events });
    // 图片主题背景（设置 → 通用 → 主题 → 图片主题）
    services.chatBg = new ChatBackgroundService({
      file: userData('chat-background.json'),
      imagesDir: userData('chat', 'images'),
      presetFile:
        cfg.chatBackgroundPresetFile ??
        path.join(ports.paths.resources(), 'assets', 'backgrounds', 'nomi-preset.jpg'),
      ports,
      events,
    });

    // 首次启动引导（语言 / 主题 / 声音 / 称呼与语气 / 供应商 / 隐私），显示在对话窗口里
    services.onboarding = new OnboardingService({
      userData: ports.paths.userData(),
      openChat: () => ports.windows.open('chat'),
      events,
      liveWindows: host.liveWindows,
    });

    // 启动后默认界面（看板娘 / 软件主界面）：设置与引导里都能改；怎么开窗口是宿主的事
    services.startup = new StartupService({ file: userData('startup.json'), events });

    // 用量与计费：Nomi 对话 / 本地路由 / 编程工具会话日志，全部只存本机
    const usage = new UsageService({
      root: userData('usage'),
      logger: logger as never,
      events,
      providerName: (id) => services.aiRuntime?.listProviders().find((p) => p.id === id)?.name,
      // Grok 额度指纹用账号模块记录的身份（来自 CLI 自己报告），不读 auth.json（§5.10 S7）
      grokAccountKey: () => accounts.identityKey('grok'),
      // 模型数据同步（models.dev）：同一份下载同时更新价格表与网关的模型目录
      onModelsData: (api) => services.gateway?.applyModelsData(api),
      needsFullModelsData: () => {
        const g = services.gateway;
        return g ? !g.hasCatalogSync() : false;
      },
      // 额度跟着默认官方账号走：取额度的官方 CLI 在默认账号的账号目录里运行（§5.10）
      officialAccount: (kind, prepare) => {
        if (!prepare) return { dir: accounts.defaultDir(kind), args: [] };
        const l = accounts.officialLaunch(kind, null);
        return { dir: l.dir, args: l.args };
      },
      // 预算 / 单任务提醒：看板娘气泡（只显示，不朗读）或灵动岛 / 系统通知；免打扰中不弹，稍后重试
      alert: (a) => {
        if (desktop.notifyPolicy?.quiet() ?? false) return false;
        desktop.notify({
          kind: 'info',
          status: 'attention',
          title: a.title,
          body: a.text,
          text: a.text.slice(0, 140),
          bubble: { voice: 'none' },
        });
        return true;
      },
    });
    services.usage = usage;
    usage.start();
    stoppers.push(() => usage.stop());

    const agents = new AgentProgressService({
      root: userData('agents'),
      logger: logger as never,
      events,
      desktop,
      isQuiet: () => desktop.notifyPolicy?.quiet() ?? false,
      // CodingMonitor 显示会话累计用量；任务结束播报（总结播报开着时）附带「本次花费」
      usageOf: (source, session) => usage.sessionUsage(source as never, session) ?? null,
      taskCost: async (q) => {
        // 日志有延迟：先追平一次再算（路由 / Nomi 对话的记录本来就是即时的）
        await usage.scan().catch(() => undefined);
        return usage.taskCostLine({
          source: q.source as never,
          session: q.session,
          since: q.since,
        });
      },
    });
    services.agents = agents;
    if (agents.state().settings.enabled) agents.start();
    stoppers.push(() => agents.stop());

    // 编程助手 CLI 接入 P0：版本更新 / 供应商桥 / 对话后端接管
    const cliUpdate = new CliUpdateService({
      root: userData('cli-update'),
      logger: logger as never,
      events,
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
    services.cliUpdate = cliUpdate;
    // 编程助手插件宿主（docs/design/cli-plugin-architecture.md §5、§7）：清单校验、有效能力、注册表快照
    const cliPlugins = new CliPluginHost({
      root: userData('cli-plugins'),
      logger: logger as never,
      events,
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
    services.cliPlugins = cliPlugins;
    void cliPlugins.start();
    // 终端里升级了 CLI 也要发现：每 30 分钟重读一次版本（每个 CLI 起一次 --version）
    const versionTimer = setInterval(() => void cliPlugins.refreshVersions(), 30 * 60_000);
    versionTimer.unref?.();
    lifecycle.register({
      name: 'cli-plugins',
      stop: () => {
        clearInterval(versionTimer);
        cliPlugins.stop();
      },
    });
    const cliRoot = userData('cli-providers');
    // 统一网关（docs/design/unified-gateway.md）：首次启动从旧存储迁移，网关跑在宿主的工具子进程里。
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
      userData: ports.paths.userData(),
      logger,
      ports,
      traceDir: userData('gateway', 'trace'),
      legacyEnabled: () => readLegacyGatewayTrace(userData('gateway')),
      onChange: () => {
        // 网关正文追踪跟随诊断日志开关（requests 在下面创建；onChange 只在用户切换开关时调用）
        requests.traceStateChanged();
        services.gateway?.refresh();
      },
    });
    // 模型质量（docs/design/model-quality.md）：网关层 / CLI 层的请求质量，只存元数据，受用量总开关控制
    const providerOf = (pid: string) =>
      services.gateway?.store.providers().find((x) => x.id === pid);
    const quality = new QualityService({
      dir: userData('usage', 'quality'),
      logger: logger as never,
      events,
      ports,
      enabled: () => usage.getSettings().enabled ?? true,
      cost: (model, tokens) => usage.costOf(model, tokens),
      labelOf: (dim, key) => {
        if (dim === 'provider') return providerOf(key)?.name;
        if (dim !== 'key') return undefined;
        const [pid = '', kid = ''] = key.split('\u0000');
        const k = providerOf(pid)?.keys.find((x) => x.id === kid);
        return k ? (k.name ?? k.masked) : undefined;
      },
    });
    services.quality = quality;
    lifecycle.register({ name: 'model-quality', stop: () => quality.dispose() });
    // 网关正文追踪目录（跟随诊断日志开关）；旧「最近请求」导入模型质量账本一次后删除
    const requests = new GatewayRequestLog({
      root: userData('gateway'),
      logger: logger as never,
      traceOn: () => diagnostics.bodyTrace(),
      importLegacy: (records) => quality.importLegacy(records),
    });
    services.diagnostics = diagnostics;
    lifecycle.register({ name: 'gateway-requests', stop: () => requests.dispose() });
    const gateway = new GatewayService({
      root: userData('gateway'),
      processes: ports.processes,
      ...(cfg.gatewayPort !== undefined ? { port: cfg.gatewayPort } : {}),
      cipher: createSafeStorageCipher(safeStorageFromSecrets(ports.secrets)),
      logger: logger as never,
      // 网关事件不计入用量账本（CLI 以会话日志为准），进模型质量
      onUsage: (e) => quality.addGateway(e),
      traceDir: () => requests.traceDir(),
      presetQuirks: (id) => findPreset(id)?.quirks as ProviderQuirks | undefined,
      presetModels: (id) => findPreset(id)?.modelMeta,
      longContextPrice: (model) => usage.longContextPrice(model),
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
              ...(c.defaultModel && c.defaultModel !== 'default' ? { model: c.defaultModel } : {}),
            };
          })
          .filter((e) => e.url),
      legacy: {
        nomiFile: userData('ai-providers.json'),
        cliRoot,
        cliDecrypt: legacyCliKeyDecryptor(ports.secrets),
        normalizeNomi: (raw) => migrateStoreData(raw).data,
        token: legacyToken,
        // 旧本地路由不再启动：网关接管它的端口
        routeListening: () => false,
      },
      broadcast: (channel, payload) => events.publish(channel, payload),
    });
    services.gateway = gateway;
    // 先迁移（读旧存储里「启用中」的标记），再撤销旧版本写进全局配置的东西（会清掉这些标记）
    gateway.init();
    // 启动时自动同步模型数据（用户可在「模型」页关闭；距上次核对不足 12 小时不联网）
    if (cfg.autoSyncModels !== false)
      void usage.autoSync().catch((e) => logger.warn('models data auto sync failed', e));
    // 终端启动命令（unified-gateway §12.6，默认关）：端口 / 令牌 / 分配变化时重新生成脚本
    const terminal = new TerminalCommands({
      root: userData('gateway'),
      source: gatewayTerminalSource(gateway),
      logger: logger as never,
    });
    services.terminal = terminal;
    terminal.refresh();
    gateway.onChange(() => terminal.refresh());
    try {
      legacyRevoke = revokeLegacyGlobalConfig({
        home: os.homedir(),
        cliRoot,
        backupRoot: userData('gateway', 'backups'),
        decrypt: legacyCliKeyDecryptor(ports.secrets),
        logger: logger as never,
      });
      gateway.setLegacyRevoke(legacyRevoke);
    } catch (e) {
      logger.warn('revoke legacy CLI config failed', e);
    }
    lifecycle.register({ name: 'gateway', stop: () => gateway.dispose() });
    // 官方账号（docs/design/cli-plugin-architecture.md §5.10）：一个账号 = 一个 CLI 配置目录，Nomi 不经手凭据。
    // 改默认账号只重启跟随默认的官方标签；第三方标签与网关不受影响（S5、S6）
    const accounts: AccountService = new AccountService({
      root: userData('cli-accounts'),
      logger: logger as never,
      events,
      onDefaultChanged: (kind) => {
        harness.recycleDefaultAccount(kind);
        // 换了号：上一个账号的订阅额度不能再显示
        usage.forgetAccountQuota(kind);
      },
      inUse: (kind, id) =>
        harness.officialAccountTabs(kind).filter((a) => accounts.resolve(kind, a) === id).length,
      onChanged: () => accounts.broadcastChanged(),
    });
    const harness = new HarnessOrchestrator({
      root: userData('harness'),
      logger: logger as never,
      defaultCwd: ports.paths.documents(),
      // 第三方会话经统一网关按进程注入（docs/design/unified-gateway.md §12），不写 CLI 全局配置
      gateway: harnessGateway(gateway),
      // 模型质量 CLI 层：Nomi 里运行的编程助手（官方账号与第三方）每轮一条（model-quality.md §4.4）
      quality: { addCli: (r) => void quality.addCli(r) },
      ports,
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
      // 右栏「生成提交信息」：先用 Nomi 的辅助模型（没设时跟主模型）；Nomi 没配模型时用当前编程助手标签的
      // 第三方模型。都经网关所以受外发保护，也都遵守「仅本地模型可读文件」，发往云端前按设置确认
      complete: async (messages, signal, tab) => {
        const rt = services.aiRuntime;
        const own = rt?.resolveProvider('summary') ? desktop.providerFor('summary') : null;
        const via = own ? null : tab ? gateway.helperRoute(tab.kind, tab.model) : null;
        if (!rt && !via) throw new Error(tr('electron.common.ai-service-not-ready'));
        if (!own && !via)
          throw Object.assign(new Error('no model for Nomi or this tab'), { code: 'no-model' });
        const send = await desktop.broker.checkSend(
          own ?? via!.receiver,
          signal,
          tr('electron.common.code-changes'),
        );
        if (send === 'local_only')
          throw new Error(tr('electron.common.only-local-models-can-read-files-is-on'));
        if (send === 'user_denied') throw new Error(tr('electron.common.ok-not-sending'));
        if (via) return gateway.helperComplete(via.model, messages, signal);
        return complete(messages, signal, 'summary');
      },
    });
    services.accounts = accounts;
    const accountLogin = new AccountLogin({
      accounts,
      logger: logger as never,
      emit: loginBroadcaster(events),
      ports,
    });
    services.accountLogin = accountLogin;
    lifecycle.register({ name: 'cli-account-login', stop: () => accountLogin.dispose() });
    services.harness = harness;
    lifecycle.register({ name: 'cli-harness', stop: () => harness.dispose() });
    // Nomi 对话的权限模式（输入栏的权限按钮）作用在 Nomi 自己的工具上；「完全放开」不适用
    desktop.broker.permissionMode = () => {
      const m = harness.mainPermissionMode();
      return m === 'bypass' ? 'acceptEdits' : m;
    };
    // Nomi 把编程助手当子代理调用（工具 delegate_to_cli、/cli、设置 →「编程助手」→「委派」）
    services.delegate = new DelegateService({
      root: userData('delegate'),
      harness,
      desktop,
      gateway: harnessGateway(gateway),
      events,
    });
    services.history = new SessionHistoryService({
      logger: logger as never,
      openKeys: () => harness.openSessionKeys(),
      openTitle: (backend, sessionId, title) =>
        harness.syncOpenSessionTitle(backend, sessionId, title),
      openTab: (o) => harness.openHistorySession(o),
      trash: (p) => ports.shell.trashItem(p),
      gatewaySession: (backend, sessionId) => gateway.servedSession(backend, sessionId),
      // Nomi 记下的优先；Claude 会话还能从网关的会话归属表里找回
      sessionModel: (backend, sessionId) =>
        harness.sessionModel(backend, sessionId) ?? gateway.servedSessionRef(backend, sessionId),
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
    });
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

    // 启动 AI runtime（在宿主挂传输、创建窗口之前）；失败只记日志，其余域照常可用
    services.aiRuntime = await bootAIRuntime();
    // 应用契约（AI 门面 + 各域 + 宿主片段）；宿主随后把 core.router 挂到传输上
    startContract();
    const rt = services.aiRuntime;
    if (rt) {
      desktop.attachRuntime({
        resolveProvider: (role) => rt.resolveProvider(role),
        lookupProvider: (id) => rt.lookupProvider(id),
        complete: async (messages, role, signal) => {
          const resp = await rt.client.chat.sendMessage({ role, messages, signal });
          return typeof resp?.content === 'string' ? resp.content : '';
        },
      });
    }
    void ext.start();
    void localLlm.autoStart();

    // 语音输入：本地 whisper.cpp / OpenAI 兼容识别、按需下载模型、打断 TTS、唤醒词
    services.voice = new VoiceService({
      root: userData('voice'),
      secrets: ports.secrets,
      logger: logger as never,
      providers: () => rt?.listProviders() ?? [],
      credentials: (id) => rt?.providerCredentials(id) ?? null,
      localOnly: () => desktop.broker.view().localOnly,
      audit: (e) => desktop.audit.append({ ...e, source: 'voice' }),
      ...(host.voiceChatWindow ? { openChat: host.voiceChatWindow } : {}),
      events,
    });

    // 知识库 / 记忆不依赖看板娘窗口：先于窗口启动，对话窗口并行打开时召回与授权变化即刻可用
    kb.start();
    mem.start();
  };

  /** AI runtime（插件宿主 + AI 门面的契约处理函数）；失败时记录日志但不抛出 */
  const bootAIRuntime = async (): Promise<AIRuntimeBootHandle | undefined> => {
    try {
      const handle = await startAIRuntime(logger, {
        ports,
        profile: cfg.aiProfile,
        events,
        hostPlugins: host.aiPlugins?.(),
        hostPluginsAfter: host.aiPluginsAfter?.(),
        ttsProviders: host.ttsProviders?.(),
        services: {
          gateway: () => services.gateway,
          usage: () => services.usage,
          ext: () => services.ext,
          persona: () => services.persona,
        },
        desktopTools: {
          desktop: () => services.desktop,
          kb: () => services.kb,
          mem: () => services.mem,
          delegate: () => services.delegate,
          ext: () => services.ext,
        },
        // 消息里的附件正文 / 委派汇报按实际接收者过「仅本地 / 云端首次发送」（#149 / #117）
        // signal：用户在确认等待中停止该轮时撤掉还没答复的确认（#160）
        prepareChat: (options, method, signal) =>
          guardOutboundMessages(options.messages, (what) => {
            const desktop = services.desktop!;
            const fallback = method.startsWith('agent') ? 'agent-tools' : 'chat';
            const role =
              options.role === 'chat' ||
              options.role === 'agent-tools' ||
              options.role === 'summary'
                ? options.role
                : fallback;
            return desktop.checkSendAll(desktop.receiversFor(undefined, [role]), signal, what);
          }),
      });
      logger.info('AI runtime 启动完成', {
        profile: handle.profile,
        channelCount: handle.channels.business.length,
      });
      return handle;
    } catch (error) {
      logger.error('AI runtime 启动失败', { error: errorMessage(error) });
      return undefined;
    }
  };

  /** 组装应用契约的 router；事件桥从此把应用事件发成契约事件 */
  const startContract = (): void => {
    const app = createAppRouter({
      deps: contractDeps,
      ai: services.aiRuntime?.ai,
      hostHandlers: deps.contract?.hostHandlers?.(contractDeps),
      middleware: deps.contract?.middleware,
    });
    appRouter = app;
    const detach = events.attach(app.router.events);
    logger.info('应用契约已就绪', {
      procedures: Object.keys(app.router.contract.procedures).length,
      ai: Boolean(services.aiRuntime),
    });
    lifecycle.register({
      name: 'contract',
      stop: () => {
        detach();
        app.dispose();
      },
    });
  };

  const doStop = async (): Promise<void> => {
    logger.info('停止内核...');
    for (const stop of stoppers.splice(0).reverse()) {
      try {
        await stop();
      } catch (error) {
        logger.warn('内核服务停止时出现异常', { error: errorMessage(error) });
      }
    }
    // 其余有后台资源的服务（CLI 子进程树、网关子进程、知识库索引 / OCR worker、缓存定时器…）
    await lifecycle.stopAll(logger);
    const rt = services.aiRuntime;
    services.aiRuntime = undefined;
    if (rt) {
      try {
        await rt.dispose();
      } catch (error) {
        logger.warn('AI runtime 停止时出现异常', { error: errorMessage(error) });
      }
    }
    // 保存配置：退出路径同步落盘最新配置（日常保存走异步写，见 ConfigService.flushOnQuit）
    await config.flushOnQuit();
    // 其余服务排队中的异步私有文件写入（Windows 占用重试不挡主进程，#154）也等它们落盘
    await whenPrivateWritesIdle();
    container.clear();
    logger.info('内核已停止');
  };

  const shutdown = createShutdown({
    work: async () => {
      // 还在启动：等它走完（或失败）再停，避免停到一半又建出服务
      await starting?.catch(() => undefined);
      await doStop();
    },
    timeoutMs: CORE_STOP_TIMEOUT_MS,
    exit: () => undefined,
    onTimeout: () => logger.warn('停止内核超时，放弃等待', { timeoutMs: CORE_STOP_TIMEOUT_MS }),
  });

  return {
    ports,
    logger,
    events,
    config,
    container,
    services,
    get router(): Router<AppContract> {
      if (!appRouter) throw new Error('core router is not ready: call core.start() first');
      return appRouter.router;
    },
    get started() {
      return started;
    },
    start() {
      starting ??= doStart().then(() => {
        started = true;
      });
      return starting;
    },
    startReminders() {
      services.desktop?.startReminders();
      services.sched?.start();
    },
    stop: () => shutdown.stop(),
  };
}
