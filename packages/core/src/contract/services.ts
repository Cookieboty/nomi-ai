/**
 * 契约处理函数能拿到的内核服务实例（docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 *
 * 组合根在创建服务时顺手登记到这里；各域的处理函数在**调用时**读取
 * （`need(deps.services.theme, 'theme')`），所以创建顺序与 router 建好的时间无关。
 * 只放类型引用（`import type`），本文件不加载任何服务模块。
 *
 * 宿主自己的槽位（窗口管理器、看板娘窗口操作、灵动岛、AI runtime 句柄）在宿主的
 * `ContractServices`（electron `host/contract/services.ts`）里扩展。
 */

import type { AgentProgressService } from '../agents/AgentProgressService';
import type { CharacterPackService } from '../character/CharacterPackService';
import type { ChatBackgroundService } from '../chat/ChatBackgroundService';
import type { AccountLogin } from '../cli/accounts/AccountLogin';
import type { AccountService } from '../cli/accounts/AccountService';
import type { CliPluginHost } from '../cli/CliPluginHost';
import type { CliUpdateService } from '../cli/CliUpdateService';
import type { DelegateService } from '../cli/delegate/DelegateService';
import type { HarnessOrchestrator } from '../cli/harness/Orchestrator';
import type { SessionHistoryService } from '../cli/SessionHistoryService';
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
import type { QualityService } from '../usage/quality/QualityService';
import type { UsageService } from '../usage/UsageService';
import type { VoiceService } from '../voice/VoiceService';

/** 全部可选：服务创建失败（或还没创建）时为 undefined，处理函数用 `need()` 报 UNAVAILABLE */
export interface CoreContractServices {
  config?: IConfigService;

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
  chatBg?: ChatBackgroundService;
  characterPack?: CharacterPackService;
  persona?: PersonaService;
}
