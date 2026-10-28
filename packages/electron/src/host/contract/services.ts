/**
 * 契约处理函数能拿到的服务实例（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 组合根（core/Application.ts）在创建服务时顺手登记到这里；各域的处理函数在**调用时**读取
 * （`need(deps.services.theme, 'theme')`），所以创建顺序与 router 建好的时间无关。
 * 只放类型引用（`import type`），本文件不加载任何服务模块。
 *
 * 本文件属于 P1b 基础，域代理不改；缺实例时用服务模块已有的 `getXxxService()`，或在自己的
 * 域文件里建模块级单例。
 */

import type { AgentProgressService } from '../../agents/AgentProgressService';
import type { AIRuntimeBootHandle } from '../../ai/AIRuntimeBoot';
import type { CharacterPackService } from '../../character/CharacterPackService';
import type { ChatBackgroundService } from '../../chat/ChatBackgroundService';
import type { AccountLogin } from '../../cli/accounts/AccountLogin';
import type { AccountService } from '../../cli/accounts/AccountService';
import type { CliPluginHost } from '../../cli/CliPluginHost';
import type { CliUpdateService } from '../../cli/CliUpdateService';
import type { DelegateService } from '../../cli/delegate/DelegateService';
import type { HarnessOrchestrator } from '../../cli/harness/Orchestrator';
import type { SessionHistoryService } from '../../cli/SessionHistoryService';
import type { WindowManager } from '../../core/WindowManager';
import type { DesktopService } from '../../desktop/DesktopService';
import type { DiagnosticsService } from '../../diagnostics/DiagnosticsService';
import type { ExtensionsService } from '../../extensions/ExtensionsService';
import type { GatewayService } from '../../gateway/GatewayService';
import type { TerminalCommands } from '../../gateway/TerminalCommands';
import type { IpcRegistry } from '../../handlers/ipc/IpcRegistry';
import type { LocaleService } from '../../i18n';
import type { IslandService } from '../../island/IslandService';
import type { KnowledgeService } from '../../knowledge/KnowledgeService';
import type { LocalHubService } from '../../local/LocalHubService';
import type { LocalModelService } from '../../local/LocalModelService';
import type { MemoryService } from '../../memory/MemoryService';
import type { OnboardingService } from '../../onboarding/OnboardingService';
import type { PersonaService } from '../../persona/PersonaService';
import type { SchedulerService } from '../../schedule/SchedulerService';
import type { ScreenService } from '../../screen/ScreenService';
import type { IConfigService } from '../../services/ConfigService';
import type { UpdateService } from '../../services/UpdateService';
import type { StartupService } from '../../startup/StartupService';
import type { ThemeService } from '../../theme/ThemeService';
import type { QualityService } from '../../usage/quality/QualityService';
import type { UsageService } from '../../usage/UsageService';
import type { VoiceService } from '../../voice/VoiceService';

/** 全部可选：服务创建失败（或还没创建）时为 undefined，处理函数用 `need()` 报 UNAVAILABLE */
export interface ContractServices {
  // 宿主 / 旧注册层
  windowManager?: WindowManager;
  config?: IConfigService;
  /** 旧 IPC 处理器（handlers/ipc/*），迁移期间复用其中的逻辑 */
  ipcRegistry?: IpcRegistry;
  aiRuntime?: AIRuntimeBootHandle;

  // D1 media
  voice?: VoiceService;
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
  island?: IslandService;
  chatBg?: ChatBackgroundService;
  characterPack?: CharacterPackService;
  persona?: PersonaService;
}

/** 组合根持有的可写实例；处理函数只读 */
export function createContractServices(): ContractServices {
  return {};
}
