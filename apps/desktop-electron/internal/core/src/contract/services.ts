/**
 * 契约处理函数能拿到的内核服务实例（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 组合根在创建服务时顺手登记到这里；各域的处理函数在**调用时**读取
 * （`need(deps.services.theme, 'theme')`），所以创建顺序与 router 建好的时间无关。
 * 只放类型引用（`import type`），本文件不加载任何服务模块。
 *
 * 宿主自己的东西（窗口管理器、看板娘窗口操作、灵动岛、应用图标）不进这张表：宿主的契约片段
 * （`createCore` 的 `contract.hostHandlers`）在自己的闭包里拿它们。宿主只经 `callerWindows`
 * 报告调用方窗口的存活（语音会话随窗口释放）。
 */

import type { AgentProgressService } from '../agents/AgentProgressService';
import type { AIRuntimeBootHandle } from '../ai/AIRuntimeBoot';
import type { CharacterPackService } from '../character/CharacterPackService';
import type { ChatBackgroundService } from '../chat/ChatBackgroundService';
import type { AccountLogin } from '../cli/accounts/AccountLogin';
import type { AccountService } from '../cli/accounts/AccountService';
import type { CliPluginHost } from '../cli/CliPluginHost';
import type { CliUpdateService } from '../cli/CliUpdateService';
import type { DelegateService } from '../cli/delegate/DelegateService';
import type { HarnessOrchestrator } from '../cli/harness/Orchestrator';
import type { SessionHistoryService } from '../cli/SessionHistoryService';
import type { PendingEvents } from '../core/pendingEvents';
import type { DesktopService } from '../desktop/DesktopService';
import type { DiagnosticsService } from '../diagnostics/DiagnosticsService';
import type { ExtensionsService } from '../extensions/ExtensionsService';
import type { GatewayService } from '../gateway/GatewayService';
import type { TerminalCommands } from '../gateway/TerminalCommands';
import type { LocaleService } from '../i18n';
import type { KnowledgeService } from '../knowledge/KnowledgeService';
import type { LocalHubService } from '../local/LocalHubService';
import type { LocalModelService } from '../local/LocalModelService';
import type { MemoryService } from '../memory/MemoryService';
import type { OnboardingService } from '../onboarding/OnboardingService';
import type { PersonaService } from '../persona/PersonaService';
import type { SchedulerService } from '../schedule/SchedulerService';
import type { ScreenService } from '../screen/ScreenService';
import type { IConfigService } from '../services/ConfigService';
import type { UpdateService } from '../services/UpdateService';
import type { StartupService } from '../startup/StartupService';
import type { ThemeService } from '../theme/ThemeService';
import type { TtsService } from '../tts/TtsService';
import type { QualityService } from '../usage/quality/QualityService';
import type { UsageService } from '../usage/UsageService';
import type { VoiceService } from '../voice/VoiceService';

import type { CallerWindows } from './media/voiceSenders';

/** 全部可选：服务创建失败（或还没创建）时为 undefined，处理函数用 `need()` 报 UNAVAILABLE */
export interface CoreContractServices {
  config?: IConfigService;
  /** AI runtime（AI 门面、供应商）；启动失败时为 undefined */
  aiRuntime?: AIRuntimeBootHandle;
  /** 宿主报告调用方窗口的存活（Electron：按 webContents id 找窗口）；无界面宿主不提供 */
  callerWindows?: CallerWindows;
  /** 没送达的面板导航 / 拖入总结（`nav.takePending`、`desktop.takePendingSummary`） */
  pendingEvents?: PendingEvents;

  // D1 media
  voice?: VoiceService;
  tts?: TtsService;
  desktop?: DesktopService;
  screen?: ScreenService;

  // D2 shell
  theme?: ThemeService;
  locale?: LocaleService;
  startup?: StartupService;
  onboarding?: OnboardingService;
  gateway?: GatewayService;
  terminal?: TerminalCommands;
  usage?: UsageService;
  quality?: QualityService;
  updates?: UpdateService;
  diagnostics?: DiagnosticsService;

  // D3 coding
  harness?: HarnessOrchestrator;
  cliPlugins?: CliPluginHost;
  cliUpdate?: CliUpdateService;
  accounts?: AccountService;
  accountLogin?: AccountLogin;
  delegate?: DelegateService;
  agents?: AgentProgressService;
  history?: SessionHistoryService;

  // D4 knowledge
  kb?: KnowledgeService;
  mem?: MemoryService;
  sched?: SchedulerService;
  localModels?: LocalModelService;
  localHub?: LocalHubService;
  ext?: ExtensionsService;

  // D5 mascot
  chatBg?: ChatBackgroundService;
  characterPack?: CharacterPackService;
  persona?: PersonaService;
}
