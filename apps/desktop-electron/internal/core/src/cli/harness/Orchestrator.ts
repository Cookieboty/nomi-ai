/**
 * HarnessOrchestrator：编程助手编排（标签、排队、持久化、事件分发）。
 * 对话后端：Nomi | Claude Code | Codex | dsh | Grok，按「标签」并发运行。
 *
 * - 标签 'main'：原有对话，后端可为 Nomi 或任一 CLI；消息由渲染层存进 Nomi 历史。
 *   旧的单会话接口（state / setBackend / setCwd / send）都作用于它。
 * - 其它标签：只绑定 CLI 后端，带独立的 CLI 会话与 cwd，消息存于 harness/tabs/<id>.json。
 * - 各标签可同时运行（已取消「最多同时运行」全局排队上限）。
 * - CLI 模式下禁用 Nomi 工具（send 不走 AIClient）。
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUILTIN_MANIFESTS, isBuiltinCliId, type BuiltinCliId } from '@nomi-ai/cli-plugins';
import {
  acpMetaContext,
  BUILTIN_CLI_IDS,
  claude as claudePlugin,
  codex as codexPlugin,
  createClaudeParser,
  createDshParser,
  createGrokParser,
  dsh as dshPlugin,
  gemini as geminiPlugin,
  grok as grokPlugin,
  parseCodexLine,
  parseUsage,
} from '@nomi-ai/cli-plugins/main';
import {
  AcpDriver,
  AppServerDriver,
  buildTrace,
  codexExecItem,
  codexTurnPolicy,
  compactOldTraces,
  MAX_TAB_FILE_BYTES,
  mergeUsage,
  stampEvent,
  ExecDriver,
  RPC_EXITED,
  StreamJsonDriver,
  missingExternalEnv,
  renderExternalArgs,
  type ChildLike,
  type ExecRules,
  type ExternalCliSpec,
  type TurnResult,
} from '@nomi-ai/cli-sdk';
import type { HostPorts } from '@nomi-ai/host-ports';
import { brand, type QualityOutcome, type QualityRecord } from '@nomi-ai/types';

import type { AppEventName, AppEvents } from '../../core/appEvents';
import { t } from '../../i18n';
import { claudeConfigDir } from '../../usage/cliHomes';
import { qualityLedgerInput } from '../../usage/quality/cliTokens';
import { CoalescedWriter, flushPendingWritesSync } from '../../utils/coalescedWriter';
import { writePrivateFile } from '../../utils/privateFile';
import { cleanCommitMessage, commitMessagePrompt } from '../commitMessage';
import { codexConfigPath, grokHomePath } from '../configPatch';
import {
  buildCarriedContext,
  carriedBudget,
  fitCarried,
  withCarriedContext,
} from '../contextCarry';
import { DSH_MIN_NODE_MAJOR, peekCliBin, readPathNodeVersion, refreshCliBin } from '../detect';
import { EventBatcher } from '../eventBatcher';
import { acpTimeoutMessage, innermostMessage } from '../gemini/acp';
import { GeminiUntrustedError, isGeminiUntrustedExit } from '../gemini/trust';
import {
  type GeminiTrustResult,
  isBroadGeminiFolder,
  trustGeminiFolder,
} from '../gemini/trustedFolders';
import {
  gitCommit,
  gitCommitContext,
  gitCommitUndo,
  gitDiscard,
  gitDiscardUndo,
  gitFetch,
  gitPull,
  gitPush,
  gitStage,
  gitSyncStatus,
  gitUnstage,
  gitWorktrees,
  ownedWorktrees,
} from '../gitOps';
import { pickIdle, resolveIdleReclaimMs, sweepIntervalMs } from '../idleReclaim';
import {
  effortsForModel,
  isValidModelId,
  isReasoningEffort,
  overrideArgs,
  sanitizeEffort,
  supportsModelOverride,
  type BackendModelCatalog,
  type CatalogModel,
} from '../modelCatalog';
import { discoverModels } from '../modelDiscovery';
import {
  DEFAULT_PERMISSION_MODE,
  claudeModeName,
  effectiveMode,
  acpModeId,
  fromCliPermissionMode,
  isPermissionMode,
  permissionLaunch,
  planPromptPrefix,
} from '../permissionMode';
import { killProcessTree } from '../processTree';
import {
  acpPromptParts,
  cleanupStagedDir,
  claudeContentBlocks,
  codexImageArgs,
  codexTurnInput,
  grokPromptFileArgv,
  imageSupportFor,
  modelNoVisionMessage,
  rejectedImagesMessage,
  imageThumbsForMessage,
  inspectImages,
  stageImages,
  unsupportedImageMessage,
  type HarnessImageInput,
  type NormalizedImage,
  type StagedImage,
} from '../promptImages';
import { SessionModelTable } from '../sessionModels';
import {
  discoverSlash,
  expandSlash,
  gitBranch,
  gitDiff,
  type SlashBackend,
} from '../slashDiscovery';
import '../pluginI18n';
import { foldAssistantEvent } from '../textCursor';
import { claudeRewindPoint, claudeTranscriptContext } from '../transcriptContext';
import type {
  HarnessBackend,
  HarnessEvent,
  HarnessPermissionMode,
  HarnessSendReply,
  HarnessSendResult,
  HarnessSessionState,
  HarnessTabMessage,
  HarnessTabMeta,
  HarnessTabSource,
  HarnessTabsState,
  HarnessUsage,
} from '../types';
import {
  deleteWorkspaceFile,
  gitCheckoutWorkspaceFile,
  listWorkspaceTree,
  readWorkspaceFile,
  writeWorkspaceFile,
} from '../workspaceFiles';

import {
  loadImageAliases,
  materializeGeneratedImages,
  rewriteGeneratedImageLinks,
} from './generatedImages';
import {
  DELEGATED_PERMISSION_TIMEOUT_MS,
  MAIN_TAB_ID,
  PERMISSION_TIMEOUT_MS,
  HarnessStoppedError,
  type AccountBackend,
  type HarnessExternalPlugins,
  type HarnessGateway,
  type HarnessOfficialAccounts,
  type HarnessTabFinished,
} from './liveTypes';
import {
  EXECUTE_PLAN_FOLLOW_UP,
  approvePlanMode,
  executePlanEvent,
  isExecutePlanId,
  markApprovePlanIfExit,
  withPermissionExpiry,
  type ApprovePlanChoice,
} from './permissionQueue';
import { cliChildEnv, isScript, peekHarnessBin, resolveHarnessBin, spawnHarness } from './spawn';
export type {
  AccountBackend,
  HarnessExternalPlugins,
  HarnessGateway,
  HarnessOfficialAccounts,
  HarnessTabFinished,
} from './liveTypes';
export { DELEGATED_PERMISSION_TIMEOUT_MS, MAIN_TAB_ID, HarnessStoppedError } from './liveTypes';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

type CliBackend = Exclude<HarnessBackend, 'nomi'>;
/** 内置编程助手（有网关第三方、官方账号、exec 退路等）；外部插件（'external'）没有这些 */
type BuiltinBackend = BuiltinCliId;

/** 一次启动的来源注入（见 launchFor） */
interface TabLaunch {
  env: Record<string, string>;
  args: string[];
  strip: readonly string[];
  official: boolean;
  modelInConfig: boolean;
  /** 长驻进程复用键的一部分 */
  sig: string;
  /**
   * 跟着模型走的辅助变量（Claude 的各档位 / 小模型 / 子代理模型）。只换主模型时 set_model 改不到它们，
   * 变了就要重启进程（#99）；与 sig 分开，后台任务还在跑时可以先沿用旧进程。
   */
  modelSig: string;
}

/** 有官方账号的后端（类型见 liveTypes） */
const ACCOUNT_BACKENDS: readonly string[] = ['claude', 'codex', 'grok', 'gemini'];
const isAccountBackend = (b: string): b is AccountBackend => ACCOUNT_BACKENDS.includes(b);

/** 官方来源、没有账号服务时的启动注入（见 launchFor） */
const OFFICIAL_LAUNCH: TabLaunch = {
  env: {},
  args: [],
  strip: [],
  official: true,
  modelInConfig: false,
  sig: 'official',
  modelSig: '',
};

/** 第三方来源在 modelScope / modelByScope 里的键 */
const GATEWAY_SCOPE = 'gateway';

/** 每轮一个进程（exec）的收尾规则：哪个事件算整轮完成，由各 CLI 插件给出 */
const EXEC_RULES: Record<BuiltinBackend, ExecRules> = {
  claude: claudePlugin.execRules,
  codex: codexPlugin.execRules,
  dsh: dshPlugin.execRules,
  gemini: geminiPlugin.execRules,
  grok: grokPlugin.execRules,
};

// 原来从这里导出的工具函数（测试与账号登录在用）
export { materializeGeneratedImages, rewriteGeneratedImageLinks, resolveHarnessBin };

const MAX_TAB_MESSAGES = 300;
/** Trailing debounce for session.json / tabs.json / tab message files */
const PERSIST_DEBOUNCE_MS = 200;
const MAX_RECENT_CWDS = 8;

const BACKENDS: readonly HarnessBackend[] = ['nomi', ...BUILTIN_CLI_IDS, 'external'];

/** Gemini 一轮 5 分钟没有任何输出：多半卡在网络或上游，取消这一轮 */
const GEMINI_PROMPT_IDLE_MS = 5 * 60_000;
/** Claude control_request（如 set_permission_mode）等 control_response 的上限 */
const CLAUDE_CONTROL_TIMEOUT_MS = 10_000;
/** 停止后等中断那一轮 result 的宽限期；超过就拆进程（下一轮 --resume） */
const CLAUDE_INTERRUPT_GRACE_MS = 5_000;

function isBackend(v: unknown): v is HarnessBackend {
  return typeof v === 'string' && (BACKENDS as readonly string[]).includes(v);
}

/** 标签默认标题：内置插件清单里的名称 */
const BACKEND_TITLE: Record<HarnessBackend, string> = {
  nomi: brand.appName,
  ...(Object.fromEntries(
    BUILTIN_CLI_IDS.map((id) => [id, BUILTIN_MANIFESTS[id].displayName]),
  ) as Record<BuiltinBackend, string>),
  // 外部 CLI 的标签标题用它清单里的名称（createTab）；这里只是兜底
  external: 'CLI',
};

function isGeneratedTabTitle(title: string, backend: BuiltinBackend): boolean {
  const base = BACKEND_TITLE[backend];
  if (title === base) return true;
  return title.startsWith(`${base} `) && /^\d+$/.test(title.slice(base.length + 1));
}

/** 模型目录缓存时长：CLI 升级 / 官方目录更新后最迟这么久会重新读到 */
const MODEL_CATALOG_TTL_MS = 10 * 60_000;

const CLI_BACKENDS: readonly BuiltinBackend[] = BUILTIN_CLI_IDS;

type State = ReturnType<HarnessOrchestrator['state']>;

/** 真实路径（git 给的 worktree 路径已解析软链，如 macOS 的 /var → /private/var）；读不到时原样 */
function realDir(p: string): string {
  try {
    // Windows：只有 native 会把 8.3 短名（RUNNER~1）展开成 git 给出的长名
    const rp = fs.realpathSync;
    return process.platform === 'win32' && rp.native ? rp.native(p) : rp(p);
  } catch {
    return path.resolve(p);
  }
}

/** 编排层用到的宿主端口 */
export type HarnessPorts = Pick<HostPorts, 'dialogs' | 'windows'>;

/**
 * 编排层（docs/design/cli-plugin-architecture.md §5.4）：标签、持久化、来源 / 账号、回收、权限队列与界面广播。
 * 各 CLI 的会话协议在 cli-sdk 的共享驱动里，各 CLI 的差异（档位、账号目录、历史、收尾规则）在
 * @nomi-ai/cli-plugins；对外仍叫 CliHarnessService（Application、IPC、测试不变）。
 */
export class HarnessOrchestrator {
  private readonly tabs = new Map<string, HarnessTabMeta>();
  private readonly messages = new Map<string, HarnessTabMessage[]>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  /** tabId → 当前这一轮最近的输出 / 步骤（轻量进度提示，仅内存；供监视器定时汇总用） */
  private readonly progress = new Map<string, { kind: 'text' | 'tool'; value: string }>();
  /** 每个运行中标签这一轮已收到的文本 / 轨迹事件：中断或失败时据此保留已有进度 */
  private readonly partial = new Map<
    string,
    {
      text: string;
      breaks: number[];
      events: HarnessEvent[];
      /** 最近一次实时上下文占用：中断 / 失败时随消息落盘，重启后上下文环不会退回旧值 */
      context?: HarnessUsage;
      /** 模型质量（CLI 层）：第一个内容 / 第一个正文 / 最后一个内容的时间（epoch ms）、CLI 报的重试次数 */
      q?: TurnQuality;
    }
  >();
  /** 这一轮里长驻 CLI 进程退出了的标签（模型质量记为 cli-exit） */
  private readonly turnExits = new Set<string>();
  /** 用户在排队 / 运行期间点了停止的标签 */
  private readonly stopRequested = new Set<string>();
  /** Nomi 委派建好、但第一轮还没开始发送的标签（建标签到 sendTab 之间有 git 检查等 await） */
  private readonly delegatedUnsent = new Set<string>();
  /** 上面这类标签在开始前就被点了停止：sendTab 一开始就按「已停止」结束，不再发给 CLI */
  private readonly stopBeforeStart = new Set<string>();
  /**
   * 每次发送一个中止令牌（标签 → 这一轮）：从开始运行到这一轮真正发给 CLI 之间（Gemini 握手、
   * 等权限模式确认）点停止，靠它让晚到的握手 / 确认结果不再把这一轮发出去（#75）
   */
  private readonly sendAborts = new Map<string, AbortController>();
  /** 用户接管委派标签时，按标签串行化取消与等待，避免重复发送竞态。 */
  private readonly takeoverInFlight = new Map<string, Promise<void>>();
  /** 实时事件按帧合批后再广播（见 eventBatcher） */
  private readonly eventBatcher = new EventBatcher<HarnessEvent & { tabId: string }>((batch) =>
    this.broadcast('harness.events', batch),
  );
  /** tabId → requestId → timer；超时自动拒绝 */
  private readonly pendingPermissions = new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >();
  private readonly migratedImageTabs = new Set<string>();
  /**
   * Claude 会话级长驻进程：同一标签多轮复用同一子进程（stdin stream-json）。
   * 进程在空闲时仍存活；换 cwd / 后端 / 关标签 / 取消当前轮时拆除。
   * 若 CLI 异常退出，下一轮会带 --resume 重新拉起（会话级复用 + 降级）。
   */
  private readonly claudeLive = new Map<string, ClaudeLiveSession>();
  /** 第三方 Claude 进程正在登记绑定、还没拉起：同一标签的并发调用共用这一次（不签两个令牌） */
  private readonly claudeStarting = new Map<string, Promise<ClaudeLiveSession>>();
  /** 第三方标签当前进程代次与绑定里的主模型（§6.7）：换模型时据此判断要不要更新绑定 */
  private readonly tabBindings = new Map<
    string,
    { generation: number; model: string; modelInConfig?: boolean }
  >();
  /** Gemini ACP 长驻进程（docs/design/cli-official-accounts.md §8）：同一标签多轮复用 */
  private readonly acpLive = new Map<string, AcpLiveSession>();
  /** Codex app-server 长驻进程：同一标签多轮复用 */
  private readonly codexLive = new Map<string, CodexLiveSession>();
  /** tabId → 运行中的后台子代理（来自 agent 事件；后台任务条与「停止子代理」用） */
  private readonly bgAgents = new Map<string, Map<string, { label?: string; startedAt: number }>>();
  /** 因空闲被回收、尚未重新拉起的标签（只在内存；下一条消息 --resume 后清除） */
  private readonly dormant = new Set<string>();
  private idleReclaimMs: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private running = 0;
  private activeTabId = MAIN_TAB_ID;
  private defaultPermissionMode: HarnessPermissionMode = DEFAULT_PERMISSION_MODE;
  /**
   * 「全部自动」（默认开）：新的编程助手标签默认「完全放开」、Nomi 委派的编程助手同样，
   * Nomi 对话选了工作区时工作区里的文件工具不再确认（desktop/PermissionBroker.authorizeIn；
   * workspace_run 不受工作区限制，始终确认）。
   * 关掉后回到逐项询问：新标签用 defaultPermissionMode，Nomi 的工具按原来的确认规则。
   */
  private autoApprove = true;
  /**
   * 每个后端最近一次选的权限模式 / 模型 / 思考深度：新会话（/clear、新标签、打开历史）沿用。
   * 模型 / 思考深度在换官方账号或第三方供应商时清掉（recycleBackend）；「完全放开」从不记住。
   */
  private readonly lastSettings = new Map<HarnessBackend, LastTabSettings>();
  private codexNetwork = true;
  /** 这台机器上的 Grok 起不来 ACP：之后的轮次退回 `grok -p`（只在内存，重启后再试） */
  private grokAcpUnavailable = false;
  /** 这台机器上的 Codex 起不来 app-server：之后的轮次退回 `codex exec`（只在内存） */
  private codexAppUnavailable = false;
  private readonly home: string;
  private readonly statePath: string;
  private readonly tabsPath: string;
  private readonly tabsDir: string;
  private readonly recentPath: string;
  private recent: string[] = [];
  /** state.json / tabs.json / tabs/<id>.json: coalesced ~200 ms, async, atomic (flushed on dispose) */
  private readonly writer: CoalescedWriter;
  /** 会话上一次成功一轮用的第三方模型：打开历史会话时回到原供应商 */
  private readonly sessionModels: SessionModelTable;
  /** JSON length of each tab's last message-file write: decides compaction without a 2nd stringify */
  private readonly tabFileBytes = new Map<string, number>();
  private broadcastQueued = false;
  private disposed = false;
  readonly events = new EventEmitter();
  /** 各 CLI 的模型目录缓存（从 CLI 读取，见 modelCatalogFor） */
  private readonly modelCatalogs = new Map<
    HarnessBackend,
    { at: number; catalog: BackendModelCatalog }
  >();
  private readonly modelCatalogInflight = new Map<HarnessBackend, Promise<BackendModelCatalog>>();
  /** 官方目录的代次：换账号 / 供应商（recycleBackend）时加一，之前发出的读取回来后不写缓存（#83） */
  private readonly modelCatalogGen = new Map<HarnessBackend, number>();

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      home?: string;
      /** 默认工作目录（文稿/nomi）：第一次用到时才创建，算作用户选过的目录 */
      defaultCwd?: string;
      /** 旧版的默认工作目录（文稿本身）：主标签还停在这里时迁到 defaultCwd */
      legacyDefaultCwd?: string;
      /**
       * 统一网关（docs/design/unified-gateway.md §12）：第三方标签的进程级注入、新标签默认来源、
       * 第三方可选模型、官方标签剔除网关残留变量。没有时只有官方来源。
       */
      gateway?: HarnessGateway;
      /** 官方账号（§5.10）：官方标签按账号目录启动；没有时用 CLI 自己的目录 */
      accounts?: HarnessOfficialAccounts;
      /** 外部插件（§5.9）：用户添加的说 ACP 的 CLI */
      externals?: HarnessExternalPlugins;
      /**
       * 模型质量的 CLI 层记录（docs/design/model-quality.md §4.4）：每轮结束交出一条 layer 'cli' 的记录。
       * 记录出错不影响这一轮。
       */
      quality?: { addCli(record: QualityRecord): void };
      /**
       * 宿主端口：dialogs 选工作目录；windows.anyFocused() 判断应用是否在前台，决定一轮结束算不算
       * 「后台完成」（未读 / 通知）。测试经 tests/unit/helpers/harness.ts 补默认值（取消、不在前台）。
       */
      ports: HarnessPorts;
      /** 长驻 CLI 进程空闲多久后回收（毫秒，0 = 不回收）；缺省读 NOMI_HARNESS_IDLE_MS，再缺省 30 分钟 */
      idleReclaimMs?: number;
      /** Gemini 一轮多久没有任何动静就判定卡死并取消（毫秒）；缺省 GEMINI_PROMPT_IDLE_MS */
      geminiPromptIdleMs?: number;
      /** Claude control_request 等确认的上限（毫秒）；缺省 CLAUDE_CONTROL_TIMEOUT_MS */
      claudeControlTimeoutMs?: number;
      /** 停止后等中断那一轮结束的宽限（毫秒）；缺省 CLAUDE_INTERRUPT_GRACE_MS */
      claudeInterruptGraceMs?: number;
      /** 新建 / 切到 Claude、Gemini、Grok 标签时预先拉起长驻进程（首条消息免冷启动）；测试缺省关闭 */
      prewarmClaude?: boolean;
      /** Grok 走 ACP 长驻会话（`grok agent stdio`）；关闭或起不来时用 `grok -p`。测试缺省关闭 */
      grokAcp?: boolean;
      /** Codex 走 app-server 长驻会话（`codex app-server`）；关闭或起不来时用 `codex exec`。测试缺省关闭 */
      codexAppServer?: boolean;
      /**
       * 辅助模型一次性补全：右栏「生成提交信息」用。Nomi 自己没配模型时，宿主可以退回 tab
       * （当前编程助手标签用的第三方模型）。都没有时抛出 code = 'no-model' 的错误。
       */
      complete?: (
        messages: Array<{ role: 'system' | 'user'; content: string }>,
        signal: AbortSignal,
        tab?: { kind: string; model: string | null },
      ) => Promise<string>;
    },
  ) {
    this.idleReclaimMs = resolveIdleReclaimMs(d.idleReclaimMs, process.env.NOMI_HARNESS_IDLE_MS);
    this.home = d.home ?? os.homedir();
    this.statePath = path.join(d.root, 'session.json');
    this.tabsPath = path.join(d.root, 'tabs.json');
    this.tabsDir = path.join(d.root, 'tabs');
    this.recentPath = path.join(d.root, 'recent-cwds.json');
    this.sessionModels = new SessionModelTable(d.root, (msg, e) => d.logger.warn(msg, e));
    this.writer = new CoalescedWriter(PERSIST_DEBOUNCE_MS, (file, e) =>
      d.logger.warn('harness persist failed', { file: path.basename(file), e }),
    );
    // another instance on this root (restart in-process / tests) may still hold unwritten state
    flushPendingWritesSync(d.root);
    fs.mkdirSync(this.tabsDir, { recursive: true });
    const now = Date.now();
    this.tabs.set(MAIN_TAB_ID, {
      id: MAIN_TAB_ID,
      title: t('electron.common.chat'),
      backend: 'nomi',
      cwd: d.defaultCwd ?? process.cwd(),
      cliSessionId: null,
      status: 'idle',
      unread: 0,
      createdAt: now,
      updatedAt: now,
      permissionMode: DEFAULT_PERMISSION_MODE,
    });
    this.load();
    try {
      const r = JSON.parse(fs.readFileSync(this.recentPath, 'utf8')) as unknown;
      if (Array.isArray(r)) this.recent = r.filter((x): x is string => typeof x === 'string');
    } catch {
      /* 首次运行 */
    }
  }

  // ───────────────────────── 最近使用的工作目录 ─────────────────────────

  /** 最近用过的工作目录（只返回仍存在的目录） */
  recentCwds(): string[] {
    return this.recent.filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /**
   * 渲染层传来的 cwd 必须是已知工作区：某个标签正在用的目录或最近用过的目录。
   * 否则被攻陷的渲染进程可以借 workspace-read / write / delete / git 读写任意目录。
   * 新目录只能经「新建标签 / 换目录 / 选择器」这些入口进入，之后才算已知。
   */
  knownDir(cwd: unknown): string {
    const abs = validDir(this.ensureDefaultDir(String(cwd ?? '')));
    // Windows：标签 / 最近列表可能是 8.3 短名（RUNNER~1），视图或 realpath 可能给长名（runneradmin）
    const key = (p: string) => {
      const r = realDir(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const want = key(abs);
    for (const tab of this.tabs.values()) if (key(tab.cwd) === want) return abs;
    if (this.recent.some((p) => key(p) === want)) return abs;
    if (this.d.defaultCwd && key(this.d.defaultCwd) === want) return abs;
    if (this.worktreeDirs.size && [...this.worktreeDirs].some((p) => key(p) === want)) return abs;
    throw new Error(t('electron.common.invalid-working-directory'));
  }

  /**
   * 已知目录所在仓库的 worktree（git worktree list 给的，不是渲染层给的）：右栏可以切过去看改动、提交。
   * 只在内存里；上限防止无限增长。
   */
  private worktreeDirs = new Set<string>();

  /** 「生成提交信息」：要提交的 diff + 最近的提交标题交给辅助模型（经网关，受外发保护） */
  async suggestCommitMessage(cwd: unknown, paths?: unknown) {
    const dir = this.knownDir(cwd);
    if (!this.d.complete) return { ok: false, code: 'error' as const };
    const ctx = await gitCommitContext(dir, paths);
    if (!ctx) return { ok: false, code: 'invalid' as const };
    if (!ctx.diff.trim() && !ctx.stat.trim()) return { ok: false, code: 'nothing' as const };
    try {
      const raw = await this.d.complete(
        commitMessagePrompt(ctx),
        AbortSignal.timeout(90_000),
        this.helperTab(dir),
      );
      const message = cleanCommitMessage(raw);
      return message
        ? { ok: true, message }
        : { ok: false, code: 'error' as const, output: raw.slice(0, 2000) };
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      const noModel = (e as { code?: unknown } | null)?.code === 'no-model';
      return {
        ok: false,
        code: timeout ? ('timeout' as const) : noModel ? ('no-model' as const) : ('error' as const),
        output: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * 「生成提交信息」退回用哪个标签的模型：目录相同的第三方标签（最近用过的优先），
   * 没有就是最近用过的任一第三方标签。官方账号标签的模型不经网关，用不了。
   */
  private helperTab(dir: string): { kind: string; model: string | null } | undefined {
    const third = [...this.tabs.values()]
      .filter((t) => t.source === 'thirdParty' && isBuiltinCliId(t.backend))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const want = realDir(dir);
    const tab = third.find((t) => realDir(t.cwd) === want) ?? third[0];
    return tab ? { kind: tab.backend, model: tab.modelOverride ?? null } : undefined;
  }

  /** 已知目录所在仓库的 worktree；列出来的（还在的）路径之后也算已知目录 */
  async listWorktrees(cwd: unknown) {
    const dir = this.knownDir(cwd);
    const r = await gitWorktrees(dir);
    for (const p of await ownedWorktrees(dir, r?.worktrees ?? [])) this.rememberWorktree(p);
    return r;
  }
  private rememberWorktree(p: string) {
    const abs = realDir(p);
    this.worktreeDirs.delete(abs);
    this.worktreeDirs.add(abs);
    while (this.worktreeDirs.size > 200)
      this.worktreeDirs.delete(this.worktreeDirs.values().next().value!);
  }

  /** 新标签默认档：「全部自动」开着时是完全放开，否则是设置里的默认档 */
  private newTabMode(): HarnessPermissionMode {
    return this.autoApprove ? 'bypass' : this.defaultPermissionMode;
  }

  /** 「全部自动」是否开着（Nomi 的工作区工具与委派也看这个） */
  autoApproveEnabled(): boolean {
    return this.autoApprove;
  }

  /** 默认工作目录（文稿/nomi）第一次用到时才创建；其它目录原样返回 */
  ensureDefaultDir(dir: string): string {
    const def = this.d.defaultCwd;
    if (def && samePath(dir, def)) {
      try {
        fs.mkdirSync(def, { recursive: true });
      } catch (e) {
        this.d.logger.warn('harness default cwd create failed', e);
      }
    }
    return dir;
  }

  private rememberCwd(abs: string) {
    this.recent = [abs, ...this.recent.filter((p) => !samePath(p, abs))].slice(0, MAX_RECENT_CWDS);
    try {
      fs.writeFileSync(this.recentPath, JSON.stringify(this.recent), 'utf8');
    } catch (e) {
      this.d.logger.warn('harness recent cwd write failed', e);
    }
  }

  /** 原生文件夹选择器（不绑定到任何标签），取消返回 null */
  async pickDirectory(defaultPath?: string): Promise<string | null> {
    return this.showDirectoryPicker(defaultPath);
  }

  /** 不挂父窗口的文件夹选择器（允许新建文件夹）；取消返回 null */
  private async showDirectoryPicker(defaultPath?: string): Promise<string | null> {
    return this.d.ports.dialogs.pickDirectory({
      title: t('electron.common.choose-coding-assistant-working-directory'),
      createDirectory: true,
      ...(defaultPath ? { defaultPath } : {}),
    });
  }

  /** 应用是否在前台（宿主 windows.anyFocused）；读不到按不在前台 */
  private appFocused(): boolean {
    try {
      return this.d.ports.windows.anyFocused();
    } catch {
      return false;
    }
  }

  // ───────────────────────── 持久化 ─────────────────────────

  private get main(): HarnessTabMeta {
    return this.tabs.get(MAIN_TAB_ID)!;
  }

  private load() {
    // 主标签的档位要等 tabs.json 里的默认档读完再还原
    let mainMode: unknown;
    let migrateAuto = false;
    let migrated = false;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.statePath, 'utf8'),
      ) as Partial<HarnessSessionState> & {
        title?: string;
        permissionMode?: unknown;
        modelOverride?: unknown;
        reasoningEffort?: unknown;
        longContext?: unknown;
      };
      const m = this.main;
      if (isBackend(raw.backend)) m.backend = raw.backend;
      if (typeof raw.cwd === 'string' && raw.cwd) m.cwd = raw.cwd;
      // 旧版默认停在「文稿」本身：迁到文稿/nomi（用户自己选的其它目录不动）
      if (
        this.d.defaultCwd &&
        this.d.legacyDefaultCwd &&
        samePath(m.cwd, this.d.legacyDefaultCwd)
      ) {
        m.cwd = this.d.defaultCwd;
      } else if (typeof raw.cliSessionId === 'string') m.cliSessionId = raw.cliSessionId;
      if (typeof raw.title === 'string' && raw.title.trim()) m.title = raw.title;
      mainMode = raw.permissionMode;
      this.restoreOverrides(m, raw);
      m.longContext = sanitizeLongContext(raw.longContext);
    } catch {
      /* */
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.tabsPath, 'utf8')) as {
        activeTabId?: string;
        defaultPermissionMode?: unknown;
        codexNetwork?: unknown;
        autoApprove?: unknown;
        lastSettings?: Record<string, unknown>;
        tabs?: HarnessTabMeta[];
      };
      if (isPermissionMode(raw.defaultPermissionMode) && raw.defaultPermissionMode !== 'bypass') {
        this.defaultPermissionMode = raw.defaultPermissionMode;
      }
      if (typeof raw.codexNetwork === 'boolean') this.codexNetwork = raw.codexNetwork;
      // 没有 autoApprove 字段 = 「全部自动」之前的数据：迁一次（见下面的标签循环）
      migrateAuto = raw.autoApprove === undefined;
      if (typeof raw.autoApprove === 'boolean') this.autoApprove = raw.autoApprove;
      this.restoreLastSettings(raw.lastSettings);
      if (migrateAuto && this.autoApprove) {
        // 之前停在旧默认档上的「最近选择」不再沿用：新会话按新默认（完全放开）开始
        for (const st of this.lastSettings.values())
          if (st.permissionMode === this.defaultPermissionMode) delete st.permissionMode;
      }
      for (const tab of raw.tabs ?? []) {
        if (!tab || typeof tab.id !== 'string' || tab.id === MAIN_TAB_ID) continue;
        if (!isBackend(tab.backend) || tab.backend === 'nomi') continue;
        if (tab.backend === 'external' && typeof tab.pluginId !== 'string') continue;
        // 重启时中断的轮次回到空闲
        const restored: HarnessTabMeta = {
          ...tab,
          status: tab.status === 'error' ? 'error' : 'idle',
          unread: Number(tab.unread) || 0,
          permissionMode: this.restoredMode(tab.backend, tab.permissionMode),
        };
        // 迁移：还停在旧默认档上的标签换到新默认（分不出是不是用户特意选的，按默认处理）
        if (
          migrateAuto &&
          this.autoApprove &&
          tab.permissionMode === this.defaultPermissionMode &&
          !tab.delegation
        ) {
          restored.permissionMode = effectiveMode(tab.backend, 'bypass').mode;
          migrated = true;
        }
        this.restoreOverrides(restored, tab);
        restored.longContext = sanitizeLongContext(tab.longContext);
        if (typeof tab.lastServedRef !== 'string' || !isValidModelId(tab.lastServedRef))
          delete restored.lastServedRef;
        this.tabs.set(tab.id, restored);
      }
      if (raw.activeTabId && this.tabs.has(raw.activeTabId)) this.activeTabId = raw.activeTabId;
    } catch {
      /* */
    }
    this.main.permissionMode = this.restoredMode(this.main.backend, mainMode);
    if (migrated || migrateAuto) this.persist();
  }

  /** Schedule session.json + tabs.json (coalesced; the contents are taken at write time). */
  private persist() {
    this.writer.schedule(this.statePath, () => JSON.stringify(this.sessionSnapshot()));
    this.writer.schedule(this.tabsPath, () => JSON.stringify(this.tabsSnapshot()));
  }

  /** Write any pending state / message files now (quit, dispose, tests). */
  flushPersist(): void {
    this.writer.flushSync();
  }

  private sessionSnapshot() {
    const m = this.main;
    const s: HarnessSessionState & {
      title: string;
      permissionMode: HarnessPermissionMode;
      modelOverride?: string | null;
      reasoningEffort?: string | null;
      longContext?: HarnessTabMeta['longContext'];
    } = {
      backend: m.backend,
      cwd: m.cwd,
      cliSessionId: m.cliSessionId,
      busy: m.status === 'running' || m.status === 'queued',
      title: m.title,
      permissionMode: m.permissionMode,
      ...(m.modelOverride ? { modelOverride: m.modelOverride } : {}),
      ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}),
      ...(m.longContext ? { longContext: m.longContext } : {}),
    };
    return s;
  }

  private tabsSnapshot() {
    return {
      activeTabId: this.activeTabId,
      defaultPermissionMode: this.defaultPermissionMode,
      codexNetwork: this.codexNetwork,
      autoApprove: this.autoApprove,
      lastSettings: Object.fromEntries(this.lastSettings),
      tabs: [...this.tabs.values()].filter((x) => x.id !== MAIN_TAB_ID),
    };
  }

  /** Schedule a tab's message file; compacts old traces when the last write was near the cap. */
  private persistMessages(id: string) {
    this.writer.schedule(this.messagesPath(id), () => {
      const list = this.messages.get(id) ?? [];
      // 文件过大：较早消息的轨迹只保留骨架（按上次写入的体积判断，免去每次二次 stringify）
      if ((this.tabFileBytes.get(id) ?? 0) > MAX_TAB_FILE_BYTES * 0.9) compactOldTraces(list);
      let json = JSON.stringify(list);
      if (json.length > MAX_TAB_FILE_BYTES && compactOldTraces(list)) json = JSON.stringify(list);
      this.tabFileBytes.set(id, json.length);
      return json;
    });
  }

  private messagesPath(id: string) {
    return path.join(this.tabsDir, `${id.replace(/[^\w-]/g, '_')}.json`);
  }

  private carryPath(id: string) {
    return path.join(this.tabsDir, `${id.replace(/[^\w-]/g, '_')}.carry.txt`);
  }

  /** 待带入新会话的前文（主进程私有；落盘以便重启后仍然生效） */
  private carriedText(id: string): string | null {
    if (!this.tabs.get(id)?.carriedMessages) return null;
    try {
      const text = fs.readFileSync(this.carryPath(id), 'utf8');
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  /** 设置 / 清除待带入的前文；messages 为空则清除 */
  private setCarried(
    tab: HarnessTabMeta,
    messages: readonly HarnessTabMessage[] | null,
    from = '',
  ) {
    const carried = messages ? buildCarriedContext(messages, from || tab.cwd) : null;
    try {
      if (carried) writePrivateFile(this.carryPath(tab.id), carried.text);
      else fs.rmSync(this.carryPath(tab.id), { force: true });
    } catch (e) {
      this.d.logger.warn('harness carry write failed', e);
    }
    if (carried) tab.carriedMessages = carried.messages;
    else delete tab.carriedMessages;
  }

  /**
   * 工作目录切换后，当前标签代表的是一个新的 CLI 会话。
   * 前一会话的消息可以写入 carry 文件供下一轮使用，但不能继续作为新会话的可见转录，
   * 否则「开新会话」和「带上前文」在界面上都会看起来仍然停留在旧会话里。
   */
  private clearTabMessages(id: string): void {
    if (id === MAIN_TAB_ID) return;
    const list = this.tabMessages(id);
    if (!list.length) return;
    list.length = 0;
    this.persistMessages(id);
  }

  tabMessages(id: string): HarnessTabMessage[] {
    this.requireTab(id);
    if (id === MAIN_TAB_ID) return [];
    let list = this.messages.get(id);
    if (!list) {
      try {
        list = JSON.parse(fs.readFileSync(this.messagesPath(id), 'utf8')) as HarnessTabMessage[];
        if (!Array.isArray(list)) list = [];
      } catch {
        list = [];
      }
      this.messages.set(id, list);
    }
    if (!this.migratedImageTabs.has(id)) {
      this.migrateStoredImageLinks(id, list);
      this.migratedImageTabs.add(id);
    }
    return list;
  }

  /** 兼容修复前已经落库的 images/<name> 链接；工具轨迹仍保留原始路径，可重新建立安全别名。 */
  private migrateStoredImageLinks(id: string, list: HarnessTabMessage[]): void {
    const chatRoot = path.join(path.dirname(this.d.root), 'chat');
    const aliases = loadImageAliases(chatRoot);
    let changed = false;
    for (const message of list) {
      for (const event of message.trace ?? []) {
        if (event.type === 'tool' && event.output)
          materializeGeneratedImages(event.output, this.home, chatRoot, aliases);
      }
      const content = rewriteGeneratedImageLinks(message.content, aliases);
      if (content !== message.content) {
        message.content = content;
        changed = true;
      }
    }
    if (!changed) return;
    try {
      this.persistMessages(id);
    } catch (e) {
      this.d.logger.warn('harness image link migration failed', e);
    }
  }

  private appendMessage(id: string, msg: HarnessTabMessage) {
    const tab = this.tabs.get(id);
    if (tab) tab.updatedAt = msg.timestamp;
    if (id === MAIN_TAB_ID) return;
    const list = this.tabMessages(id);
    list.push(msg);
    if (list.length > MAX_TAB_MESSAGES) list.splice(0, list.length - MAX_TAB_MESSAGES);
    this.persistMessages(id);
    this.post('harness.tabMessage', { tabId: id, message: msg });
  }

  // ───────────────────────── 旧接口（main 标签） ─────────────────────────

  /** Nomi 对话（主标签）的权限模式，给 Nomi 自己的工具用（desktop/PermissionBroker） */
  mainPermissionMode(): HarnessPermissionMode {
    return this.main.permissionMode;
  }

  state(): HarnessSessionState & {
    toolsDisabled: boolean;
    permissionMode: HarnessPermissionMode;
    bins: Record<string, string | null>;
  } {
    const m = this.main;
    return {
      backend: m.backend,
      cwd: m.cwd,
      cliSessionId: m.cliSessionId,
      busy: m.status === 'running' || m.status === 'queued',
      toolsDisabled: m.backend !== 'nomi',
      permissionMode: m.permissionMode,
      bins: {
        claude: peekHarnessBin('claude'),
        codex: peekHarnessBin('codex'),
        dsh: peekHarnessBin('dsh'),
        grok: peekHarnessBin('grok'),
        gemini: peekHarnessBin('gemini'),
      },
    };
  }

  /** 把还没有（或已过期）的可执行文件探测结果异步补齐；有变化就通知渲染进程 */
  private refreshBins(): Promise<void> {
    if (process.env.NOMI_USE_MOCK_CLI === '1') return Promise.resolve();
    const stale = CLI_BACKENDS.filter((b) => peekCliBin(b) === undefined);
    if (!stale.length) return Promise.resolve();
    return Promise.all(stale.map((b) => refreshCliBin(b))).then(() => {
      this.post('harness.changed', this.state());
    });
  }

  setBackend(backend: HarnessBackend): State {
    this.setTabBackend(MAIN_TAB_ID, backend);
    return this.state();
  }

  /** 放弃待带入的前文（输入栏「带上前文」按钮上的 ×） */
  clearTabCarry(id: string): HarnessTabMeta {
    const tab = this.requireTab(id);
    this.setCarried(tab, null);
    this.changed();
    return { ...tab };
  }

  /**
   * 从某条用户消息重新发送（重试 / 编辑）：删掉它和之后的全部消息。CLI 自己的会话里还有那段回答，
   * 原样续接会让模型看到要重来的内容，所以：
   * - Claude：原地回退，下次拉起进程带 `--resume-session-at`（同一个会话，完整上下文都在）；
   * - Codex（app-server）：`thread/revert` 把这一轮及之后的轮次从同一个线程里删掉；
   * - Claude / Codex 找不到这一轮、或回退到会话开头（分叉带进来的前文就在第一轮里）：
   *   丢弃 CLI 会话，剩下的可见对话作为前文开新会话；
   * - Grok / Gemini / dsh / 外部 CLI 没有回退能力：只删界面上的消息，照旧在原会话里继续发。
   * 返回截断后的消息列表，渲染层直接替换缓存。
   */
  async rewindTab(id: string, messageId: string): Promise<HarnessTabMessage[]> {
    const tab = this.requireTab(id);
    if (id === MAIN_TAB_ID)
      throw new Error(t('electron.common.cannot-write-a-cli-transcript-on-the-main'));
    const busy = () => tab.status === 'running' || tab.status === 'queued';
    if (busy()) throw new Error(t('electron.common.previous-turn-still-running'));
    const find = () =>
      this.tabMessages(id).findIndex((m) => m.id === messageId && m.role === 'user');
    const start = find();
    if (start < 0) throw new Error(t('electron.common.message-not-found'));
    if (tab.backend !== 'claude' && tab.backend !== 'codex') {
      const list = this.tabMessages(id);
      list.length = start;
      this.persistMessages(id);
      this.progress.delete(id);
      this.changed();
      return [...list];
    }
    const sessionId = tab.cliSessionId;
    let claudeAt: string | null = null;
    let codexReverted = false;
    if (sessionId && tab.backend === 'claude') {
      claudeAt = await claudeRewindPoint(
        claudeConfigDir(this.home, { ...process.env, ...this.launchEnvOf(tab) }),
        tab.cwd,
        sessionId,
        messageId,
      ).catch(() => null);
    } else if (sessionId && tab.backend === 'codex') {
      const turnId = codexRevertTarget(this.tabMessages(id), start, sessionId);
      if (turnId) codexReverted = await this.revertCodexThread(tab, sessionId, turnId);
    }
    // 读会话记录 / 回退线程期间标签可能已经开始新一轮
    if (busy()) throw new Error(t('electron.common.previous-turn-still-running'));
    const list = this.tabMessages(id);
    const idx = find();
    if (idx < 0) throw new Error(t('electron.common.message-not-found'));
    // 回退过的 Codex 进程里线程已经是新的样子，留着直接接下一轮；其它情况拆掉全部长驻进程
    if (codexReverted) this.teardownAcpLive(id);
    else this.teardownClaudeLive(id);
    list.length = idx;
    this.persistMessages(id);
    const same = sessionId !== null && tab.cliSessionId === sessionId;
    if (same && claudeAt) {
      tab.claudeResumeAt = { sessionId, at: claudeAt };
      this.setCarried(tab, null);
    } else if (same && codexReverted) {
      delete tab.claudeResumeAt;
      this.setCarried(tab, null);
    } else {
      delete tab.claudeResumeAt;
      tab.cliSessionId = null;
      this.setCarried(tab, list.length ? list : null, tab.cwd);
    }
    this.progress.delete(id);
    this.changed();
    return [...list];
  }

  /** Codex `thread/revert`：去掉 beforeTurnId 这一轮及之后的轮次（同一个线程）；失败返回 false，调用方改开新会话 */
  private async revertCodexThread(
    tab: HarnessTabMeta,
    threadId: string,
    beforeTurnId: string,
  ): Promise<boolean> {
    if (!this.usesCodexApp()) return false;
    try {
      const live = await this.ensureCodexLive(tab);
      if (live.turn || live.threadId !== threadId) return false;
      await live.driver.conn.request('thread/revert', { threadId, beforeTurnId });
      return true;
    } catch (e) {
      this.d.logger.warn('harness codex thread/revert failed', e);
      return false;
    }
  }

  /** 给这条用户消息记下 CLI 的轮次 id（只在主进程用，不广播） */
  private noteCliTurn(
    tabId: string,
    messageId: string,
    turn: { sessionId: string; turnId: string },
  ) {
    if (!this.tabs.has(tabId)) return;
    const msg = this.tabMessages(tabId).find((m) => m.id === messageId);
    if (!msg) return;
    msg.cliTurn = turn;
    this.persistMessages(tabId);
  }

  /** 标签进程的注入变量（账号目录 / 第三方私有配置目录）；拿不到时按默认目录 */
  private launchEnvOf(tab: HarnessTabMeta): Record<string, string> {
    try {
      return this.launchFor(tab).env;
    } catch {
      return {};
    }
  }

  setCwd(cwd: string, opts: { carry?: boolean } = {}): State {
    this.setTabCwd(MAIN_TAB_ID, cwd, opts);
    return this.state();
  }

  async pickCwd(): Promise<State> {
    await this.pickTabCwd(MAIN_TAB_ID);
    return this.state();
  }

  /** 发送一轮到 main 标签；Nomi 后端由渲染层走 AIClient，不应调用此方法 */
  send(prompt: string): Promise<HarnessSendResult> {
    return this.sendTab(MAIN_TAB_ID, prompt);
  }

  // ───────────────────────── 标签 ─────────────────────────

  private requireTab(id: string): HarnessTabMeta {
    const tab = this.tabs.get(String(id));
    if (!tab) throw new Error(t('electron.common.tab-not-found'));
    return tab;
  }

  listTabs(): HarnessTabsState {
    const tabs = [...this.tabs.values()];
    return {
      tabs: tabs.map((x) => {
        const agents = this.bgAgents.get(x.id);
        // Claude 有完整的后台任务计数（含后台 Bash）；其它 CLI 只有子代理
        const bg = this.claudeLive.get(x.id)?.bgTasks.size ?? agents?.size ?? 0;
        return {
          ...x,
          ...(this.dormant.has(x.id) ? { dormant: true } : {}),
          ...(bg ? { background: bg } : {}),
          ...(agents?.size
            ? {
                backgroundAgents: [...agents].map(([id, a]) => ({
                  id,
                  ...a,
                  stoppable: x.backend === 'claude' && this.claudeLive.has(x.id),
                })),
              }
            : {}),
        };
      }),
      activeTabId: this.activeTabId,
      running: tabs.filter((x) => x.status === 'running').length,
      queued: tabs.filter((x) => x.status === 'queued').length,
      defaultPermissionMode: this.defaultPermissionMode,
      codexNetwork: this.codexNetwork,
      autoApprove: this.autoApprove,
    };
  }

  createTab(
    opts: {
      backend?: HarnessBackend;
      cwd?: string;
      title?: string;
      /** 分叉时预填的可见消息（不 resume CLI 会话） */
      messages?: HarnessTabMessage[];
      /** 打开历史会话：直接绑定已有 CLI 会话，下一条消息按各 CLI 的续接参数继续 */
      cliSessionId?: string;
      /** 分叉时继承来源标签的模式；缺省用默认档。「完全放开」不能经此继承 */
      permissionMode?: HarnessPermissionMode;
      /** 历史文件未记录权限时，首次 ACP 握手采用 CLI 返回的当前模式。 */
      permissionModeSource?: 'history-cli';
      /** 历史会话实际使用的模型 / 推理档位；只接受合法值，优先于该后端最近设置 */
      modelOverride?: string | null;
      reasoningEffort?: string | null;
      /** 来源；缺省按「模型」页给这个编程助手设的「新标签默认用」 */
      source?: HarnessTabSource;
      /** 第三方历史会话上一次用的模型 `供应商/模型`（打开历史会话时按原供应商续接） */
      lastServedRef?: string;
      /** 官方来源下用哪个官方账号（打开历史会话时按原账号续接） */
      accountId?: string | null;
      /** backend = 'external' 时：外部插件 id（§5.9） */
      pluginId?: string;
      /** false：在后台创建，不切到这个标签（Nomi 委派时不抢用户正在看的界面）；缺省 true */
      activate?: boolean;
      /** 由 Nomi 委派开的标签 */
      delegation?: { callId?: string; goal: string };
    } = {},
  ): HarnessTabMeta {
    const backend = opts.backend ?? 'claude';
    if (!isBackend(backend) || backend === 'nomi') {
      throw new Error(t('electron.common.new-tabs-can-only-use-a-coding-agent'));
    }
    const ext = backend === 'external' ? this.externalSpecOf(opts.pluginId) : undefined;
    const cwd = opts.cwd
      ? validDir(opts.cwd)
      : this.ensureDefaultDir(this.tabs.get(this.activeTabId)!.cwd);
    if (opts.cwd) this.rememberCwd(cwd);
    const now = Date.now();
    const sameKind = [...this.tabs.values()].filter(
      (x) => x.backend === backend && (!ext || x.pluginId === ext.id),
    ).length;
    const baseTitle = ext ? ext.displayName : BACKEND_TITLE[backend];
    const tab: HarnessTabMeta = {
      id: randomUUID(),
      title:
        opts.title?.trim().slice(0, 60) || (sameKind ? `${baseTitle} ${sameKind + 1}` : baseTitle),
      backend,
      ...(ext ? { pluginId: ext.id } : {}),
      cwd,
      cliSessionId: opts.cliSessionId?.trim() || null,
      status: 'idle',
      unread: 0,
      createdAt: now,
      updatedAt: now,
      permissionMode: effectiveMode(
        backend,
        isPermissionMode(opts.permissionMode) && opts.permissionMode !== 'bypass'
          ? opts.permissionMode
          : this.newTabMode(),
      ).mode,
      ...(opts.permissionModeSource ? { permissionModeSource: opts.permissionModeSource } : {}),
      ...(opts.delegation
        ? {
            delegation: {
              by: 'nomi' as const,
              ...(opts.delegation.callId ? { callId: opts.delegation.callId } : {}),
              goal: opts.delegation.goal.slice(0, 200),
              approvals: { asked: 0, denied: 0, timedOut: 0 },
            },
          }
        : {}),
    };
    // 新标签的来源：显式指定的，否则「模型」页给这个编程助手设的「新标签默认用」
    tab.source = this.defaultSource(backend, opts.source);
    // 官方来源的账号：建标签显式指定的优先；否则用「模型」页给这个后端设的默认账号
    if (tab.source === 'official' && isAccountBackend(backend)) {
      const accountId = opts.accountId ? String(opts.accountId) : this.defaultAccountId(backend);
      if (accountId) tab.accountId = accountId;
    }
    this.inheritSettings(
      tab,
      isPermissionMode(opts.permissionMode) && opts.permissionMode !== 'bypass',
    );
    if (opts.modelOverride && isValidModelId(opts.modelOverride))
      tab.modelOverride = opts.modelOverride;
    // 历史会话记得原来的第三方模型：按它续接，不沿用别的标签最近选的模型
    if (
      this.sourceOf(tab) === 'thirdParty' &&
      opts.lastServedRef &&
      isValidModelId(opts.lastServedRef)
    ) {
      tab.lastServedRef = opts.lastServedRef;
      tab.modelOverride = null;
    }
    if (opts.reasoningEffort && isReasoningEffort(opts.reasoningEffort))
      tab.reasoningEffort = opts.reasoningEffort;
    this.tabs.set(tab.id, tab);
    if (opts.delegation) this.delegatedUnsent.add(tab.id);
    const seeded = Array.isArray(opts.messages)
      ? opts.messages
          .filter(
            (m) =>
              m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
          )
          .slice(-MAX_TAB_MESSAGES)
          .map((m) => ({
            id: m.id || randomUUID(),
            role: m.role as 'user' | 'assistant',
            content: String(m.content).slice(0, 100_000),
            timestamp: typeof m.timestamp === 'number' ? m.timestamp : now,
            ...(m.error ? { error: true as const } : {}),
            ...(Array.isArray(m.tools) ? { tools: m.tools } : {}),
            ...seedExtras(m),
          }))
      : [];
    this.messages.set(tab.id, seeded);
    if (seeded.length) {
      try {
        this.persistMessages(tab.id);
      } catch (e) {
        this.d.logger.warn('harness tab seed write failed', e);
      }
      tab.updatedAt = seeded[seeded.length - 1]!.timestamp;
      // 分叉 / 复制出来的标签没有可续接的 CLI 会话：把预填的对话当前文带进第一轮
      if (!tab.cliSessionId) this.setCarried(tab, seeded);
    }
    if (opts.activate !== false) this.activeTabId = tab.id;
    this.changed();
    this.prewarm(tab.id);
    return { ...tab };
  }

  /** 已绑定 CLI 会话的标签：`${backend}:${cliSessionId}`（历史列表据此去重） */
  openSessionKeys(): Set<string> {
    const out = new Set<string>();
    for (const x of this.tabs.values()) {
      if (x.cliSessionId) out.add(`${x.backend}:${x.cliSessionId}`);
    }
    return out;
  }

  /** 历史扫描能读到 CLI 自己生成的新标题时，替换标签的自动编号标题。 */
  syncOpenSessionTitle(backend: BuiltinBackend, sessionId: string, title: string): void {
    const tab = [...this.tabs.values()].find(
      (x) => x.backend === backend && x.cliSessionId === sessionId,
    );
    const next = String(title ?? '')
      .trim()
      .slice(0, 60);
    if (!tab || !next || tab.title === next || !isGeneratedTabTitle(tab.title, backend)) return;
    tab.title = next;
    this.changed();
  }

  /** 打开历史会话：已有同会话标签则切过去，否则新建并预填转录 */
  openHistorySession(o: {
    backend: CliBackend;
    sessionId: string;
    cwd: string;
    title: string;
    messages: HarnessTabMessage[];
    modelOverride?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: HarnessPermissionMode;
    permissionModeSource?: 'history-cli';
    source?: HarnessTabSource;
    /** 第三方会话上一次用的模型 `供应商/模型`（Nomi 记下的，或网关的会话归属表） */
    lastServedRef?: string;
    /** 会话原本所在的官方账号（Nomi 启动时记下的）：按原账号续接 */
    accountId?: string | null;
  }): { tab: HarnessTabMeta; reused: boolean } {
    const existing = [...this.tabs.values()].find(
      (x) => x.backend === o.backend && x.cliSessionId === o.sessionId,
    );
    if (existing) {
      this.setActiveTab(existing.id);
      return { tab: { ...existing }, reused: true };
    }
    const tab = this.createTab({
      backend: o.backend,
      cwd: o.cwd,
      title: o.title,
      messages: o.messages,
      cliSessionId: o.sessionId,
      // 第三方续接：历史里记的是上游裸模型名，不属于网关的「供应商/模型」命名空间，
      // 不能作为第三方模型覆盖（否则按裸名解析可能歧义）；用记下的原模型（lastServedRef），
      // 没有记录时才用网关给这个助手分配的默认模型。
      ...(o.source !== 'thirdParty' && o.modelOverride ? { modelOverride: o.modelOverride } : {}),
      reasoningEffort: o.reasoningEffort,
      permissionMode: o.permissionMode,
      permissionModeSource: o.permissionModeSource,
      ...(o.source ? { source: o.source } : {}),
      ...(o.lastServedRef ? { lastServedRef: o.lastServedRef } : {}),
      ...(o.accountId ? { accountId: o.accountId } : {}),
    });
    return { tab, reused: false };
  }

  /** 用可见消息覆盖标签转录（分叉 / 导入）；不改 cliSessionId */
  seedTabMessages(id: string, messages: HarnessTabMessage[]): HarnessTabMeta {
    const tab = this.requireTab(id);
    if (id === MAIN_TAB_ID)
      throw new Error(t('electron.common.cannot-write-a-cli-transcript-on-the-main'));
    const seeded = (messages ?? [])
      .filter(
        (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      )
      .slice(-MAX_TAB_MESSAGES)
      .map((m) => ({
        id: m.id || randomUUID(),
        role: m.role as 'user' | 'assistant',
        content: String(m.content).slice(0, 100_000),
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
        ...(m.error ? { error: true as const } : {}),
        ...(Array.isArray(m.tools) ? { tools: m.tools } : {}),
        ...seedExtras(m),
      }));
    this.messages.set(id, seeded);
    try {
      this.persistMessages(id);
    } catch (e) {
      this.d.logger.warn('harness tab seed write failed', e);
    }
    if (seeded.length) tab.updatedAt = seeded[seeded.length - 1]!.timestamp;
    if (!tab.cliSessionId) this.setCarried(tab, seeded.length ? seeded : null);
    this.changed();
    return { ...tab };
  }

  closeTab(id: string): HarnessTabsState {
    if (id === MAIN_TAB_ID)
      throw new Error(t('electron.common.the-main-chat-tab-cannot-be-closed'));
    const tab = this.requireTab(id);
    this.cancelTab(id);
    // 取消进行中的绑定/预热，避免晚到的 ack 仍 spawn 孤儿 CLI（#120）
    this.claudeStarting.delete(id);
    this.teardownClaudeLive(id);
    const order = [...this.tabs.keys()];
    const idx = order.indexOf(id);
    this.tabs.delete(id);
    this.messages.delete(id);
    this.delegatedUnsent.delete(id);
    this.stopBeforeStart.delete(id);
    this.tabFileBytes.delete(id);
    this.progress.delete(id);
    // a pending coalesced write must not recreate the deleted file
    this.writer.cancel(this.messagesPath(id));
    try {
      fs.rmSync(this.messagesPath(id), { force: true });
      fs.rmSync(this.carryPath(id), { force: true });
    } catch {
      /* */
    }
    if (isBuiltinCliId(tab.backend)) {
      this.dropTabBinding(tab);
      this.d.gateway?.releaseAgent(tab.backend, id);
    }
    if (this.activeTabId === id) {
      const rest = order.filter((x) => x !== id);
      this.activeTabId = rest[Math.max(0, idx - 1)] ?? MAIN_TAB_ID;
    }
    this.changed();
    return this.listTabs();
  }

  renameTab(id: string, title: string): HarnessTabMeta {
    const tab = this.requireTab(id);
    const next = String(title ?? '')
      .trim()
      .slice(0, 60);
    if (!next) throw new Error(t('electron.common.title-cannot-be-empty'));
    tab.title = next;
    this.changed();
    return { ...tab };
  }

  setActiveTab(id: string): HarnessTabsState {
    const tab = this.requireTab(id);
    this.prewarm(tab.id);
    // 已经是当前标签且没有未读：不必落盘 / 广播（侧栏切回当前会话时会再激活一次）
    if (this.activeTabId === tab.id && tab.unread === 0) return this.listTabs();
    this.activeTabId = tab.id;
    tab.unread = 0;
    this.changed();
    return this.listTabs();
  }

  setTabBackend(id: string, backend: HarnessBackend): HarnessTabMeta {
    const tab = this.requireTab(id);
    if (!isBackend(backend)) throw new Error(t('electron.common.unknown-backend'));
    if (backend === 'nomi' && id !== MAIN_TAB_ID) {
      throw new Error(t('electron.common.new-tabs-can-only-use-a-coding-agent'));
    }
    // 外部 CLI 要指定是哪个插件：只能新建标签（createTab 带 pluginId），不能把已有标签换过去
    if (backend === 'external' || tab.backend === 'external')
      throw new Error(t('electron.common.an-external-cli-tab-can-t-switch-to'));
    if (tab.status === 'running' || tab.status === 'queued')
      throw new Error(t('electron.common.previous-turn-still-running'));
    const switched = backend !== tab.backend;
    // 会话 id 只属于产生它的 CLI；切换后端即丢弃，避免把 Claude 会话交给 Codex resume
    if (switched) {
      this.teardownClaudeLive(id);
      this.teardownCodexLive(id);
      this.teardownAcpLive(id);
      tab.cliSessionId = null;
      // 历史同步标记只属于原 CLI 的那个会话
      delete tab.permissionModeSource;
      // 标题若是旧后端的默认名（含「Grok 2」这类自动编号），切后端时同步为新后端默认名，
      // 否则空会话从 Grok 切到 Codex 后欢迎标题 / 占位符仍显示 Grok；用户手动重命名的标题保留
      const oldDefault = BACKEND_TITLE[tab.backend];
      const rest = tab.title.startsWith(oldDefault) ? tab.title.slice(oldDefault.length) : null;
      const isDefaultTitle = rest === '' || /^ \d+$/.test(rest ?? '');
      if (isDefaultTitle) {
        const sameKind = [...this.tabs.values()].filter(
          (x) => x.id !== id && x.backend === backend,
        ).length;
        tab.title = sameKind ? `${BACKEND_TITLE[backend]} ${sameKind + 1}` : BACKEND_TITLE[backend];
      }
    }
    tab.backend = backend;
    // 来源属于后端：换后端时按新后端的默认来源
    if (switched) {
      if (backend === 'nomi') delete tab.source;
      else tab.source = this.defaultSource(backend);
      tab.modelScope = this.scopeOf(tab);
      delete tab.modelByScope;
      delete tab.lastServedRef;
    }
    // 新后端不支持当前档位时降到更安全的一档
    tab.permissionMode = effectiveMode(backend, tab.permissionMode).mode;
    // 模型 / 思考深度覆盖只属于产生它的后端（模型名跨后端无意义），切换即清除
    if (switched) {
      tab.modelOverride = null;
      tab.reasoningEffort = null;
    }
    // 后端没变（侧栏切回 Nomi 会话时会再设一次）：不必落盘 / 广播
    if (switched) this.changed();
    return { ...tab };
  }

  /** 新标签的默认来源：显式要第三方且网关里给这个编程助手分配了模型才是第三方 */
  private defaultSource(backend: HarnessBackend, want?: HarnessTabSource): HarnessTabSource {
    const g = this.d.gateway;
    // 外部插件（§5.9）不接网关：永远是 CLI 自己的登录
    if (!g || !isBuiltinCliId(backend)) return 'official';
    const d = g.defaults(backend as BuiltinBackend);
    const source = want ?? d.source;
    return source === 'thirdParty' && (d.model || want) ? 'thirdParty' : 'official';
  }

  /** 「模型」页给这个编程助手设的新标签默认官方账号 id；未配置返回 null（跟随默认账号，§12） */
  private defaultAccountId(backend: HarnessBackend): string | null {
    const g = this.d.gateway;
    if (!g || !isBuiltinCliId(backend)) return null;
    return g.defaults(backend as BuiltinBackend).accountId;
  }

  /**
   * 切换标签的来源（§4.3、§13 第 5 条）。来源决定进程级注入，换来源一定重启进程：
   * - 空标签：直接切换；
   * - 第三方之间换模型：走 setTabModel（原地切换）；
   * - 官方 → 第三方：续接原会话；Codex 例外，用带上下文的新会话（原会话会被 Codex 改到网关名下）；
   * - 第三方 → 官方：第三方的推理内容不能发给官方接口，用带上下文的新会话，原会话保留。
   */
  setTabSource(id: string, source: HarnessTabSource, model?: string): HarnessTabMeta {
    const tab = this.requireTab(id);
    if (tab.backend === 'nomi')
      throw new Error(t('electron.common.nomi-chat-has-no-source-to-choose'));
    if (source !== 'official' && source !== 'thirdParty')
      throw new Error(t('electron.common.unknown-source'));
    if (source === 'thirdParty' && tab.backend === 'external')
      throw new Error(t('electron.common.an-external-cli-only-uses-its-own-sign'));
    if (source === 'thirdParty' && !this.d.gateway)
      throw new Error(t('electron.common.the-model-gateway-is-unavailable'));
    if (tab.status === 'running' || tab.status === 'queued')
      throw new Error(t('electron.common.switch-after-this-turn-finishes'));
    const ref = model?.trim() || '';
    if (ref && !isValidModelId(ref)) throw new Error(t('electron.common.invalid-model-name'));
    if (source === this.sourceOf(tab)) return ref ? this.setTabModel(id, ref) : { ...tab };
    if (
      source === 'thirdParty' &&
      !ref &&
      !this.d.gateway?.defaults(tab.backend as BuiltinBackend).model
    )
      throw new Error(t('electron.common.assign-a-third-party-model-to-this-coding'));
    const hadSession = Boolean(tab.cliSessionId) || this.tabMessages(id).length > 0;
    this.teardownClaudeLive(id);
    this.teardownCodexLive(id);
    this.teardownAcpLive(id);
    tab.source = source;
    this.adoptScope(tab);
    if (ref) tab.modelOverride = ref;
    if (hadSession && (source === 'official' || tab.backend === 'codex')) {
      tab.cliSessionId = null;
      this.setCarried(tab, this.tabMessages(id), tab.cwd);
    }
    this.changed();
    return { ...tab };
  }

  /**
   * 换工作目录。CLI 续接与 cwd 绑定：换目录即开新会话，并拆掉长驻进程。
   * carry=true：把当前可见对话整理成前文，下一条消息连同它一起发给新会话；
   * 否则清掉之前留下的前文，干净地开新会话；可见转录也会重置。正在跑的轮次仍在原目录收尾。
   */
  setTabCwd(id: string, cwd: string, opts: { carry?: boolean } = {}): HarnessTabMeta {
    const tab = this.requireTab(id);
    const abs = validDir(cwd);
    if (abs !== tab.cwd) {
      // 当前轮次让 CLI 正常收尾；下一轮会按 cwd 不同拆掉旧进程。
      // 空闲标签则立即回收，避免旧项目的长驻进程继续占用资源。
      if (tab.status !== 'running') {
        this.teardownClaudeLive(id);
        this.teardownCodexLive(id);
        this.teardownAcpLive(id);
      }
      tab.cliSessionId = null;
      this.setCarried(tab, opts.carry ? this.tabMessages(id) : null, tab.cwd);
      this.clearTabMessages(id);
    }
    tab.cwd = abs;
    // Nomi 对话选的工作区也进最近列表：Nomi 的工作区工具按 knownDir 认它（desktop/workspace.ts）
    this.rememberCwd(abs);
    this.changed();
    return { ...tab };
  }

  /**
   * 切换标签权限模式。返回实际生效的档位（后端不支持时已降级）。
   * 「完全放开」必须带 confirmed（渲染层确认框之后），防止绕过确认；带 expect 时确认绑定在
   * 发起确认时的后端 / 目录上，期间标签换了后端或目录（会话已重置）就拒绝，要求重新确认。
   * Claude 长驻进程用 control_request、Gemini 用 session/set_mode 即时切换，但只有后端确认后才算生效：
   * 确认前不复用进程跑下一轮，失败就拆掉进程 / 会话、下一轮按新档位重拉（#72，等结果见
   * applyTabPermissionMode）。Codex / dsh / Grok 每轮一个进程，下一轮启动时生效。
   */
  setTabPermissionMode(
    id: string,
    mode: HarnessPermissionMode,
    opts: { confirmed?: boolean; expect?: { backend?: string; cwd?: string } } = {},
  ): HarnessTabMeta & { degraded: boolean } {
    const tab = this.requireTab(id);
    if (!isPermissionMode(mode)) throw new Error(t('electron.common.unknown-permission-mode'));
    if (mode === 'bypass' && !opts.confirmed)
      throw new Error(t('electron.common.full-access-requires-confirmation-first'));
    const want = opts.expect;
    if (
      mode === 'bypass' &&
      want &&
      ((want.backend !== undefined && want.backend !== tab.backend) ||
        (want.cwd !== undefined && want.cwd !== tab.cwd))
    )
      throw new Error(t('electron.common.this-tab-s-backend-or-working-directory-changed'));
    const next = effectiveMode(tab.backend, mode);
    // 用户显式选择的档位优先于「从历史 CLI 会话同步」：首次握手不得再覆盖它
    delete tab.permissionModeSource;
    if (next.mode !== tab.permissionMode) {
      tab.permissionMode = next.mode;
      this.rememberSettings(tab);
      const gl = this.acpLive.get(id);
      if (gl?.sessionId && (gl.permissionMode !== next.mode || gl.modeChange))
        this.switchAcpMode(id, gl, next.mode);
      const live = this.claudeLive.get(id);
      if (live && (live.permissionMode !== next.mode || live.modeChange))
        this.switchClaudeMode(id, live, next.mode);
      this.changed();
    }
    return { ...tab, degraded: next.degraded };
  }

  /**
   * 切换并等长驻进程确认（IPC 走这里）。后端拒绝 / 超时会抛出可读错误：进程 / 会话已拆除，
   * 标签档位保持用户选的，下一轮按它重新拉起；界面不能把没生效的档位当成已生效（#72）。
   */
  async applyTabPermissionMode(
    id: string,
    mode: HarnessPermissionMode,
    opts: { confirmed?: boolean; expect?: { backend?: string; cwd?: string } } = {},
  ): Promise<HarnessTabMeta & { degraded: boolean }> {
    const r = this.setTabPermissionMode(id, mode, opts);
    await Promise.all([
      this.claudeLive.get(id)?.modeChange?.done,
      this.acpLive.get(id)?.modeChange?.done,
    ]);
    // 切到「完全放开」后，这一轮里还在等确认的请求一并放行：不用停掉重来
    if (this.bypassInEffect(id))
      for (const requestId of [...(this.pendingPermissions.get(id)?.keys() ?? [])])
        this.replyPermission(id, requestId, true);
    return { ...this.requireTab(id), degraded: r.degraded };
  }

  /** Claude 长驻进程即时切换：control_request 得到成功 control_response 后才更新已生效档位 */
  private switchClaudeMode(id: string, live: ClaudeLiveSession, mode: HarnessPermissionMode) {
    const change: ModeChange = { mode, done: Promise.resolve() };
    change.done = this.requestClaudeControl(live, {
      subtype: 'set_permission_mode',
      mode: claudeModeName(mode),
    }).then(
      () => {
        // CLI 按顺序处理 stdin：最后一个成功应答就是进程当前的档位
        if (this.claudeLive.get(id) === live) live.permissionMode = mode;
        if (live.modeChange === change) live.modeChange = null;
      },
      (e: unknown) => {
        if (live.modeChange !== change) return; // 已被更新的切换取代
        live.modeChange = null;
        // 负确认 / 超时 / 写不进去：进程档位不确定，拆掉；下一轮带新档位 --resume 重拉
        if (this.claudeLive.get(id) === live) this.teardownClaudeLive(id);
        throw new Error(
          t(
            'electron.common.claude-code-did-not-confirm-the-permission-mode',
            e instanceof Error ? e.message : String(e),
          ),
        );
      },
    );
    live.modeChange = change;
    change.done.catch(() => undefined); // 由 applyTabPermissionMode / 发送前的等待处理
  }

  /** Gemini / Grok 长驻会话即时切换：session/set_mode 成功后才更新已生效档位 */
  private switchAcpMode(id: string, gl: AcpLiveSession, mode: HarnessPermissionMode) {
    // 外部插件只有逐项确认、没有模式 id：不发 set_mode，标签档位就是会话档位
    if (!acpModeId(gl.backend, mode)) {
      gl.permissionMode = mode;
      return;
    }
    const change: ModeChange = { mode, done: Promise.resolve() };
    change.done = gl.driver.setPermissionMode(acpModeId(gl.backend, mode)).then(
      () => {
        if (this.acpLive.get(id) === gl) gl.permissionMode = mode;
        if (gl.modeChange === change) gl.modeChange = null;
      },
      (e: unknown) => {
        if (gl.modeChange !== change) return;
        gl.modeChange = null;
        // 切不过去（含降权失败）：停掉会话，不在未确认的档位下继续；下一轮按标签档位重新建立
        if (this.acpLive.get(id) === gl) this.teardownAcpLive(id);
        const why = innermostMessage(e instanceof Error ? e.message : String(e));
        throw new Error(
          gl.backend === 'grok'
            ? t('electron.common.grok-did-not-confirm-the-permission-mode-change', why)
            : t('electron.common.gemini-did-not-confirm-the-permission-mode-change', why),
        );
      },
    );
    gl.modeChange = change;
    change.done.catch(() => undefined);
  }

  /**
   * 该后端的模型目录，从 CLI 自己读取（见 modelDiscovery.ts，不写死）。
   * 不支持标签级覆盖的后端返回 null（界面不显示按钮）；读取失败返回带 error 的空目录
   * （界面只保留「默认模型」与自定义 id）。结果按后端缓存，refresh 强制重读；
   * 切换官方账号 / 启用或停用第三方供应商时由 recycleBackend 清掉缓存。
   */
  async modelCatalogFor(
    backend: HarnessBackend,
    opts: { refresh?: boolean; source?: HarnessTabSource } = {},
  ): Promise<BackendModelCatalog | null> {
    // 读目录时顺手把这个后端的标签对齐当前来源（重启后第一次打开模型按钮时也正确）
    this.adoptScopes(backend);
    // 外部插件（§5.9）没有模型目录：换模型要 CLI 自己支持，L1 清单不声明
    if (!isBuiltinCliId(backend)) return null;
    if (opts.source === 'thirdParty') return this.gatewayCatalog(backend);
    if (!supportsModelOverride(backend)) return null;
    const cached = this.modelCatalogs.get(backend);
    if (!opts.refresh && cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) {
      return cached.catalog;
    }
    const inflight = this.modelCatalogInflight.get(backend);
    if (inflight) return inflight;
    const gen = this.modelCatalogGen.get(backend) ?? 0;
    const current = () => (this.modelCatalogGen.get(backend) ?? 0) === gen;
    // Claude 的默认档位从默认账号的同一份环境里读（账号可能有自己的 CLAUDE_CONFIG_DIR）
    const claudeEnv =
      backend === 'claude' ? this.childEnv(false, this.officialLaunch('claude', null)) : null;
    const run = discoverModels(backend, {
      spawn: (b, args) => {
        const bin = resolveHarnessBin(b as BuiltinBackend);
        if (!bin) return null;
        const useNode = isScript(bin);
        // 官方来源的目录：用默认账号从 CLI 自己读，不带任何第三方注入
        const l = this.officialLaunch(b, null);
        return spawnHarness(
          useNode ? process.execPath : bin,
          useNode ? [bin, ...args, ...l.args] : [...args, ...l.args],
          { cwd: os.tmpdir(), env: this.childEnv(useNode, l), tabId: `models:${b}` },
        );
      },
      ...(claudeEnv
        ? {
            claudeDefaults: {
              effortEnv: claudeEnv.CLAUDE_CODE_EFFORT_LEVEL,
              settingsPath: path.join(claudeConfigDir(this.home, claudeEnv), 'settings.json'),
            },
          }
        : {}),
      codexConfigPath: process.env.CODEX_HOME
        ? path.join(process.env.CODEX_HOME, 'config.toml')
        : codexConfigPath(this.home),
      grokModelsCachePath: path.join(grokHomePath(this.home, process.env), 'models_cache.json'),
      grokSettingsCachePath: path.join(grokHomePath(this.home, process.env), 'settings_cache.json'),
    })
      .catch((e: unknown): BackendModelCatalog => {
        const error = e instanceof Error ? e.message : String(e);
        this.d.logger.warn('harness model discovery failed', { backend, error });
        return { backend, models: [], defaultModel: null, error };
      })
      .then((catalog) => {
        // 读取期间换了账号 / 供应商：这是旧账号的目录，不写缓存（也不清掉新账号的）
        if (!current()) return catalog;
        // 失败结果不缓存，下次打开浮层再试
        if (catalog.error) this.modelCatalogs.delete(backend);
        else this.modelCatalogs.set(backend, { at: Date.now(), catalog });
        return catalog;
      })
      .finally(() => {
        if (this.modelCatalogInflight.get(backend) === run)
          this.modelCatalogInflight.delete(backend);
      });
    this.modelCatalogInflight.set(backend, run);
    return run;
  }

  /** 第三方来源的模型目录：网关里启用的模型（`供应商/模型`），默认 = 「模型」页给这个编程助手分配的 */
  private gatewayCatalog(backend: BuiltinBackend): BackendModelCatalog {
    const g = this.d.gateway;
    const list = g?.models() ?? [];
    const def = g?.defaults(backend).model ?? null;
    const models: CatalogModel[] = list.map((m) => ({
      id: m.ref,
      label: `${m.provider} / ${m.label}`,
      reasoning: false,
      efforts: [],
      ...(m.vision !== undefined ? { vision: m.vision } : {}),
    }));
    return {
      backend,
      models,
      defaultModel: (def && models.find((m) => m.id === def)) || null,
      provider: { id: GATEWAY_SCOPE, name: t('electron.common.third-party-models') },
    };
  }

  /**
   * 这个标签当前模型能不能看图：第三方取网关模型的 vision，官方取 CLI 模型目录（已缓存的）里的；
   * 不知道时返回 null（不拦）。
   */
  private visionOf(tab: HarnessTabMeta): { model: string; vision: boolean } | null {
    if (tab.backend === 'nomi') return null;
    const own = tab.modelOverride?.trim() || null;
    if (this.sourceOf(tab) === 'thirdParty') {
      const ref = own || this.d.gateway?.defaults(tab.backend as BuiltinBackend).model;
      const m = ref ? this.d.gateway?.models().find((x) => x.ref === ref) : undefined;
      return m && m.vision !== undefined
        ? { model: `${m.provider} / ${m.label}`, vision: m.vision }
        : null;
    }
    const cat = this.cachedCatalog(tab.backend);
    const m = own ? cat?.models.find((x) => x.id === own) : cat?.defaultModel;
    return m && m.vision !== undefined ? { model: m.label ?? m.id, vision: m.vision } : null;
  }

  /**
   * 这一轮消息上展示的模型（发送时调用，固定住来源与选择）：
   * 第三方 = 这一轮发给网关的模型 `供应商/模型`（CLI 报的可能是占位名，不用）；
   * 官方 = CLI 上报的实际模型 → 标签选的模型 → CLI 目录里的默认模型；都不知道时 undefined
   */
  private turnModelResolver(
    tab: HarnessTabMeta,
  ): (events: readonly HarnessEvent[], usage?: HarnessUsage) => string | undefined {
    if (tab.backend === 'nomi') return () => undefined;
    const picked = this.effectiveOverrides(tab).model ?? undefined;
    if (this.sourceOf(tab) === 'thirdParty') return () => picked;
    const fallback = picked ?? this.cachedCatalog(tab.backend)?.defaultModel?.id;
    return (events, usage) => usage?.model ?? reportedModel(events) ?? fallback;
  }

  /** 已缓存的模型目录（不触发读取；没有时校验放宽，由 CLI 自己报错） */
  private cachedCatalog(backend: HarnessBackend): BackendModelCatalog | null {
    return this.modelCatalogs.get(backend)?.catalog ?? null;
  }

  /**
   * 设置标签的模型覆盖（官方账号路径）。
   * 传空串清除覆盖（沿用 CLI 默认模型）；只接受有模型目录的后端与合法模型名。
   * 覆盖经进程级参数注入（codex `-c` / grok `-m` / claude `--model`），不改写全局 CLI 配置；
   * 每轮新进程的后端下一轮生效；Claude 长驻进程在下一轮发送前用 set_model 原地切换
   * （思考深度随之变化时仍是空闲即回收、下一轮用新参数重启）。
   * 切到非推理模型时同步清除思考深度。
   */
  setTabModel(
    id: string,
    model: string,
    opts: { expectSource?: HarnessTabSource } = {},
  ): HarnessTabMeta {
    const tab = this.requireTab(id);
    const backend = tab.backend;
    if (!this.canOverride(tab))
      throw new Error(t('electron.common.this-coding-assistant-doesn-t-support-switching-models'));
    // 选择时界面看到的来源与标签当前来源不一致（期间切了来源）：不把那个来源的模型写进来（#83）
    if (opts.expectSource && opts.expectSource !== this.sourceOf(tab))
      throw new Error(t('electron.common.this-tab-s-model-source-has-changed-pick'));
    const name = model.trim();
    const scope = this.adoptScope(tab);
    if (!name) {
      if (tab.modelOverride || tab.reasoningEffort) {
        tab.modelOverride = null;
        tab.reasoningEffort = null;
        this.rememberSettings(tab);
        this.changed();
        this.recycleLiveForOverride(tab);
      }
      return { ...tab };
    }
    if (!isValidModelId(name)) throw new Error(t('electron.common.invalid-model-name'));
    // 第三方来源只能选网关里启用的模型
    if (scope && this.d.gateway && !this.d.gateway.models().some((m) => m.ref === name))
      throw new Error(t('electron.common.isn-t-among-the-third-party-models-enable', name));
    if (tab.modelOverride !== name) {
      tab.modelOverride = name;
      tab.modelScope = scope;
      // CLI 说不支持思考深度 / 不支持当前档位的模型：已选档位清掉（回到 CLI 默认）；
      // 第三方供应商的模型没有思考深度
      tab.reasoningEffort = scope
        ? null
        : sanitizeEffort(this.cachedCatalog(backend), name, tab.reasoningEffort);
      this.rememberSettings(tab);
      this.changed();
      this.recycleLiveForOverride(tab);
    }
    return { ...tab };
  }

  /**
   * 设置标签的思考深度（仅推理模型）。传 null 清除（沿用 CLI 默认档位）。
   * 只接受支持覆盖的后端；目录已读到时档位必须是该模型（未选模型 = CLI 默认模型）
   * 在 CLI 里声明支持的，目录还没读到时只校验枚举，由 CLI 自己报错。
   */
  setTabReasoningEffort(id: string, effort: string | null): HarnessTabMeta {
    const tab = this.requireTab(id);
    const backend = tab.backend;
    if (effort === null) {
      if (tab.reasoningEffort) {
        tab.reasoningEffort = null;
        this.rememberSettings(tab);
        this.changed();
        this.recycleLiveForOverride(tab);
      }
      return { ...tab };
    }
    if (!this.canOverride(tab))
      throw new Error(t('electron.common.this-coding-assistant-doesn-t-support-switching-models'));
    if (this.adoptScope(tab))
      throw new Error(t('electron.common.reasoning-effort-can-t-be-set-here-for'));
    if (!isReasoningEffort(effort)) throw new Error(t('electron.common.unknown-reasoning-effort'));
    const levels = effortsForModel(this.cachedCatalog(backend), tab.modelOverride);
    if (levels === null)
      throw new Error(t('electron.common.this-model-doesn-t-support-reasoning-effort'));
    if (levels && !levels.includes(effort))
      throw new Error(t('electron.common.this-model-doesn-t-support-that-reasoning-effort'));
    if (tab.reasoningEffort !== effort) {
      tab.reasoningEffort = effort;
      this.rememberSettings(tab);
      this.changed();
      this.recycleLiveForOverride(tab);
    }
    return { ...tab };
  }

  /**
   * 第三方标签开 / 关长上下文（§12.7.2）。只对当前模型记一次（换模型后回到新模型的默认）；
   * null = 跟随模型默认。窗口是进程级注入参数，下一条消息起按新窗口重启进程（--resume 续接，对话保留）。
   * 后台任务还在跑时不切：重启会把后台子代理一起结束。
   */
  setTabLongContext(id: string, on: boolean | null): HarnessTabMeta {
    const tab = this.requireTab(id);
    if (this.sourceOf(tab) !== 'thirdParty')
      throw new Error(t('electron.common.long-context-is-only-for-third-party-models'));
    const model = this.effectiveOverrides(tab).model;
    if (!model) throw new Error(t('electron.common.this-tab-has-no-third-party-model-yet'));
    const next = on === null ? null : { model, on };
    const cur = tab.longContext?.model === model ? tab.longContext : null;
    if ((cur?.on ?? null) === (next?.on ?? null)) return { ...tab };
    if ((tab.background ?? 0) > 0)
      throw new Error(t('electron.common.background-tasks-are-still-running-switch-long'));
    tab.longContext = next;
    this.changed();
    return { ...tab };
  }

  /** 这个标签对当前模型的长上下文选择；undefined = 跟随模型默认 */
  private longContextOf(tab: HarnessTabMeta, model: string): boolean | undefined {
    return tab.longContext?.model === model ? tab.longContext.on : undefined;
  }

  /**
   * 模型 / 思考深度覆盖变化后回收长驻 CLI 进程（目前只有 Claude）。
   * 每轮新进程的后端（codex / grok / dsh）无需处理。仅在空闲时回收：
   * 进行中的轮次、后台任务、自发轮次都等它们结束——覆盖本就约定「下一条消息起生效」，
   * 拆进程会把还在跑的后台子代理一起杀掉（与空闲回收的 backgroundActive 判定一致）。
   */
  private recycleLiveForOverride(tab: HarnessTabMeta) {
    if (tab.backend !== 'claude') return;
    const live = this.claudeLive.get(tab.id);
    // 只换模型：进程保留，下一轮发送前 set_model 原地切换（syncClaudeModel）
    if (live && live.reasoningEffort === this.effectiveOverrides(tab).effort) return;
    if (live && !live.turn && !claudeBackgroundActive(live)) this.teardownClaudeLive(tab.id);
  }

  /** 标签的来源：第三方（经统一网关）/ 官方账号（CLI 自带配置） */
  private sourceOf(tab: HarnessTabMeta): HarnessTabSource {
    return isBuiltinCliId(tab.backend) && tab.source === 'thirdParty' && this.d.gateway
      ? 'thirdParty'
      : 'official';
  }

  /** 当前的模型来源键：第三方为 'gateway'；null = 官方账号 */
  private scopeOf(tab: HarnessTabMeta): string | null {
    return this.sourceOf(tab) === 'thirdParty' ? GATEWAY_SCOPE : null;
  }

  /**
   * 能否按标签切模型：官方来源要 CLI 有模型目录（claude / codex / grok）；
   * 第三方来源都可以（模型经网关解析，Gemini / Grok / dsh 换模型时重启进程）。
   */
  private canOverride(tab: HarnessTabMeta): boolean {
    if (tab.backend === 'nomi') return false;
    return this.sourceOf(tab) === 'thirdParty' || supportsModelOverride(tab.backend);
  }

  /**
   * 让标签上的模型 / 思考深度对应当前来源：来源变了（官方 ↔ 第三方）就把旧来源的选择
   * 收进 modelByScope，取出新来源上次的选择。返回当前来源键。
   */
  private adoptScope(tab: HarnessTabMeta): string | null {
    const scope = this.scopeOf(tab);
    const had = tab.modelScope ?? null;
    if (had === scope) return scope;
    const key = (s: string | null) => s ?? 'official';
    const stash = { ...tab.modelByScope };
    if (tab.modelOverride || tab.reasoningEffort)
      stash[key(had)] = { model: tab.modelOverride ?? null, effort: tab.reasoningEffort ?? null };
    else delete stash[key(had)];
    const next = stash[key(scope)];
    delete stash[key(scope)];
    tab.modelOverride = next?.model ?? null;
    tab.reasoningEffort = scope ? null : (next?.effort ?? null);
    tab.modelScope = scope;
    tab.modelByScope = Object.keys(stash).length ? stash : undefined;
    return scope;
  }

  /** 该后端所有标签对齐各自的来源（读模型目录、换账号时调用） */
  private adoptScopes(backend: HarnessBackend) {
    let moved = false;
    for (const tab of this.tabs.values()) {
      if (tab.backend !== backend || (tab.modelScope ?? null) === this.scopeOf(tab)) continue;
      this.adoptScope(tab);
      moved = true;
    }
    if (moved) this.changed();
  }

  /**
   * 已经开始的第三方会话没手动选过模型时，留在它上一次用的模型上（「模型」页改了这个编程助手的
   * 默认供应商，旧会话不会悄悄换到新供应商）；那个模型已不在网关里（供应商删除 / 停用）就不用。
   */
  private sessionRef(tab: HarnessTabMeta): string | null {
    const ref = tab.lastServedRef;
    if (!ref || !this.d.gateway) return null;
    return this.d.gateway.models().some((m) => m.ref === ref) ? ref : null;
  }

  /**
   * 本轮实际下发的模型 / 思考深度。只下发属于当前来源的选择（官方账号下选的模型名不发到网关，
   * 反之亦然）。第三方来源没选模型时用「模型」页给这个编程助手分配的模型；第三方不带思考深度。
   */
  private effectiveOverrides(tab: HarnessTabMeta): { model: string | null; effort: string | null } {
    const scope = this.scopeOf(tab);
    if (scope) {
      const own = (tab.modelScope ?? null) === scope ? tab.modelOverride?.trim() : '';
      return {
        model:
          own ||
          this.sessionRef(tab) ||
          this.d.gateway?.defaults(tab.backend as BuiltinBackend).model ||
          null,
        effort: null,
      };
    }
    if ((tab.modelScope ?? null) !== null) return { model: null, effort: null };
    return { model: tab.modelOverride?.trim() || null, effort: tab.reasoningEffort ?? null };
  }

  /**
   * 这一次启动的进程级注入（§12）：第三方 → 网关地址、令牌、模型参数、要剔除的继承变量；
   * 官方 → 只剔除指向网关的残留变量。sig 决定长驻进程能否复用：来源、网关地址或令牌、
   * 写在配置里的模型（Gemini / Grok / dsh）变了就重启。
   */
  private launchFor(tab: HarnessTabMeta): TabLaunch {
    if (this.sourceOf(tab) === 'official') return this.officialLaunch(tab.backend, tab.accountId);
    const model = this.effectiveOverrides(tab).model;
    if (!model) throw new Error(t('electron.common.this-tab-has-no-third-party-model-yet'));
    const longContext = this.longContextOf(tab, model);
    const l = this.d.gateway!.launch(tab.backend as BuiltinBackend, tab.id, model, {
      tabBound: this.needsTabBinding(tab),
      ...(longContext !== undefined ? { longContext } : {}),
    });
    if (!l) throw new Error(t('electron.common.the-model-gateway-isn-t-running-so-third'));
    // 按标签令牌启动的进程以实际启动为准：占位模型名时配置里没有真实模型，换模型不必重启（§6.7）
    const bound = this.needsTabBinding(tab) ? this.tabBindings.get(tab.id) : undefined;
    const modelInConfig = bound?.modelInConfig ?? Boolean(l.modelInConfig);
    const byModel = (k: string) => !modelInConfig && /MODEL/.test(k);
    const stable = Object.fromEntries(Object.entries(l.env).filter(([k]) => !byModel(k)));
    const aux = Object.fromEntries(Object.entries(l.env).filter(([k]) => byModel(k)));
    return {
      env: l.env,
      args: l.args,
      strip: l.strip,
      official: false,
      modelInConfig,
      sig: JSON.stringify(['thirdParty', stable, l.args, modelInConfig ? model : '']),
      modelSig: JSON.stringify(aux),
    };
  }

  /** 这个标签的进程要不要按标签令牌启动（第三方 + 网关支持按标签登记，§6.7） */
  private needsTabBinding(tab: HarnessTabMeta): boolean {
    return (
      tab.backend !== 'nomi' &&
      this.sourceOf(tab) === 'thirdParty' &&
      typeof this.d.gateway?.launchForTab === 'function'
    );
  }

  /**
   * 拉起新进程前（首次、闲置回收后、重启型换模型、崩溃重启）：签发新代次的标签令牌并等网关确认绑定，
   * 把注入里的共享令牌换成标签令牌。官方标签、或网关不支持按标签登记时原样返回。
   * sig 不变（令牌不进复用键），所以已在运行的进程照常复用、不会每轮重签。
   */
  private async bindTabLaunch(tab: HarnessTabMeta, launch: TabLaunch): Promise<TabLaunch> {
    if (launch.official || !this.needsTabBinding(tab)) return launch;
    const model = this.effectiveOverrides(tab).model;
    if (!model) throw new Error(t('electron.common.this-tab-has-no-third-party-model-yet'));
    const effort = this.effectiveOverrides(tab).effort ?? undefined;
    const r = await this.d.gateway!.launchForTab!(
      tab.backend as BuiltinBackend,
      tab.id,
      model,
      effort,
      this.longContextOf(tab, model),
    );
    if (!r) throw new Error(t('electron.common.the-model-gateway-isn-t-running-so-third'));
    this.tabBindings.set(tab.id, {
      generation: r.generation,
      model,
      ...(r.modelInConfig !== undefined ? { modelInConfig: r.modelInConfig } : {}),
    });
    // 复用键按这次实际的启动重算（占位模型名时不带模型），令牌只在 env 里
    return { ...this.launchFor(tab), env: r.env };
  }

  /** 进程退出时作废它的标签令牌；已经有更新的代次（新进程已登记）时不动 */
  private watchTabRelease(
    tab: HarnessTabMeta,
    child: { once(e: 'close', fn: () => void): unknown },
  ) {
    const bound = this.tabBindings.get(tab.id);
    if (!bound) return;
    const generation = bound.generation;
    child.once('close', () => {
      if (this.tabBindings.get(tab.id)?.generation !== generation) return;
      this.tabBindings.delete(tab.id);
      this.d.gateway?.releaseTab?.(tab.backend as BuiltinBackend, tab.id, generation);
    });
  }

  /**
   * 复用已在运行的第三方进程时：主模型变了就更新绑定（§6.7 的 gateway 方式；inplace 方式在驱动切换后也走这里）。
   * 绑定已不在（网关重启后丢了）时不报错：网关重启会重放绑定。
   */
  private async syncTabBinding(tab: HarnessTabMeta): Promise<void> {
    const bound = this.tabBindings.get(tab.id);
    if (!bound || !this.needsTabBinding(tab)) return;
    const o = this.effectiveOverrides(tab);
    if (!o.model || o.model === bound.model) return;
    const ok = await this.d.gateway!.updateTab?.(
      tab.backend as BuiltinBackend,
      tab.id,
      o.model,
      o.effort ?? undefined,
    );
    if (ok) bound.model = o.model;
  }

  /** 标签关闭 / 换成官方来源：作废它的标签令牌 */
  private dropTabBinding(tab: HarnessTabMeta): void {
    if (!this.tabBindings.delete(tab.id)) return;
    this.d.gateway?.releaseTab?.(tab.backend as BuiltinBackend, tab.id);
  }

  /** 外部插件的清单；不存在 / 已删除时报错（标签保留，用户可以在设置里重新添加） */
  private externalSpecOf(id: string | undefined): ExternalCliSpec {
    const spec = id ? this.d.externals?.spec(id) : undefined;
    if (!spec)
      throw new Error(t('electron.common.the-external-cli-was-deleted-or-its-manifest', id ?? '?'));
    return spec;
  }

  /** 外部插件被删除：停掉用它的标签进程（标签与对话保留，再发消息时提示） */
  externalRemoved(pluginId: string): void {
    for (const tab of this.tabs.values())
      if (tab.backend === 'external' && tab.pluginId === pluginId) this.teardownAcpLive(tab.id);
    this.changed();
  }

  /**
   * 第三方的一轮成功跑完：记下这一轮用的模型。之后没手动选模型时留在它上面（sessionRef），
   * 打开历史会话时也按它回到原供应商。切到别的供应商并聊过一轮后，原供应商就不再是这个会话的了。
   */
  private noteServed(tab: HarnessTabMeta, ref: string): void {
    if (this.sourceOf(tab) !== 'thirdParty') return;
    if (tab.lastServedRef !== ref) {
      tab.lastServedRef = ref;
      this.changed();
    }
    if (tab.cliSessionId) this.sessionModels.note(tab.backend, tab.cliSessionId, ref);
  }

  /** 第三方会话上一次成功一轮用的模型（打开历史会话时用） */
  sessionModel(backend: HarnessBackend, sessionId: string): string | undefined {
    return this.sessionModels.get(backend, sessionId);
  }

  /** 标签绑定 CLI 会话；官方来源时把会话记到所用账号名下 */
  private bindCliSession(tab: HarnessTabMeta, sessionId: string): void {
    const changed = tab.cliSessionId !== sessionId;
    tab.cliSessionId = sessionId;
    if (!changed || this.sourceOf(tab) !== 'official' || !isAccountBackend(tab.backend)) return;
    try {
      this.d.accounts?.noteSession?.(tab.backend, sessionId, tab.accountId);
    } catch {
      /* 记录失败只影响历史标注 */
    }
  }

  /**
   * 官方来源的启动注入：账号目录变量（指定了非本机账号时）、剔除会改变路由或鉴权的继承变量（S3）；
   * sig 带账号 id，换账号就重启进程。
   */
  private officialLaunch(backend: HarnessBackend, accountId: string | null | undefined): TabLaunch {
    if (!this.d.accounts || !isAccountBackend(backend)) return OFFICIAL_LAUNCH;
    const o = this.d.accounts.launch(backend, accountId);
    return {
      env: o.env,
      args: o.args,
      strip: o.strip,
      official: true,
      modelInConfig: false,
      sig: o.sig,
      modelSig: '',
    };
  }

  /** 子进程环境：剔除 Nomi 内部变量后叠加注入；官方来源去掉网关残留，第三方剔除会抢鉴权的继承变量 */
  private childEnv(
    useNode: boolean,
    l: TabLaunch,
    extra: Record<string, string> = {},
  ): NodeJS.ProcessEnv {
    let env = cliChildEnv(useNode, { ...extra, ...l.env });
    if (l.official && this.d.gateway) env = this.d.gateway.officialEnv(env);
    // strip 只清继承来的同名变量，不清这次注入的（如 ANTHROPIC_SMALL_FAST_MODEL 既要剔除旧值又要注入新值，#98）
    for (const k of l.strip) if (!(k in l.env) && !(k in extra)) delete env[k];
    return env;
  }

  /** 本地路由放行的模型：这个 CLI 的标签为当前供应商选中的模型 */
  routeModels(backend: CliBackend): Set<string> {
    const out = new Set<string>();
    for (const tab of this.tabs.values()) {
      if (tab.backend !== backend) continue;
      const m = this.effectiveOverrides(tab).model;
      if (m) out.add(m);
    }
    return out;
  }

  /** 新标签默认档与 Codex 联网开关（设置页） */
  setPermissionDefaults(o: {
    defaultPermissionMode?: HarnessPermissionMode;
    codexNetwork?: boolean;
    autoApprove?: boolean;
  }): HarnessTabsState {
    if (o.defaultPermissionMode !== undefined) {
      if (!isPermissionMode(o.defaultPermissionMode))
        throw new Error(t('electron.common.unknown-permission-mode'));
      if (o.defaultPermissionMode === 'bypass')
        throw new Error(t('electron.common.full-access-can-t-be-the-default-mode'));
      this.defaultPermissionMode = o.defaultPermissionMode;
      // 设置页改了默认档：新会话按新默认档开始，不再沿用之前标签上的选择
      for (const s of this.lastSettings.values()) delete s.permissionMode;
    }
    if (typeof o.codexNetwork === 'boolean') this.codexNetwork = o.codexNetwork;
    if (typeof o.autoApprove === 'boolean') this.autoApprove = o.autoApprove;
    this.changed();
    return this.listTabs();
  }

  /**
   * 落盘档位 → 内存档位。缺字段（旧数据）：Claude 保持原来的逐项确认，其它用默认档；
   * 「完全放开」不跨重启保留。
   */
  private restoredMode(backend: HarnessBackend, raw: unknown): HarnessPermissionMode {
    const mode: HarnessPermissionMode =
      isPermissionMode(raw) && raw !== 'bypass'
        ? raw
        : raw === undefined && backend === 'claude'
          ? 'manual'
          : // 「完全放开」只在「全部自动」开着时跨重启保留；Nomi 主标签没有完全放开
            backend === 'nomi'
            ? this.defaultPermissionMode
            : this.newTabMode();
    return effectiveMode(backend, mode).mode;
  }

  /**
   * 重启后还原模型 / 思考深度覆盖：不支持覆盖的后端一律丢弃；
   * 模型名做字符集校验；档位只校验枚举（目录要等 CLI 读回来，届时由 CLI 报错兜底）。
   */
  private restoreOverrides(
    tab: HarnessTabMeta,
    raw: {
      modelOverride?: unknown;
      reasoningEffort?: unknown;
      modelScope?: unknown;
      modelByScope?: unknown;
    },
  ) {
    const backend = tab.backend;
    // dsh 只在第三方供应商下能切模型（经 --patch），选择同样按来源保存
    if (backend !== 'dsh' && !supportsModelOverride(backend)) {
      tab.modelOverride = null;
      tab.reasoningEffort = null;
      tab.modelScope = null;
      tab.modelByScope = undefined;
      return;
    }
    const pick = (m: unknown, e: unknown) => {
      const model = typeof m === 'string' ? m.trim() : '';
      // 允许「只设思考深度、沿用 CLI 默认模型」
      if (model && !isValidModelId(model)) return null;
      return { model: model || null, effort: isReasoningEffort(e) ? e : null };
    };
    const cur = pick(raw.modelOverride, raw.reasoningEffort);
    tab.modelOverride = cur?.model ?? null;
    tab.reasoningEffort = cur?.effort ?? null;
    tab.modelScope = typeof raw.modelScope === 'string' && raw.modelScope ? raw.modelScope : null;
    const stash: NonNullable<HarnessTabMeta['modelByScope']> = {};
    if (raw.modelByScope && typeof raw.modelByScope === 'object')
      for (const [k, v] of Object.entries(raw.modelByScope as Record<string, unknown>)) {
        const o = (v ?? {}) as { model?: unknown; effort?: unknown };
        const got = pick(o.model, o.effort);
        if (k && got && (got.model || got.effort)) stash[k] = got;
      }
    tab.modelByScope = Object.keys(stash).length ? stash : undefined;
  }

  /** tabs.json 里的「最近一次设置」：逐项校验，不合法的丢弃（与 restoredMode / restoreOverrides 同规则） */
  private restoreLastSettings(raw: Record<string, unknown> | undefined) {
    if (!raw || typeof raw !== 'object') return;
    for (const [backend, v] of Object.entries(raw)) {
      if (!isBackend(backend) || backend === 'nomi' || !v || typeof v !== 'object') continue;
      const o = v as {
        permissionMode?: unknown;
        modelOverride?: unknown;
        reasoningEffort?: unknown;
        modelScope?: unknown;
      };
      const probe = { backend } as HarnessTabMeta;
      this.restoreOverrides(probe, o);
      const s: LastTabSettings = {
        ...(isPermissionMode(o.permissionMode) && o.permissionMode !== 'bypass'
          ? { permissionMode: effectiveMode(backend, o.permissionMode).mode }
          : {}),
        ...(probe.modelOverride ? { modelOverride: probe.modelOverride } : {}),
        ...(probe.reasoningEffort ? { reasoningEffort: probe.reasoningEffort } : {}),
        ...(probe.modelScope ? { modelScope: probe.modelScope } : {}),
      };
      if (Object.keys(s).length) this.lastSettings.set(backend, s);
    }
  }

  private usesGrokAcp(): boolean {
    return Boolean(this.d.grokAcp) && !this.grokAcpUnavailable;
  }

  /** 用户在标签上改了权限模式 / 模型 / 思考深度：记为该后端新会话的起点（随 changed() 落盘） */
  private rememberSettings(tab: HarnessTabMeta) {
    if (tab.backend === 'nomi') return;
    const prev = this.lastSettings.get(tab.backend);
    const mode = tab.permissionMode !== 'bypass' ? tab.permissionMode : prev?.permissionMode;
    this.lastSettings.set(tab.backend, {
      ...(mode ? { permissionMode: mode } : {}),
      ...(tab.modelOverride ? { modelOverride: tab.modelOverride } : {}),
      ...(tab.reasoningEffort ? { reasoningEffort: tab.reasoningEffort } : {}),
      ...(tab.modelScope ? { modelScope: tab.modelScope } : {}),
    });
  }

  /**
   * 新会话沿用该后端最近一次的设置。模型 / 思考深度只在来源一致时沿用（官方账号下选的不带到
   * 第三方供应商，反之亦然；换供应商 / 账号时 recycleBackend 已清掉记下的值）。
   */
  private inheritSettings(tab: HarnessTabMeta, explicitMode: boolean) {
    tab.modelScope = this.scopeOf(tab);
    const s = this.lastSettings.get(tab.backend);
    if (!s) return;
    // 「全部自动」开着：新会话一律从完全放开开始，不沿用之前在别的标签上选的档位
    if (!explicitMode && !this.autoApprove && s.permissionMode)
      tab.permissionMode = effectiveMode(tab.backend, s.permissionMode).mode;
    if (!this.canOverride(tab) || (s.modelScope ?? null) !== tab.modelScope) return;
    if (s.modelOverride) tab.modelOverride = s.modelOverride;
    if (s.reasoningEffort && !tab.modelScope) tab.reasoningEffort = s.reasoningEffort;
  }

  /**
   * 预先拉起长驻进程（Claude：node 启动、MCP / hooks / 插件加载、--resume 读回转录；Gemini：ACP
   * 握手 + session/new 或 load），让新会话 / 切回来的会话第一条消息不必等冷启动。
   * 没用过的预热进程同样参与空闲回收。每轮一个进程的后端没有可预热的东西。
   */
  private prewarm(id: string) {
    if (!this.d.prewarmClaude) return;
    const tab = this.tabs.get(id);
    if (!tab || tab.status === 'running' || tab.status === 'queued') return;
    if (tab.backend === 'claude' && !this.claudeLive.has(id)) {
      if (this.needsTabBinding(tab)) {
        // 第三方：先登记绑定再拉起（异步）；这期间来的第一条消息共用同一次登记
        this.ensureClaudeLiveBound(tab)
          .then((live) => {
            if (!live.turn) live.prewarmed = true;
          })
          .catch((e: unknown) => this.d.logger.warn('harness claude prewarm failed', e));
      } else {
        try {
          this.ensureClaudeLive(tab).prewarmed = true;
        } catch (e) {
          this.d.logger.warn('harness claude prewarm failed', e);
        }
      }
    } else if (tab.backend === 'codex' && this.usesCodexApp() && !this.codexLive.has(id)) {
      this.ensureCodexLive(tab).catch((e: unknown) => {
        if (e instanceof AcpUnavailableError) this.codexAppUnavailable = true;
        this.d.logger.info('harness codex prewarm skipped', { error: String(e) });
      });
    } else if (
      (tab.backend === 'gemini' ||
        tab.backend === 'external' ||
        (tab.backend === 'grok' && this.usesGrokAcp())) &&
      !this.acpLive.has(id)
    ) {
      // 握手失败（未受信任的文件夹 / 旧版 CLI）时会话已拆除；错误留给第一条消息照常报告
      this.ensureAcpLive(tab).catch((e: unknown) => {
        if (e instanceof AcpUnavailableError) this.grokAcpUnavailable = true;
        this.d.logger.info('harness acp prewarm skipped', {
          backend: tab.backend,
          error: String(e),
        });
      });
    }
  }

  async pickTabCwd(id: string): Promise<HarnessTabMeta> {
    const tab = this.requireTab(id);
    const picked = await this.showDirectoryPicker(tab.cwd);
    if (!picked) return { ...tab };
    return this.setTabCwd(id, picked);
  }

  /**
   * 中止标签当前轮次。Claude 用户轮次只发 interrupt、进程保留（下一轮不用冷启动）；
   * CLI 没应答 / 这条消息还在它的队列里 / 宽限期内这一轮没结束时，才拆进程（下一轮 --resume）。
   */
  cancelTab(id: string): boolean {
    // 委派子任务的卡片一出现就能点停止，此时第一轮可能还没开始（建 worktree / git 检查较慢，
    // Windows 上尤甚）：记下来，sendTab 开始时直接按「已停止」结束，而不是悄悄丢掉这次停止
    if (this.delegatedUnsent.has(id) && this.tabs.has(id)) {
      this.stopBeforeStart.add(id);
      return true;
    }
    const queued = this.tabs.get(id)?.status === 'queued';
    if (queued) this.stopRequested.add(id);
    // 这一轮已开始、但还没真正发给 CLI（Gemini 握手 / 等权限模式确认）：中止它的令牌，
    // 并拆掉正在初始化的长驻进程（不保留空会话）；晚到的握手 / 确认结果不会再发出这一轮（#75）
    const send = this.sendAborts.get(id);
    if (
      send &&
      !send.signal.aborted &&
      !this.claudeLive.get(id)?.turn &&
      !this.acpLive.get(id)?.turn &&
      !this.codexLive.get(id)?.turn &&
      !this.children.has(id)
    ) {
      this.stopRequested.add(id);
      send.abort();
      this.teardownClaudeLive(id); // 同时拆 ACP / Codex 的长驻进程
      return true;
    }
    const live = this.claudeLive.get(id);
    if (live?.turn && !live.turn.settled) {
      this.stopRequested.add(id);
      this.interruptClaudeTurn(id, live, live.turn);
      return true;
    }
    // Gemini / Grok：ACP session/cancel，进程保留供下一轮
    const gl = this.acpLive.get(id);
    if (gl?.turn) {
      this.stopRequested.add(id);
      this.cancelAcpTurn(gl);
      return true;
    }
    // Codex：turn/interrupt，进程保留供下一轮
    const cl = this.codexLive.get(id);
    if (cl?.turn && !cl.turn.settled) {
      this.stopRequested.add(id);
      this.interruptCodexTurn(id, cl, cl.turn);
      return true;
    }
    if (!this.children.has(id) && !live) {
      if (queued) {
        // 还在排队：直接退出等待队列
        return true;
      }
      this.stopRequested.delete(id);
      return false;
    }
    this.stopRequested.add(id);
    this.teardownClaudeLive(id);
    // Codex/dsh/grok：无 claudeLive，仍按 children 杀；必须杀整棵进程树，
    // 这些 CLI 会派生子孙（node 包装脚本 / 工具 / MCP），单层 child.kill() 会留下孤儿进程
    const child = this.children.get(id);
    if (child) {
      killProcessTree(child);
      this.children.delete(id);
      this.clearPermissionTimeouts(id);
    }
    return true;
  }

  /**
   * 中断 Claude 正在进行的用户轮次（实测 2.1.304：interrupt 应答后输出 error_during_execution 的 result，
   * 进程继续接收下一条消息）。那条 result 走 onClaudeLine 的失败分支结束这一轮，sendTab 据
   * stopRequested 记为「已停止」。拿不到应答、消息仍在 CLI 队列里、宽限期内没收到 result：拆进程兜底。
   */
  private interruptClaudeTurn(id: string, live: ClaudeLiveSession, turn: ClaudeTurnWaiter) {
    const fallback = () => {
      if (this.claudeLive.get(id) === live && live.turn === turn && !turn.settled)
        this.teardownClaudeLive(id);
    };
    // 这一轮正常结束后计时器照常到点，fallback 判断已结束就什么都不做
    setTimeout(fallback, this.d.claudeInterruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS).unref?.();
    const uuid = live.turnUuid;
    this.requestClaudeControl(live, { subtype: 'interrupt' }).then((r) => {
      const queued = Array.isArray(r.still_queued) ? r.still_queued : [];
      // 中断的是别的轮次（自发轮次），这条消息之后还会被处理：只能拆进程
      if (uuid && queued.includes(uuid)) fallback();
      // 被中断的这一轮里待确认的权限请求随之作废
      else if (this.claudeLive.get(id) === live) this.clearPermissionTimeouts(id);
    }, fallback);
  }

  /** 测试 / 应用退出：拆除所有长驻 Claude 与残留子进程（含其子孙进程）、清掉所有定时器 */
  dispose(): void {
    this.disposed = true;
    this.writer.dispose();
    this.stopIdleSweep();
    this.eventBatcher.dispose();
    for (const id of [...this.claudeLive.keys()]) this.teardownClaudeLive(id);
    for (const id of [...this.acpLive.keys()]) this.teardownAcpLive(id);
    for (const id of [...this.codexLive.keys()]) this.teardownCodexLive(id);
    for (const [id, child] of [...this.children.entries()]) {
      killProcessTree(child);
      this.children.delete(id);
    }
    for (const id of [...this.pendingPermissions.keys()]) this.clearPermissionTimeouts(id);
  }

  /** 发送一轮到指定标签；各标签可并行（无全局排队上限） */
  async sendTab(
    id: string,
    prompt: string,
    images?: HarnessImageInput[],
    opts: { userInitiated?: boolean } = {},
  ): Promise<HarnessSendResult> {
    const tab = this.requireTab(id);
    if (tab.backend === 'nomi')
      throw new Error(t('electron.common.nomi-backend-is-active-use-the-built-in'));
    this.ensureDefaultDir(tab.cwd);
    const text = String(prompt ?? '').slice(0, 100_000);
    const { images: normalized, rejected } = inspectImages(images);
    if (rejected.length) throw new Error(rejectedImagesMessage(rejected));
    if (!text.trim() && !normalized.length) throw new Error(t('electron.common.message-is-empty'));
    const backend = tab.backend;
    if (normalized.length && imageSupportFor(backend) === 'none') {
      throw new Error(unsupportedImageMessage(backend));
    }
    // 能不能看图看模型：CLI / 网关明确说这个模型不支持时才拦（不知道就交给 CLI / 网关处理）
    const vision = normalized.length ? this.visionOf(tab) : null;
    if (vision && !vision.vision) throw new Error(modelNoVisionMessage(vision.model));
    if (opts.userInitiated && tab.delegation?.by === 'nomi' && !tab.delegation.takenOver) {
      await this.takeOverDelegatedTab(id);
    }
    const current = this.requireTab(id);
    this.delegatedUnsent.delete(id);
    const stopBeforeStart = this.stopBeforeStart.delete(id) && !opts.userInitiated;
    // 只有自发轮次在跑时允许发送：CLI 会排队处理，回显到达时再切换归属（§4）
    const autoOnly = current.status === 'running' && this.isAutoOnly(id);
    if ((current.status === 'running' && !autoOnly) || current.status === 'queued')
      throw new Error(t('electron.common.previous-turn-still-running'));
    // 模型来源（官方 / 第三方供应商）变了却还没收到通知：先对齐，不把别的来源的模型名发出去
    if ((current.modelScope ?? null) !== this.scopeOf(current)) {
      this.adoptScope(current);
      this.changed();
    }
    // 这一轮用的模型（展示在助手消息上）：发送时定下，进行中换模型只影响下一轮
    const modelOf = this.turnModelResolver(current);
    const servedRef =
      this.sourceOf(current) === 'thirdParty' ? this.effectiveOverrides(current).model : null;
    const thumbs = normalized.length ? imageThumbsForMessage(normalized) : undefined;
    // Claude 的这一轮用同一个 uuid 发出：重试 / 编辑时按它在会话记录里找回退点（rewindTab）
    const userMessageId = randomUUID();
    this.appendMessage(id, {
      id: userMessageId,
      role: 'user',
      content: text,
      ...(thumbs?.length ? { images: thumbs } : {}),
      timestamp: Date.now(),
    });
    current.lastError = undefined;
    try {
      await this.acquire(id);
    } catch (e) {
      this.stopRequested.delete(id);
      if (this.tabs.has(id)) {
        current.status = 'idle';
        this.appendMessage(id, {
          id: randomUUID(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          stopped: true,
        });
        this.progress.delete(id);
        this.changed();
      }
      throw e;
    }
    if (!this.tabs.has(id)) {
      this.release();
      throw new Error(t('electron.common.tab-was-closed'));
    }
    current.status = 'running';
    const abort = new AbortController();
    this.sendAborts.set(id, abort);
    if (stopBeforeStart) {
      this.stopRequested.add(id);
      abort.abort();
    }
    const startedAt = Date.now();
    this.turnExits.delete(id);
    const quality = this.qualityBase(current);
    this.partial.set(id, { text: '', breaks: [], events: [], q: { retries: 0 } });
    this.changed();
    const runCwd = current.cwd;
    // 新会话的第一轮：把换目录 / 分叉时留下的前文放在用户消息前面一起发（界面上只显示用户原话）
    // 按这个 CLI 收消息的方式裁到预算内（命令行参数有长度上限，见 carriedBudget）
    const stored = tab.cliSessionId ? null : this.carriedText(id);
    const carried = stored ? fitCarried(stored, carriedBudget(backend, process.platform)) : null;
    const toCli = withCarriedContext(carried, text);
    const stageDir = normalized.length ? this.promptImageDir(id) : null;
    let staged: StagedImage[] = [];
    try {
      if (abort.signal.aborted) throw new Error(t('electron.common.aborted'));
      if (stageDir && normalized.length) staged = stageImages(stageDir, normalized);
      const result =
        backend === 'claude'
          ? await this.runClaude(current, toCli, abort.signal, normalized, userMessageId)
          : backend === 'dsh'
            ? await this.runDsh(current, toCli)
            : backend === 'grok'
              ? await this.runGrokTurn(current, toCli, abort.signal, normalized)
              : backend === 'gemini' || backend === 'external'
                ? await this.runAcp(current, toCli, abort.signal, normalized)
                : await this.runCodexTurn(current, toCli, abort.signal, staged, (turn) =>
                    this.noteCliTurn(id, userMessageId, turn),
                  );
      if (result.sessionId && current.backend === backend && current.cwd === runCwd)
        this.bindCliSession(current, result.sessionId);
      if (servedRef && current.backend === backend) this.noteServed(current, servedRef);
      // 前文已经进了新会话：清掉，之后的轮次靠 CLI 自己续接
      if (stored) this.setCarried(tab, null);
      // 回退点已经生效（新的一轮接在它后面），之后按会话最新位置续接
      if (current.claudeResumeAt) {
        delete current.claudeResumeAt;
        this.changed();
      }
      current.status = this.claudeLive.get(id)?.auto ? 'running' : 'idle';
      // 去重保序：同一 tool_use 后出现的 done/error 覆盖开始态标签
      const toolEvents = result.events.filter(
        (e): e is Extract<HarnessEvent, { type: 'tool' }> => e.type === 'tool',
      );
      const tools: string[] = [];
      const byKey = new Map<string, number>();
      for (const e of toolEvents) {
        const key = e.detail || e.name;
        const label =
          e.status === 'error' ? `${e.name} ✗` : e.status === 'done' ? `${e.name} ✓` : e.name;
        const idx = byKey.get(key);
        if (idx !== undefined) tools[idx] = label;
        else {
          byKey.set(key, tools.length);
          tools.push(label);
        }
      }
      const trace = buildTrace(result.events);
      const usage = mergeUsage(result.events);
      const durationMs = Date.now() - startedAt;
      this.appendMessage(id, {
        id: randomUUID(),
        role: 'assistant',
        content: result.text,
        timestamp: Date.now(),
        durationMs,
        ...withModel(modelOf(result.events, usage)),
        ...(usage ? { usage } : {}),
        ...(tools.length ? { tools } : {}),
        ...(trace.length ? { trace } : {}),
        ...(result.textBreaks?.length ? { textBreaks: result.textBreaks } : {}),
      });
      this.recordQuality(id, quality, startedAt, {
        outcome: this.turnExits.delete(id) ? 'cli-exit' : 'ok',
        usage,
        model: modelOf(result.events, usage),
      });
      this.finish(current, true, result.text);
      return { ...result, trace, durationMs, ...(usage ? { usage } : {}) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stopped = this.stopRequested.delete(id);
      const part = this.partial.get(id);
      const trace = part ? buildTrace(part.events) : [];
      const durationMs = Date.now() - startedAt;
      if (this.tabs.has(id)) {
        if (stopped) {
          // 用户中断：保留已生成的文本与轨迹，标记「已停止」，不算错误
          current.status = 'idle';
          this.appendMessage(id, {
            id: randomUUID(),
            role: 'assistant',
            content: part?.text ?? '',
            timestamp: Date.now(),
            durationMs,
            stopped: true,
            ...withModel(modelOf(part?.events ?? [], part?.context)),
            ...(trace.length ? { trace } : {}),
            ...(part?.breaks.length ? { textBreaks: part.breaks } : {}),
            ...(part?.context ? { usage: part.context } : {}),
          });
          this.progress.delete(id);
          this.changed();
          this.recordQuality(id, quality, startedAt, {
            outcome: 'client-cancel',
            cancelPhase: part?.q?.first ? 'during' : 'before-first',
            usage: part?.context,
            model: modelOf(part?.events ?? [], part?.context),
          });
        } else {
          current.status = 'error';
          current.lastError = message;
          // 失败前已生成的文字保留在前面，错误信息跟在后面（不当成成功，也不丢已输出内容）
          // Claude 的 API 错误会先以 assistant 正文输出一遍、再在 result 里重复一遍，已出现过就不再追加
          const partText = part?.text ?? '';
          const repeated = !!message.trim() && partText.trimEnd().endsWith(message.trim());
          this.appendMessage(id, {
            id: randomUUID(),
            role: 'assistant',
            content:
              !partText.trim() || repeated ? partText || message : `${partText}\n\n${message}`,
            timestamp: Date.now(),
            error: true,
            durationMs,
            ...withModel(modelOf(part?.events ?? [], part?.context)),
            ...(part?.context ? { usage: part.context } : {}),
            // Gemini 不信任这个文件夹：界面在错误卡片上提供「信任此文件夹」
            ...(e instanceof GeminiUntrustedError
              ? {
                  geminiTrust: {
                    folder: e.folder,
                    broad: isBroadGeminiFolder(e.folder, this.home, [
                      this.d.legacyDefaultCwd ?? '',
                    ]),
                  },
                }
              : {}),
            ...(trace.length ? { trace } : {}),
            ...(partText.trim() && part?.breaks.length ? { textBreaks: part.breaks } : {}),
          });
          this.recordQuality(id, quality, startedAt, {
            outcome: this.turnExits.delete(id) || exitedCause(e) ? 'cli-exit' : 'cli-error',
            usage: part?.context,
            model: modelOf(part?.events ?? [], part?.context),
          });
          this.finish(current, false, '', message);
        }
      }
      // 用户停止：带上停止前已生成的文字，调用方（如 Nomi 委派）能区分「停止」与「出错」
      throw stopped ? new HarnessStoppedError(message, part?.text ?? '') : e;
    } finally {
      if (stageDir) cleanupStagedDir(stageDir);
      if (this.sendAborts.get(id) === abort) this.sendAborts.delete(id);
      this.partial.delete(id);
      this.turnExits.delete(id);
      this.stopRequested.delete(id);
      this.release();
      // Codex / dsh / Grok 每轮一个进程：进程结束，它派生的子代理也随之结束
      if (backend !== 'claude') this.clearBackgroundAgents(id);
    }
  }

  /** 标签处于 running 只是因为自发轮次（没有用户轮次在排队 / 进行） */
  private isAutoOnly(id: string): boolean {
    const live = this.claudeLive.get(id);
    return !!live?.auto && !live.turn;
  }

  /**
   * 模型质量（CLI 层）这一轮固定的字段：发送时定下（进行中换模型 / 来源只影响下一轮）。
   * 官方：provider 为该 CLI 的官方服务；第三方：网关模型 `供应商/模型` 的供应商。
   */
  private qualityBase(tab: HarnessTabMeta): QualityBase {
    const client = tab.backend === 'external' && tab.pluginId ? tab.pluginId : String(tab.backend);
    if (this.sourceOf(tab) === 'thirdParty') {
      const ref = this.effectiveOverrides(tab).model ?? '';
      const slash = ref.indexOf('/');
      return {
        client,
        source: 'thirdParty',
        ...(slash > 0 ? { provider: ref.slice(0, slash) } : {}),
      };
    }
    return {
      client,
      source: 'official',
      provider: OFFICIAL_PROVIDER[String(tab.backend)] ?? client,
      ...(tab.accountId ? { accountId: tab.accountId } : {}),
    };
  }

  /** 交出这一轮的 CLI 层质量记录；任何异常都吞掉，不影响这一轮 */
  private recordQuality(
    id: string,
    base: QualityBase,
    startedAt: number,
    o: {
      outcome: QualityOutcome;
      cancelPhase?: 'before-first' | 'during';
      usage?: HarnessUsage;
      model?: string;
    },
  ): void {
    const sink = this.d.quality;
    if (!sink) return;
    try {
      const q = this.partial.get(id)?.q;
      const rel = (t?: number) => (t === undefined ? undefined : Math.max(0, t - startedAt));
      const output = o.usage?.outputTokens;
      const input = qualityLedgerInput(base.client, o.usage ?? {});
      const gen = q?.first !== undefined && q.last !== undefined ? q.last - q.first : undefined;
      const record: QualityRecord = {
        id: randomUUID(),
        layer: 'cli',
        ts: startedAt,
        ...base,
        tabId: id,
        ...(o.model ? { model: o.model } : {}),
        stream: true,
        outcome: o.outcome,
        ...(o.cancelPhase ? { cancelPhase: o.cancelPhase } : {}),
        timing: {
          ...(q?.first !== undefined ? { firstContentMs: rel(q.first) } : {}),
          ...(q?.firstText !== undefined ? { firstTextMs: rel(q.firstText) } : {}),
          ...(q?.last !== undefined ? { lastContentMs: rel(q.last) } : {}),
          endMs: Date.now() - startedAt,
        },
        tokens: {
          ...(input !== undefined ? { input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(o.usage?.cacheReadTokens !== undefined ? { cacheRead: o.usage.cacheReadTokens } : {}),
        },
        ...(o.usage?.costUsd !== undefined ? { cost: o.usage.costUsd } : {}),
        ...(q?.retries ? { retries: q.retries } : {}),
        ...(gen !== undefined && gen < BURST_MS && (output ?? 0) >= BURST_MIN_TOKENS
          ? { burst: true }
          : {}),
      };
      sink.addCli(record);
    } catch (e) {
      this.d.logger.warn('harness quality record failed', { error: (e as Error).message });
    }
  }

  private finish(tab: HarnessTabMeta, ok: boolean, text: string, error?: string) {
    this.progress.delete(tab.id);
    const background = this.activeTabId !== tab.id || !this.appFocused();
    if (background && tab.id !== MAIN_TAB_ID) tab.unread += 1;
    this.changed();
    const ev: HarnessTabFinished = {
      tabId: tab.id,
      title: tab.title,
      backend: tab.backend,
      ok,
      text,
      error,
      background,
    };
    this.events.emit('tab-finished', ev);
    // PR3：Codex / dsh / Grok 在计划模式下回合成功结束后，弹出「按此方案执行」卡
    if (
      ok &&
      tab.permissionMode === 'plan' &&
      (tab.backend === 'codex' || tab.backend === 'dsh' || tab.backend === 'grok') &&
      text.trim()
    ) {
      this.offerExecutePlan(tab);
    }
  }

  /** 计划模式回合结束后的「按此方案执行」本地卡（无 CLI can_use_tool） */
  private offerExecutePlan(tab: HarnessTabMeta) {
    const timeoutMs = this.permissionTimeoutMs(tab.id);
    const ev = executePlanEvent(
      `${tab.id}:${Date.now()}`,
      t('electron.common.execute-this-plan-switch-to-auto-edit-and'),
      timeoutMs,
    );
    this.armPermissionTimeout(tab.id, ev.id);
    this.emitEvent(tab.id, ev);
    this.events.emit('permission-needed', {
      tabId: tab.id,
      title: tab.title,
      backend: tab.backend,
      summary: ev.summary,
      background: this.activeTabId !== tab.id || !this.appFocused(),
    });
  }

  // ───────────────────────── 运行计数（已取消「最多同时运行」上限）─────────────────────────

  private acquire(_tabId: string): Promise<void> {
    this.running += 1;
    return Promise.resolve();
  }

  private release() {
    this.running = Math.max(0, this.running - 1);
  }

  // ───────────────────────── CLI 适配器 ─────────────────────────

  /**
   * Claude：会话级长驻进程（--input-format/--output-format stream-json）。
   * 每轮向 stdin 写一条 user NDJSON，等 result 后进程保持存活供下一轮复用；
   * 权限仍走 control_request ↔ control_response。CLI 若不支持或不稳定，
   * 进程退出后下一轮自动带 --resume 重拉（明确降级，见文档）。
   */
  private async runClaude(
    tab: HarnessTabMeta,
    prompt: string,
    signal?: AbortSignal,
    images?: NormalizedImage[],
    uuid?: string,
  ): Promise<HarnessSendResult> {
    // 刚切过权限模式、后端还没确认：先等结果。确认了就复用进程；失败时进程已拆，下面按标签档位
    // 重新拉起。不会把这一轮发进档位未确认的进程（#72）
    await this.claudeLive.get(tab.id)?.modeChange?.done.catch(() => undefined);
    await this.syncClaudeModel(tab);
    // 等待期间点了停止：不再拉起进程、不发送（#75）
    if (signal?.aborted) throw new Error(t('electron.common.aborted'));
    const live = await this.ensureClaudeLiveBound(tab);
    // 第三方原地换了模型（set_model）或复用了进程：绑定跟上标签的主模型（§6.7）
    await this.syncTabBinding(tab);
    if (signal?.aborted) throw new Error(t('electron.common.aborted'));
    return new Promise<HarnessSendResult>((resolve, reject) => {
      if (live.turn) {
        reject(new Error(t('electron.common.previous-turn-still-running')));
        return;
      }
      const turn: ClaudeTurnWaiter = {
        resolve,
        reject,
        events: [],
        text: '',
        breaks: [],
        sessionId: tab.cliSessionId,
        lastError: null,
        settled: false,
      };
      live.turn = turn;
      live.prewarmed = false;
      live.turnUuid = uuid ?? randomUUID();
      live.turnStarted = false;
      live.lastActivityAt = Date.now();
      this.children.set(tab.id, live.child);
      try {
        this.writeClaudeUser(live, prompt, live.turnUuid, images);
      } catch (e) {
        live.turn = null;
        this.children.delete(tab.id);
        // 写失败：拆掉进程，下一轮重拉
        this.teardownClaudeLive(tab.id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * 长驻进程与标签只差模型（思考深度一致）：发 set_model 原地切换，不重启进程
   * （实测 2.1.304：应答后下一轮的 init / API 请求即用新模型；null / 'default' 回到 CLI 默认模型）。
   * 思考深度没有可靠的原地切换（apply_flag_settings 的 effortLevel 不校验取值、也压不过 --effort），
   * 仍按复用键重启。切换失败就拆进程，下面按新参数重新拉起。
   */
  private async syncClaudeModel(tab: HarnessTabMeta): Promise<void> {
    const live = this.claudeLive.get(tab.id);
    // 自发轮次还在输出：不在它中途换模型，沿用旧进程（见 ensureClaudeLive）
    if (!live || live.turn || live.auto) return;
    const o = this.effectiveOverrides(tab);
    if (live.modelOverride === o.model || live.reasoningEffort !== o.effort) return;
    // 档位 / 小模型等辅助变量也跟着变了（没单独指定、跟随主模型）：set_model 改不到，交给重启（#99）
    let modelSig: string;
    try {
      modelSig = this.launchFor(tab).modelSig;
    } catch {
      return;
    }
    if (modelSig !== live.modelSig) return;
    try {
      await this.requestClaudeControl(live, { subtype: 'set_model', model: o.model ?? 'default' });
      if (this.claudeLive.get(tab.id) === live) live.modelOverride = o.model;
    } catch (e) {
      this.d.logger.warn('harness claude set_model failed', {
        tabId: tab.id,
        error: e instanceof Error ? e.message : String(e),
      });
      if (this.claudeLive.get(tab.id) === live && !live.turn && !claudeBackgroundActive(live))
        this.teardownClaudeLive(tab.id);
    }
  }

  /**
   * 第三方标签：要拉起新进程时先登记绑定（§6.7）再按标签令牌启动；能复用就直接复用。
   * 官方标签与网关不支持按标签登记时同 ensureClaudeLive。
   */
  private async ensureClaudeLiveBound(tab: HarnessTabMeta): Promise<ClaudeLiveSession> {
    if (!this.needsTabBinding(tab)) return this.ensureClaudeLive(tab);
    const launch = this.launchFor(tab);
    const reuse = this.reusableClaude(tab, launch);
    if (reuse) return reuse;
    const pending = this.claudeStarting.get(tab.id);
    if (pending) return pending;
    const p = this.bindTabLaunch(tab, launch)
      .then((bound) => {
        if (!this.tabs.has(tab.id)) {
          this.dropTabBinding(tab);
          throw new Error(t('electron.common.tab-was-closed'));
        }
        return this.ensureClaudeLive(tab, bound);
      })
      .finally(() => {
        if (this.claudeStarting.get(tab.id) === p) this.claudeStarting.delete(tab.id);
      });
    this.claudeStarting.set(tab.id, p);
    return p;
  }

  /** 已在运行、且能按这次的注入 / 档位 / 模型复用的 Claude 进程 */
  private reusableClaude(tab: HarnessTabMeta, launch: TabLaunch): ClaudeLiveSession | null {
    const existing = this.claudeLive.get(tab.id);
    const overrides = this.effectiveOverrides(tab);
    if (
      existing &&
      existing.cwd === tab.cwd &&
      // 来源 / 网关地址 / 令牌变了：进程级注入不同，必须重启
      existing.launchSig === launch.sig &&
      // 已生效（后端确认过）的档位与标签一致，且没有还在等确认的切换
      existing.permissionMode === tab.permissionMode &&
      !existing.modeChange &&
      // 只差模型 / 思考深度时，后台任务还在跑就先沿用旧进程（拆了会杀掉后台子代理），
      // 等后台结束后的下一条消息再按新参数重启
      ((existing.modelOverride === overrides.model &&
        existing.reasoningEffort === overrides.effort &&
        existing.modelSig === launch.modelSig) ||
        claudeBackgroundActive(existing)) &&
      !existing.child.killed &&
      existing.child.exitCode === null &&
      existing.child.signalCode === null
    ) {
      return existing;
    }
    return null;
  }

  /**
   * spawnLaunch：第三方已登记绑定后的注入（标签令牌，见 ensureClaudeLiveBound）；
   * 复用判断仍按 launchFor 的 sig（令牌不进复用键）。
   */
  private ensureClaudeLive(tab: HarnessTabMeta, spawnLaunch?: TabLaunch): ClaudeLiveSession {
    const overrides = this.effectiveOverrides(tab);
    const launch = this.launchFor(tab);
    const reuse = this.reusableClaude(tab, launch);
    if (reuse) return reuse;
    if (this.claudeLive.has(tab.id)) this.teardownClaudeLive(tab.id);

    const bin = resolveHarnessBin('claude');
    if (!bin) throw new Error(t('electron.common.claude-code-not-found-set-nomi-use-mock'));
    const useNode = isScript(bin);
    // 不把 prompt 放 argv：多轮都走 stdin NDJSON，进程可跨轮复用
    const argv = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      // 逐 token 的 stream_event（text_delta）：不加时正文要等一整块写完才出现
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      '--replay-user-messages',
      ...permissionLaunch('claude', tab.permissionMode).args,
      // 标签级模型 / 思考深度（长驻进程，随复用键变化而重启）
      ...overrideArgs('claude', overrides),
      ...launch.args,
    ];
    if (tab.cliSessionId) {
      argv.push('--resume', tab.cliSessionId);
      // 重试 / 编辑后的原地回退：只认同一个会话，且必须是记录 uuid（它会作为参数传给 CLI）
      const back = tab.claudeResumeAt;
      if (back?.sessionId === tab.cliSessionId && /^[0-9a-f-]{8,64}$/i.test(back.at))
        argv.push('--resume-session-at', back.at);
    }
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      env: this.childEnv(useNode, spawnLaunch ?? launch),
      tabId: tab.id,
    });
    if (spawnLaunch) this.watchTabRelease(tab, child);
    // stdin / stdout 与 control_request ↔ control_response 交给 cli-sdk 的 stream-json 驱动；
    // 轮次归属（回显、自发轮次、后台任务）仍由这里按行处理
    let onLine: (line: string, final: boolean) => void = () => undefined;
    const driver = new StreamJsonDriver({
      child,
      parseLine: () => [],
      onLine: (line, o) => {
        onLine(line, o.final);
        return true;
      },
      controlTimeoutMs: this.d.claudeControlTimeoutMs ?? CLAUDE_CONTROL_TIMEOUT_MS,
      messages: {
        timeout: t('electron.common.timed-out'),
        notWritable: t('electron.common.claude-process-stdin-is-not-writable'),
        exited: t('electron.common.process-ended'),
        rejected: t('electron.common.the-backend-rejected-the-request'),
      },
      kill: killProcessTree,
    });
    const live: ClaudeLiveSession = {
      child,
      driver,
      parseLine: createClaudeParser(),
      turn: null,
      cwd: tab.cwd,
      permissionMode: tab.permissionMode,
      modeChange: null,
      modelOverride: overrides.model,
      reasoningEffort: overrides.effort,
      launchSig: (spawnLaunch ?? launch).sig,
      modelSig: (spawnLaunch ?? launch).modelSig,
      turnUuid: null,
      turnStarted: false,
      replaySeen: false,
      auto: null,
      bgTasks: new Set(),
      lastActivityAt: Date.now(),
    };
    this.claudeLive.set(tab.id, live);
    this.dormant.delete(tab.id);
    this.startIdleSweep();

    // 进程退出时缓冲区里剩下的半行：照常解析，但不实时推给界面
    onLine = (line, final) => this.onClaudeLine(tab.id, live, line, !final);
    child.stderr.on('data', (c) => {
      this.d.logger.warn('harness claude stderr', String(c).slice(0, 500));
    });
    child.on('error', (e) => {
      const turn = live.turn;
      live.turn = null;
      this.children.delete(tab.id);
      this.claudeLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      turn?.reject(e);
    });
    // 驱动先处理 close（解析最后半行、让在途的 control_request 失败），再到这里结算这一轮
    child.on('close', (code, signal) => {
      const turn = live.turn;
      live.turn = null;
      this.children.delete(tab.id);
      this.claudeLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      if (!turn || turn.settled) return;
      turn.settled = true;
      // 一轮进行中进程退出（用户停止走 interrupt / 拆进程，记为取消，不算退出）
      if (!this.stopRequested.has(tab.id)) this.turnExits.add(tab.id);
      if (signal && !turn.text) {
        turn.reject(new Error(t('electron.common.aborted')));
        return;
      }
      if (code && code !== 0 && !turn.text) {
        turn.reject(new Error(turn.lastError ?? t('electron.common.exit-code', 'claude', code)));
        return;
      }
      turn.resolve({
        text: turn.text || t('electron.common.no-text-output'),
        sessionId: turn.sessionId,
        events: turn.events,
      });
    });
    return live;
  }

  private writeClaudeUser(
    live: ClaudeLiveSession,
    prompt: string,
    uuid: string,
    images?: NormalizedImage[],
  ) {
    if (!live.child.stdin.writable)
      throw new Error(t('electron.common.claude-process-stdin-is-not-writable'));
    const content = images?.length ? claudeContentBlocks(prompt, images) : prompt;
    live.driver.writeUser(content, uuid);
  }

  /** 发 control_request 不等应答（如 stop_task）；写不进去返回 false */
  private writeClaudeControl(live: ClaudeLiveSession, request: Record<string, unknown>) {
    return live.driver.notifyControl(request);
  }

  /** 发 control_request 并等同 request_id 的 control_response；负确认 / 超时 / 写不进去都会 reject */
  private requestClaudeControl(
    live: ClaudeLiveSession,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return live.driver.control(request);
  }

  private onClaudeLine(tabId: string, live: ClaudeLiveSession, line: string, liveEmit: boolean) {
    live.lastActivityAt = Date.now();
    if (this.onClaudeMeta(tabId, live, line)) return;
    // 回显到达前（或老 CLI 不回显时）的归属：见 ClaudeLiveSession.turnUuid
    const userTurn = live.turn && (live.turnStarted || !live.replaySeen) ? live.turn : null;
    let turn: ClaudeTurnWaiter | null = userTurn ?? live.auto;
    let dropAfter = false;
    for (const raw of live.parseLine(line)) {
      let ev = withPermissionExpiry(stampEvent(raw), this.permissionTimeoutMs(tabId));
      if (!turn && isTurnContent(ev)) turn = this.startAutoTurn(tabId, live);
      if (turn) {
        const folded = foldAssistantEvent(turn.text, turn.breaks, ev);
        turn.text = folded.text;
        turn.breaks = folded.breaks;
        ev = folded.ev;
        // 流式文本片段已累计在 turn.text 里，不再逐条留存（长回答会有上万个）
        if (ev.type !== 'text-delta') turn.events.push(ev);
        if (ev.type === 'error') turn.lastError = ev.message;
        if (ev.type === 'done' && ev.sessionId) turn.sessionId = ev.sessionId;
      }
      if (ev.type === 'permission') ev = markApprovePlanIfExit(ev);
      if (ev.type === 'status' && ev.permissionMode)
        this.applyCliPermissionMode(tabId, ev.permissionMode);
      if (liveEmit) this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        // 批准计划卡：即使「完全放开」也要用户选执行档，不能自动放行
        const notify = () =>
          this.events.emit('permission-needed', {
            tabId,
            title: tab?.title ?? 'Claude Code',
            backend: 'claude' as HarnessBackend,
            summary:
              ev.kind === 'approve-plan'
                ? t('electron.common.approve-plan', ev.summary)
                : ev.agent
                  ? t('electron.common.subagent', ev.agent, ev.summary)
                  : ev.summary,
            background: this.activeTabId !== tabId || !this.appFocused(),
          });
        if (ev.kind === 'approve-plan') notify();
        else this.allowIfBypass(tabId, ev.id, notify);
      }
      if ((ev.type === 'done' || ev.type === 'error') && turn && turn === live.auto) {
        this.finishAutoTurn(tabId, live, ev.type === 'error' ? ev.message : undefined);
        turn = null;
        if (live.recycleAfterTurn && !live.turn) dropAfter = true;
        continue;
      }
      // 一轮失败（result.is_error / error 事件）：结束当前 Promise，进程保持长驻供下一轮
      if (ev.type === 'error' && turn && live.turn === turn) {
        live.turn = null;
        live.turnUuid = null;
        this.children.delete(tabId);
        if (!turn.settled) {
          turn.settled = true;
          turn.reject(new Error(ev.message));
        }
        if (live.recycleAfterTurn) dropAfter = true;
        continue;
      }
      // 一轮 result：结束当前 Promise，但保持 stdin 打开供下一轮
      if (ev.type === 'done' && turn && live.turn === turn) {
        live.turn = null;
        live.turnUuid = null;
        this.children.delete(tabId);
        if (!turn.settled) {
          turn.settled = true;
          turn.resolve({
            text: turn.text || t('electron.common.no-text-output'),
            sessionId: turn.sessionId,
            events: turn.events,
            ...(turn.breaks.length ? { textBreaks: turn.breaks } : {}),
          });
        }
        if (live.recycleAfterTurn) dropAfter = true;
      }
    }
    if (dropAfter) this.dropRecycledClaude(tabId, live);
  }

  // ───────────────────────── Gemini / Grok（ACP） ─────────────────────────

  /**
   * ACP 长驻进程：Gemini `gemini --acp`、Grok `grok agent stdio`。initialize → session/load（有会话 id 时）
   * 或 session/new → session/set_mode；每轮 session/prompt（Grok 发送前再按标签同步模型 / 思考深度）。
   * 审批经 session/request_permission 进权限队列；停止用 session/cancel，进程保留。
   */
  private async ensureAcpLive(tab: HarnessTabMeta, signal?: AbortSignal): Promise<AcpLiveSession> {
    // 还在等确认的模式切换先有结果：失败时会话已拆除，下面按标签档位重新建立（#72）
    await this.acpLive.get(tab.id)?.modeChange?.done.catch(() => undefined);
    const existing = this.acpLive.get(tab.id);
    const launch = this.launchFor(tab);
    if (
      existing &&
      existing.cwd === tab.cwd &&
      existing.launchSig === launch.sig &&
      !existing.driver.closed
    ) {
      await existing.ready;
      // 第三方复用进程：占位模型名的 CLI（Grok）换模型只改绑定，不重启（§6.7 gateway 方式）
      await this.syncTabBinding(tab);
      return this.confirmAcpMode(tab, existing);
    }
    if (existing) this.teardownAcpLive(tab.id);
    const spawnLaunch = await this.bindTabLaunch(tab, launch);
    const backend: AcpBackend =
      tab.backend === 'grok' ? 'grok' : tab.backend === 'external' ? 'external' : 'gemini';
    // 外部插件（§5.9）：命令与参数来自用户的清单，参数模板只做占位符替换、不经 shell
    const ext = backend === 'external' ? this.externalSpecOf(tab.pluginId) : undefined;
    const name = acpDisplayName(backend, ext);
    let bin: string;
    let argv: string[];
    if (ext) {
      const missing = missingExternalEnv(ext, process.env);
      if (missing.length)
        throw new Error(
          t(
            'electron.common.needs-the-environment-variables-set-them-in-the',
            ext.displayName,
            missing.join(', '),
          ),
        );
      bin = ext.command;
      argv = renderExternalArgs(ext.args, { cwd: tab.cwd, home: this.home });
    } else {
      const found = resolveHarnessBin(backend === 'grok' ? 'grok' : 'gemini');
      if (!found)
        throw new Error(
          backend === 'grok'
            ? t('electron.common.grok-not-found-set-nomi-use-mock-cli')
            : t('electron.common.gemini-cli-not-found-set-nomi-use-mock'),
        );
      bin = found;
      argv = backend === 'grok' ? ['agent', 'stdio'] : ['--acp'];
    }
    const useNode = isScript(bin);
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      // 不设 GEMINI_CLI_TRUST_WORKSPACE：信任与否交给 Gemini 自己的受信任文件夹（见 gemini/trust.ts）
      // 第三方：Grok 用私有 GROK_HOME、Gemini 用环境变量指向网关；官方剔除网关残留
      env: this.childEnv(useNode, spawnLaunch),
      tabId: tab.id,
    });
    this.watchTabRelease(tab, child);
    let stderrTail = '';
    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + String(c)).slice(-4000);
      this.d.logger.warn(`harness ${backend} stderr`, String(c).slice(0, 500));
    });
    // 协议（握手、会话、权限、取消）交给 cli-sdk 的 ACP 驱动；这里只做编排
    const driver = new AcpDriver({
      child,
      permissionIdPrefix: 'gemini-perm-',
      promptIdleMs: this.d.geminiPromptIdleMs ?? GEMINI_PROMPT_IDLE_MS,
      rpc: { timeoutMessage: acpTimeoutMessage },
      kill: killProcessTree,
    });
    const live: AcpLiveSession = {
      backend,
      model: null,
      effort: null,
      launchSig: spawnLaunch.sig,
      child,
      driver,
      sessionId: null,
      cwd: tab.cwd,
      permissionMode: tab.permissionMode,
      turn: null,
      perms: new Map(),
      lastActivityAt: Date.now(),
      ready: Promise.resolve(),
      modeChange: null,
    };
    driver.on((e) => {
      live.lastActivityAt = Date.now();
      // 轮次之外的更新（加载历史时的回放等）不进界面
      if (e.kind === 'harness' && e.turnId && live.turn) this.onAcpEvents(tab.id, live, [e.event]);
      if (e.kind !== 'permission') return;
      live.perms.set(e.id, (allow) => {
        live.perms.delete(e.id);
        // Grok 拒绝一次调用会以 cancelled 结束整轮：记下来，不当成用户停止（见 runAcp）
        if (allow === false && live.turn) live.turn.denied = true;
        driver.respondPermission(
          e.id,
          allow === null ? { decision: 'cancel' } : { decision: allow ? 'allow' : 'deny' },
        );
      });
      this.onAcpEvents(tab.id, live, [
        withPermissionExpiry(
          { type: 'permission', id: e.id, summary: e.request.summary },
          this.permissionTimeoutMs(tab.id),
        ),
      ]);
    });
    child.on('close', () => {
      if (this.acpLive.get(tab.id) === live) this.acpLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      for (const done of live.perms.values()) done(null);
    });
    this.acpLive.set(tab.id, live);
    this.dormant.delete(tab.id);
    this.startIdleSweep();
    // 发起这次握手的轮次被停止时，在途的握手请求立即失败（随后会话被拆除）
    const opts = signal ? { signal } : {};
    live.ready = (async () => {
      let sid: string | null;
      let modeNow: unknown;
      try {
        const r = await driver.start({ cwd: tab.cwd, resumeId: tab.cliSessionId, ...opts });
        sid = r.sessionId;
        modeNow = r.currentModeId;
        // 外部插件：握手报告的能力收窄注册表里的能力位（不认图片就不显示图片按钮等）
        if (ext)
          this.d.externals?.handshake?.(ext.id, {
            images: r.capabilities?.images === true,
            resume: r.capabilities?.loadSession === true,
          });
      } catch (e) {
        if (e instanceof Error && e.message === 'ACP agent returned no session') sid = null;
        else throw e;
      }
      if (!sid)
        throw new Error(
          backend === 'grok'
            ? t('electron.common.grok-did-not-return-a-session')
            : backend === 'gemini'
              ? t('electron.common.gemini-didn-t-return-a-session')
              : t('electron.common.didn-t-return-a-session', name),
        );
      live.sessionId = sid;
      // 历史文件没有权限字段时，以 ACP 返回的 currentModeId 为准。
      // 以前这里总是把 Nomi 默认档位写回 CLI，会让打开历史会话时静默改变它原来的安全等级。
      let initMode = tab.permissionMode;
      let adoptedHistoryMode = false;
      if (tab.permissionModeSource === 'history-cli' && typeof modeNow === 'string') {
        const cliMode = fromCliPermissionMode(backend, modeNow);
        if (!cliMode) {
          // 未知模式不能猜测，也不能让标签永久卡住：放弃同步，下面按标签自己的档位显式 set_mode，
          // 只有 CLI 确认后才发送（失败仍按 #72 拒绝这一轮）。
          delete tab.permissionModeSource;
          this.changed();
        } else if (cliMode !== 'bypass') {
          // bypass 仍须经过 Nomi 的显式确认，不能因为打开历史就自动继承。
          initMode = cliMode;
          tab.permissionMode = cliMode;
          delete tab.permissionModeSource;
          adoptedHistoryMode = true;
          this.changed();
        } else {
          // 真实会话处于 bypass 时降到标签的安全档位，并明确发起一次 set_mode。
          // 这样不会在用户未确认的情况下执行完全放开的历史权限。
          delete tab.permissionModeSource;
          this.changed();
        }
      }
      // 权限模式必须得到确认：失败 / 超时就不发送这一轮（不在未确认的档位下跑，#72）。
      // 会话本来就在目标模式（session/new / load 报告的 currentModeId）时不必再切。
      // 外部插件没有模式 id（只有逐项确认）：不发 set_mode
      const want = acpModeId(backend, initMode);
      if (want && !adoptedHistoryMode && modeNow !== want)
        await driver.setPermissionMode(want, opts).catch((e: unknown) => {
          const why = innermostMessage(e instanceof Error ? e.message : String(e));
          throw new Error(
            backend === 'grok'
              ? t('electron.common.grok-did-not-confirm-the-permission-mode-so', why)
              : t('electron.common.gemini-did-not-confirm-the-permission-mode-this', why),
            { cause: e },
          );
        });
      live.permissionMode = initMode;
    })();
    try {
      await live.ready;
    } catch (e) {
      this.teardownAcpLive(tab.id);
      if (signal?.aborted) throw new Error(t('electron.common.aborted'), { cause: e });
      // Grok 握手阶段就退出 / 不认识 ACP：交给 sendTab 退回 `grok -p`
      if (backend === 'grok' && e instanceof Error && e.message === 'ACP process exited')
        throw new AcpUnavailableError(t('electron.common.grok-could-not-start-an-acp-session'), {
          cause: e,
        });
      // 外部 CLI 握手阶段就退出：多半是参数不对或它不说 ACP；带上 stderr 末尾方便排查
      if (ext && e instanceof Error && e.message === 'ACP process exited')
        throw new Error(
          t(
            'electron.common.couldn-t-start-an-acp-session',
            name,
            stderrTail.trim().slice(-300) || t('electron.common.the-process-exited'),
          ),
          { cause: e },
        );
      // 工作区未受信任：headless 的 ACP 弹不出 Gemini 的信任对话框，以 55 退出
      if (
        e instanceof Error &&
        e.message === 'ACP process exited' &&
        isGeminiUntrustedExit(child.exitCode, stderrTail)
      )
        throw new GeminiUntrustedError(tab.cwd, { cause: e });
      // 进程在握手阶段就退出：多半是旧版 Gemini CLI，还不认识 --acp
      if (e instanceof Error && e.message === 'ACP process exited')
        throw new Error(t('electron.common.gemini-cli-couldn-t-start-an-acp-session'), {
          cause: e,
        });
      throw e;
    }
    return this.confirmAcpMode(tab, live);
  }

  /**
   * 发送前确认档位：握手期间或之后又切过模式时，在途的切换先等结果；仍与标签档位不一致就现在切，
   * 确认后才返回。失败时会话已拆除、错误原样抛出，这一轮的 prompt 不会发出（#72）。
   */
  private async confirmAcpMode(tab: HarnessTabMeta, live: AcpLiveSession): Promise<AcpLiveSession> {
    let failure: unknown = null;
    // 等待期间用户可能又切了一次：最多跟进几轮，直到没有在途切换且已生效档位与标签一致
    for (let i = 0; i < 4 && this.acpLive.get(tab.id) === live; i++) {
      if (live.modeChange) {
        await live.modeChange.done.catch((e: unknown) => (failure = e));
        continue;
      }
      if (live.permissionMode === tab.permissionMode) return live;
      this.switchAcpMode(tab.id, live, tab.permissionMode);
    }
    throw failure instanceof Error
      ? failure
      : new Error(t('electron.common.the-gemini-session-ended-this-message-was-not'));
  }

  private onAcpEvents(tabId: string, live: AcpLiveSession, evs: HarnessEvent[]) {
    for (const raw of evs) {
      let ev = withPermissionExpiry(stampEvent(raw), this.permissionTimeoutMs(tabId));
      const turn = live.turn;
      if (turn) {
        const folded = foldAssistantEvent(turn.text, turn.breaks, ev);
        turn.text = folded.text;
        turn.breaks = folded.breaks;
        ev = folded.ev;
        if (ev.type !== 'text-delta') turn.events.push(ev);
      }
      if (ev.type === 'permission') ev = markApprovePlanIfExit(ev);
      if (ev.type === 'status' && ev.permissionMode)
        this.applyCliPermissionMode(tabId, ev.permissionMode);
      this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        const notify = () =>
          this.events.emit('permission-needed', {
            tabId,
            title: tab?.title ?? acpDisplayName(live.backend),
            backend: live.backend as HarnessBackend,
            summary: ev.summary,
            background: this.activeTabId !== tabId || !this.appFocused(),
          });
        if (ev.kind === 'approve-plan') notify();
        else this.allowIfBypass(tabId, ev.id, notify);
      }
    }
  }

  private async runAcp(
    tab: HarnessTabMeta,
    prompt: string,
    signal?: AbortSignal,
    images?: NormalizedImage[],
  ): Promise<HarnessSendResult> {
    let live = await this.ensureAcpLive(tab, signal);
    if (!(await this.syncAcpOverrides(tab, live))) {
      // 清掉了覆盖、又不知道 CLI 的默认值：换新进程（session/load 接上会话），按默认参数开始
      this.teardownAcpLive(tab.id);
      live = await this.ensureAcpLive(tab, signal);
    }
    // 握手 / 模式确认期间点了停止：即使握手随后成功，也不再发送这一轮（#75）
    if (signal?.aborted) throw new Error(t('electron.common.aborted'));
    if (live.turn) throw new Error(t('electron.common.previous-turn-still-running'));
    const turn: AcpTurn = { events: [], text: '', breaks: [] };
    live.turn = turn;
    live.used = true;
    live.lastActivityAt = Date.now();
    try {
      // 一直有输出就不算超时；等用户确认权限时也不计时（权限另有自己的超时）。
      // 本轮增量经 driver.on 进 onAcpEvents；思考的尾巴在 send 返回前已发出
      const sent = await live.driver.send({
        text: prompt,
        ...(images?.length ? { blocks: acpPromptParts(prompt, images) } : {}),
        onTimeout: () => {
          // 驱动已发 session/cancel；挂起的权限按取消处理
          for (const done of [...live.perms.values()]) done(null);
          // 卡住的进程不再复用：这一轮结束后回收，下一轮重新拉起（session/load 接上会话）
          live.recycleAfterTurn = true;
        },
      });
      const r = sent.raw as {
        stopReason?: string;
        _meta?: {
          quota?: { token_count?: { input_tokens?: number; output_tokens?: number } };
          /** Grok：整轮累计（inputTokens / outputTokens / cachedReadTokens） */
          usage?: unknown;
        };
      } | null;
      // 用户拒绝了一次工具调用、Grok 随之结束这一轮：不是「已中止」，按正常结束落盘
      if (r?.stopReason === 'cancelled' && !(turn.denied && !this.stopRequested.has(tab.id)))
        throw new Error(t('electron.common.aborted'));
      if (r?.stopReason === 'cancelled' && !turn.text.trim())
        turn.text = t('electron.common.you-denied-this-tool-call-so-this-turn');
      const tc = r?._meta?.quota?.token_count;
      // 上面两种都是整轮累计；当前上下文：Gemini 取最后一条 usage_update，Grok 取 _meta 的末次请求
      const ctx = { ...acpMetaContext(r?._meta), ...sent.usage };
      const turnUsage =
        tc && (tc.input_tokens !== undefined || tc.output_tokens !== undefined)
          ? {
              ...(tc.input_tokens !== undefined ? { inputTokens: tc.input_tokens } : {}),
              ...(tc.output_tokens !== undefined ? { outputTokens: tc.output_tokens } : {}),
            }
          : parseUsage(r?._meta?.usage, {});
      const usage = turnUsage || Object.keys(ctx).length ? { ...turnUsage, ...ctx } : undefined;
      const done: HarnessEvent = {
        type: 'done',
        text: turn.text,
        sessionId: live.sessionId ?? undefined,
        ...(usage ? { usage } : {}),
      };
      turn.events.push(done);
      this.emitEvent(tab.id, done);
      return {
        text: turn.text || t('electron.common.no-text-output'),
        sessionId: live.sessionId,
        events: turn.events,
        ...(turn.breaks.length ? { textBreaks: turn.breaks } : {}),
      };
    } finally {
      live.turn = null;
      live.lastActivityAt = Date.now();
      if (live.recycleAfterTurn && this.acpLive.get(tab.id) === live) this.teardownAcpLive(tab.id);
    }
  }

  /**
   * Grok：把标签的模型 / 思考深度同步到长驻会话（session/set_model、session/set_config_option
   * reasoning_effort，1.0.62 实测原地生效，不重启进程）。清掉覆盖时按模型目录里的默认值切回；
   * 目录还没读到、不知道默认值时返回 false，由调用方换新进程。Gemini 没有标签级覆盖。
   */
  private async syncAcpOverrides(tab: HarnessTabMeta, live: AcpLiveSession): Promise<boolean> {
    if (live.backend !== 'grok' || !live.sessionId) return true;
    // 第三方：模型写在私有 GROK_HOME 的配置里，换模型时按 launchSig 重启进程
    if (this.sourceOf(tab) === 'thirdParty') return true;
    const want = this.effectiveOverrides(tab);
    if (live.model === want.model && live.effort === want.effort) return true;
    const catalog = this.cachedCatalog('grok');
    const fail = (what: string) => (e: unknown) => {
      throw new Error(
        t(
          'electron.common.grok-did-not-switch-the',
          what,
          innermostMessage(e instanceof Error ? e.message : String(e)),
        ),
        { cause: e },
      );
    };
    if (live.model !== want.model) {
      const modelId = want.model ?? catalog?.defaultModel?.id;
      if (!modelId) return false;
      await live.driver.setSessionModel(modelId).catch(fail(t('electron.common.model')));
      live.model = want.model;
      // 换模型后 CLI 会换成那个模型的默认档位：思考深度覆盖要重新下发
      live.effort = null;
    }
    if (live.effort !== want.effort) {
      const modelId = want.model ?? catalog?.defaultModel?.id;
      const value =
        want.effort ?? catalog?.models.find((m) => m.id === modelId)?.defaultEffort ?? null;
      if (!value) return want.effort === null;
      await live.driver
        .setConfigOption('reasoning_effort', value)
        .catch(fail(t('electron.common.reasoning-effort')));
      live.effort = want.effort;
    }
    return true;
  }

  private cancelAcpTurn(live: AcpLiveSession) {
    // session/cancel；规范要求：取消时挂起的权限请求按 cancelled 应答
    void live.driver.interrupt();
    for (const done of [...live.perms.values()]) done(null);
  }

  private teardownAcpLive(tabId: string) {
    const live = this.acpLive.get(tabId);
    if (!live) return;
    this.acpLive.delete(tabId);
    for (const done of [...live.perms.values()]) done(null);
    void live.driver.close();
  }

  /**
   * 不产生界面事件的协议行：用户消息回显（轮次开始标记）与后台任务生命周期。返回 true 表示已处理完。
   */
  private onClaudeMeta(tabId: string, live: ClaudeLiveSession, line: string): boolean {
    // control_response 由驱动按 request_id 交给等待者，到不了这里
    const replay = line.includes('"isReplay"');
    const task = line.includes('"subtype":"task_');
    if (!replay && !task) return false;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (replay && j.type === 'user' && j.isReplay === true) {
      live.replaySeen = true;
      if (typeof j.uuid === 'string' && j.uuid === live.turnUuid && live.turn) {
        // CLI 开始处理用户消息：还没收到 result 的自发轮次到此为止（按已有内容落盘）
        if (live.auto) this.finishAutoTurn(tabId, live);
        live.turnStarted = true;
      }
      return true;
    }
    if (task && j.type === 'system') {
      const id = typeof j.task_id === 'string' ? j.task_id : '';
      const patch = (j.patch ?? {}) as Record<string, unknown>;
      const status = String(j.status ?? patch.status ?? '');
      const before = live.bgTasks.size;
      if (id && j.subtype === 'task_started' && j.is_backgrounded === true) live.bgTasks.add(id);
      else if (
        id &&
        (j.subtype === 'task_notification' ||
          (j.subtype === 'task_updated' && TERMINAL_TASK_STATUS.has(status)))
      )
        live.bgTasks.delete(id);
      if (live.bgTasks.size !== before) this.changed();
    }
    // task_* 仍交给解析器（P1 映射成 agent 事件）
    return false;
  }

  /** 没有进行中的用户轮次时 CLI 自己开始输出：开一个自发轮次接住它 */
  private startAutoTurn(tabId: string, live: ClaudeLiveSession): ClaudeTurnWaiter {
    const tab = this.tabs.get(tabId);
    const auto: ClaudeTurnWaiter & { startedAt: number } = {
      resolve: () => undefined,
      reject: () => undefined,
      events: [],
      text: '',
      breaks: [],
      sessionId: tab?.cliSessionId ?? null,
      lastError: null,
      settled: false,
      startedAt: Date.now(),
    };
    live.auto = auto;
    if (tab && tab.status !== 'running') {
      tab.status = 'running';
      this.changed();
    }
    return auto;
  }

  /** 自发轮次结束（result / 错误 / 被下一条用户消息接替 / 进程拆除）：落盘成一条助手消息并提醒 */
  private finishAutoTurn(tabId: string, live: ClaudeLiveSession, error?: string, stopped = false) {
    const auto = live.auto;
    if (!auto) return;
    live.auto = null;
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (auto.sessionId && tab.backend === 'claude') this.bindCliSession(tab, auto.sessionId);
    const trace = buildTrace(auto.events);
    const usage = mergeUsage(auto.events);
    const content = error && !auto.text.trim() ? error : auto.text;
    const msg: HarnessTabMessage = {
      id: randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      durationMs: Date.now() - auto.startedAt,
      origin: 'background',
      ...withModel(this.turnModelResolver(tab)(auto.events, usage)),
      ...(error ? { error: true as const } : {}),
      ...(stopped ? { stopped: true as const } : {}),
      ...(usage ? { usage } : {}),
      ...(trace.length ? { trace } : {}),
      ...(auto.breaks.length ? { textBreaks: auto.breaks } : {}),
    };
    if (tabId === MAIN_TAB_ID) {
      // 主标签的消息由渲染层存进 Nomi 历史：广播出去由它落盘
      tab.updatedAt = msg.timestamp;
      this.post('harness.tabMessage', { tabId, message: msg });
    } else {
      this.appendMessage(tabId, msg);
    }
    // 用户轮次已在排队 / 进行中时保持 running，否则回到空闲
    if (!live.turn && tab.status === 'running') tab.status = 'idle';
    if (stopped) this.changed();
    else this.finish(tab, !error, content, error);
  }

  // ───────────────────────── 空闲回收 ─────────────────────────

  /** 有长驻进程时才巡检；定时器不阻止进程退出 */
  private startIdleSweep() {
    if (this.idleTimer || this.idleReclaimMs <= 0) return;
    this.idleTimer = setInterval(() => this.reclaimIdle(), sweepIntervalMs(this.idleReclaimMs));
    this.idleTimer.unref?.();
  }

  private stopIdleSweep() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** 修改空闲回收阈值（毫秒，0 = 关闭）；立即生效 */
  setIdleReclaimMs(ms: number): void {
    this.idleReclaimMs = resolveIdleReclaimMs(ms, undefined);
    this.stopIdleSweep();
    // 任一种长驻会话在就重开（只看 claude 时，只有 codex / acp 会话的进程改设置后就不再回收）
    if (this.claudeLive.size || this.acpLive.size || this.codexLive.size) this.startIdleSweep();
  }

  /**
   * 回收空闲的长驻进程（无进行中的轮次 / 待处理权限，且已有可 --resume 的会话），
   * 标记为「休眠」并通知界面。返回被回收的标签 id。
   */
  reclaimIdle(now = Date.now()): string[] {
    const picked = pickIdle(
      [
        ...[...this.acpLive.entries()].map(([id, gl]) => ({
          id,
          lastActivityAt: gl.lastActivityAt,
          turnActive: gl.turn !== null,
          permissionPending: gl.perms.size > 0,
          tabBusy: ['running', 'queued'].includes(this.tabs.get(id)?.status ?? 'idle'),
          resumable: Boolean(this.tabs.get(id)?.cliSessionId) || !gl.used,
        })),
        ...[...this.codexLive.entries()].map(([id, cl]) => ({
          id,
          lastActivityAt: cl.lastActivityAt,
          turnActive: cl.turn !== null,
          permissionPending: cl.perms.size > 0,
          tabBusy: ['running', 'queued'].includes(this.tabs.get(id)?.status ?? 'idle'),
          resumable: Boolean(this.tabs.get(id)?.cliSessionId) || !cl.used,
        })),
        ...[...this.claudeLive.entries()].map(([id, live]) => ({
          id,
          lastActivityAt: live.lastActivityAt,
          turnActive: live.turn !== null,
          permissionPending: (this.pendingPermissions.get(id)?.size ?? 0) > 0,
          tabBusy: ['running', 'queued'].includes(this.tabs.get(id)?.status ?? 'idle'),
          resumable: Boolean(this.tabs.get(id)?.cliSessionId) || live.prewarmed === true,
          backgroundActive: claudeBackgroundActive(live),
        })),
      ],
      now,
      this.idleReclaimMs,
    );
    for (const id of picked) {
      this.teardownClaudeLive(id);
      // 没用过的预热进程：没有会话可休眠，悄悄回收
      if (this.tabs.get(id)?.cliSessionId) this.dormant.add(id);
      this.d.logger.info('harness idle process reclaimed', { tabId: id });
    }
    if (picked.length) this.changed();
    if (!this.claudeLive.size && !this.acpLive.size && !this.codexLive.size) this.stopIdleSweep();
    return picked;
  }

  /**
   * 官方账号已经切换（凭据落到了 CLI 自己的存储）。正在跑的进程不会重读凭据。
   * 只处理来源为官方的标签；第三方标签走网关，不受影响（§13 第 3 条）。
   * Claude 是唯一跨轮长驻的进程：空闲的悄悄拆掉，下一轮用原来的 cliSessionId
   * 带 --resume 重拉。这一轮还在输出时先记下，等它正常结束再拆，避免「已中止」或休眠条。
   * Codex / dsh / Grok 每条消息都是新进程，下一轮自己读新配置；不杀掉正在跑的那一轮。
   */
  recycleBackend(kind: HarnessBackend, only?: (tab: HarnessTabMeta) => boolean): void {
    // 换了账号：官方可选模型跟着变，下次打开浮层重新从 CLI 读
    this.modelCatalogs.delete(kind);
    // 换账号前发出的读取作废：回来后不写缓存，下一次读取重新发起
    this.modelCatalogGen.set(kind, (this.modelCatalogGen.get(kind) ?? 0) + 1);
    this.modelCatalogInflight.delete(kind);
    // 标签上的模型选择换成新来源的（官方 ↔ 某个供应商各记各的）
    this.adoptScopes(kind);
    // 新会话也不再沿用旧账号 / 供应商下选的模型与思考深度（权限模式照旧）
    const last = this.lastSettings.get(kind);
    if (last?.modelOverride || last?.reasoningEffort) {
      delete last.modelOverride;
      delete last.reasoningEffort;
      this.persist();
    }
    // 换的是官方账号：第三方标签走网关，与官方凭据无关，不重启（§13 第 3 条）
    const official = (id: string) => {
      const tab = this.tabs.get(id);
      if (!tab) return true;
      return this.sourceOf(tab) === 'official' && (!only || only(tab));
    };
    if (kind === 'gemini' || kind === 'grok') {
      // 登录在会话建立时读取：空闲的直接拆，正在跑的这一轮结束后再拆
      for (const [id, gl] of [...this.acpLive.entries()]) {
        if (gl.backend !== kind || !official(id)) continue;
        if (gl.turn) gl.recycleAfterTurn = true;
        else this.teardownAcpLive(id);
      }
      return;
    }
    if (kind === 'codex') {
      // 供应商写的是 config.toml：app-server 只在启动时读，空闲的直接拆，正在跑的这一轮结束后再拆
      for (const [id, cl] of [...this.codexLive.entries()]) {
        if (!official(id)) continue;
        if (cl.turn) cl.recycleAfterTurn = true;
        else this.teardownCodexLive(id);
      }
      return;
    }
    if (kind !== 'claude') return;
    for (const [id, live] of [...this.claudeLive.entries()]) {
      if (!official(id)) continue;
      if (live.turn && !live.turn.settled) {
        live.recycleAfterTurn = true;
        continue;
      }
      this.teardownClaudeLive(id);
    }
    if (!this.claudeLive.size) this.stopIdleSweep();
  }

  /**
   * 这个 CLI 升级了（P9.6）：长驻进程空闲的立刻拆、正在跑的这一轮结束后再拆，下一条消息用新版本续接
   * （--resume / session/load / thread/resume）。官方与第三方标签都算；不动模型选择、来源与账号。
   * 新版本可能多了模型：可选模型列表下次打开时重新读。
   */
  restartForUpgrade(kind: HarnessBackend): { restarted: number; deferred: number } {
    let restarted = 0;
    let deferred = 0;
    this.modelCatalogs.delete(kind);
    this.modelCatalogGen.set(kind, (this.modelCatalogGen.get(kind) ?? 0) + 1);
    this.modelCatalogInflight.delete(kind);
    if (kind === 'gemini' || kind === 'grok') {
      for (const [id, gl] of [...this.acpLive.entries()]) {
        if (gl.backend !== kind) continue;
        if (gl.turn) {
          gl.recycleAfterTurn = true;
          deferred++;
        } else {
          this.teardownAcpLive(id);
          restarted++;
        }
      }
    } else if (kind === 'codex') {
      for (const [id, cl] of [...this.codexLive.entries()]) {
        if (cl.turn) {
          cl.recycleAfterTurn = true;
          deferred++;
        } else {
          this.teardownCodexLive(id);
          restarted++;
        }
      }
    } else if (kind === 'claude') {
      for (const [id, live] of [...this.claudeLive.entries()]) {
        if (live.turn && !live.turn.settled) {
          live.recycleAfterTurn = true;
          deferred++;
        } else {
          this.teardownClaudeLive(id);
          restarted++;
        }
      }
      if (!this.claudeLive.size) this.stopIdleSweep();
    }
    if (restarted || deferred)
      this.d.logger.info('cli upgraded: restarting sessions at idle', {
        kind,
        restarted,
        deferred,
      });
    return { restarted, deferred };
  }

  /** 这个 CLI 正在进行的轮次数（Windows 上升级前要先排空：运行中的程序文件不能被替换） */
  busyTurns(kind: HarnessBackend): number {
    return [...this.tabs.values()].filter((x) => x.backend === kind && x.status === 'running')
      .length;
  }

  /** 改了默认官方账号：只重启「跟随默认账号」的官方标签（§5.10 S5） */
  recycleDefaultAccount(kind: AccountBackend): void {
    this.recycleBackend(kind, (tab) => !tab.accountId);
  }

  /** 官方标签上选的账号（null = 跟随默认）；账号服务据此统计使用中的标签数 */
  officialAccountTabs(kind: AccountBackend): Array<string | null> {
    return [...this.tabs.values()]
      .filter((x) => x.backend === kind && this.sourceOf(x) === 'official')
      .map((x) => x.accountId ?? null);
  }

  /**
   * 给一个官方标签换账号（null = 跟随默认账号）：只重启这个标签的进程（进行中的这一轮结束后再重启），
   * 会话照常续接；推理签名不认时按 §5.10.5 处理。
   */
  setTabAccount(id: string, accountId: string | null): HarnessTabMeta {
    const tab = this.requireTab(id);
    if (!isAccountBackend(tab.backend))
      throw new Error(t('electron.common.this-coding-assistant-has-no-official-accounts'));
    const next = accountId ? String(accountId) : null;
    if ((tab.accountId ?? null) === next) return { ...tab };
    tab.accountId = next;
    // 会话在新账号里续接：之后历史按新账号标注
    if (tab.cliSessionId && this.sourceOf(tab) === 'official')
      this.d.accounts?.noteSession?.(tab.backend, tab.cliSessionId, next);
    this.recycleBackend(tab.backend, (x) => x.id === id);
    this.changed();
    return { ...tab };
  }

  /** 供应商已换且这一轮已经结束：拆掉长驻进程，不标记休眠、不改会话。 */
  private dropRecycledClaude(tabId: string, live: ClaudeLiveSession) {
    if (!live.recycleAfterTurn || live.turn) return;
    live.recycleAfterTurn = false;
    if (this.claudeLive.get(tabId) !== live) return;
    this.teardownClaudeLive(tabId);
    if (!this.claudeLive.size) this.stopIdleSweep();
  }

  /** 拆除 Claude 长驻进程（不 reject 当前 turn——由 close/kill 路径处理） */
  private teardownClaudeLive(tabId: string) {
    // 所有拆长驻进程的入口（换目录 / 换后端 / 关标签 / 停止 / 回收）同样拆 ACP / Codex 的长驻进程
    this.teardownAcpLive(tabId);
    this.teardownCodexLive(tabId);
    this.dormant.delete(tabId);
    const live = this.claudeLive.get(tabId);
    if (!live) return;
    // 自发轮次还没结束就拆进程（停止 / 关标签 / 换目录）：已输出的部分按「已停止」落盘，不丢
    if (live.auto) this.finishAutoTurn(tabId, live, undefined, true);
    if (live.bgTasks.size) {
      live.bgTasks.clear();
      this.changed();
    }
    this.clearBackgroundAgents(tabId);
    this.claudeLive.delete(tabId);
    this.children.delete(tabId);
    this.clearPermissionTimeouts(tabId);
    const turn = live.turn;
    live.turn = null;
    const child = live.child;
    try {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
    } catch {
      /* */
    }
    // 在途的 control_request 一律失败；关 stdin 并结束进程树
    void live.driver.close();
    if (turn && !turn.settled) {
      turn.settled = true;
      turn.reject(new Error(t('electron.common.aborted')));
    }
  }

  /**
   * Codex 一轮：默认走 `codex app-server` 长驻会话（流式、turn/interrupt 停止不杀进程、每轮 turn/start
   * 带模型 / 思考深度 / 沙箱 / 审批参数即时生效、逐项确认）。起不来（版本过旧）时记下来，之后都退回
   * 每轮一个进程的 `codex exec`。两种方式读写同一份会话（exec 建的线程可在 app-server 里续接，反之亦然）。
   */
  private async runCodexTurn(
    tab: HarnessTabMeta,
    prompt: string,
    signal: AbortSignal,
    staged: StagedImage[] = [],
    onTurn?: (turn: { sessionId: string; turnId: string }) => void,
  ): Promise<HarnessSendResult> {
    if (this.usesCodexApp()) {
      try {
        return await this.runCodexLive(tab, prompt, signal, staged, onTurn);
      } catch (e) {
        if (!(e instanceof AcpUnavailableError) || signal.aborted) throw e;
        this.codexAppUnavailable = true;
        this.d.logger.warn('harness codex app-server unavailable, falling back to codex exec', e);
      }
    }
    return this.runCodex(tab, prompt, staged);
  }

  private usesCodexApp(): boolean {
    return Boolean(this.d.codexAppServer) && !this.codexAppUnavailable;
  }

  /**
   * 拉起 / 复用 `codex app-server`：initialize → initialized；有会话 id 时 thread/resume。
   * 新会话的 thread/start 推迟到第一条消息（预热不留下空会话）。
   */
  private async ensureCodexLive(
    tab: HarnessTabMeta,
    signal?: AbortSignal,
  ): Promise<CodexLiveSession> {
    const existing = this.codexLive.get(tab.id);
    const launch = this.launchFor(tab);
    if (
      existing &&
      existing.cwd === tab.cwd &&
      existing.launchSig === launch.sig &&
      !existing.driver.closed
    ) {
      await existing.ready;
      return existing;
    }
    if (existing) this.teardownCodexLive(tab.id);
    const spawnLaunch = await this.bindTabLaunch(tab, launch);
    const bin = resolveHarnessBin('codex');
    if (!bin) throw new Error(t('electron.common.codex-not-found-set-nomi-use-mock-cli'));
    const useNode = isScript(bin);
    // 第三方：-c 指向网关（模型按轮下发，见 runCodexLive）
    const argv = ['app-server', ...launch.args];
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      env: this.childEnv(useNode, spawnLaunch),
      tabId: tab.id,
    });
    this.watchTabRelease(tab, child);
    child.stderr.on('data', (c) => {
      this.d.logger.warn('harness codex stderr', String(c).slice(0, 500));
    });
    // 协议（握手、线程、轮次、审批、用量）交给 cli-sdk 的 app-server 驱动；这里只做编排
    const driver = new AppServerDriver({
      child,
      permissionIdPrefix: 'codex-perm-',
      rpc: { timeoutMessage: acpTimeoutMessage },
      kill: killProcessTree,
      // 线程条目 → exec --json 的条目 → 已有的 parseCodexLine：工具名与展示和每轮一个进程时一致。
      // exec 的 agent_message 完成时附带一个 done：这里的整轮结束由 turn/completed 决定，去掉它
      mapItem: (phase, item) => {
        const x = codexExecItem(item);
        if (!x) return [];
        const line = JSON.stringify({
          type: phase === 'started' ? 'item.started' : 'item.completed',
          item: x,
        });
        return parseCodexLine(line).filter((e) => e.type !== 'done');
      },
    });
    const live: CodexLiveSession = {
      child,
      driver,
      threadId: null,
      cwd: tab.cwd,
      model: null,
      effort: null,
      launchSig: spawnLaunch.sig,
      turn: null,
      perms: new Map(),
      lastActivityAt: Date.now(),
      ready: Promise.resolve(),
    };
    driver.on((e) => {
      live.lastActivityAt = Date.now();
      if (e.kind === 'harness' && e.turnId && live.turn)
        this.onCodexEvents(tab.id, live, [e.event]);
      if (e.kind !== 'permission') return;
      live.perms.set(e.id, (allow) => {
        live.perms.delete(e.id);
        driver.respondPermission(
          e.id,
          allow === null ? { decision: 'cancel' } : { decision: allow ? 'allow' : 'deny' },
        );
      });
      this.onCodexEvents(tab.id, live, [
        withPermissionExpiry(
          { type: 'permission', id: e.id, summary: e.request.summary },
          this.permissionTimeoutMs(tab.id),
        ),
      ]);
    });
    child.on('close', () => {
      if (this.codexLive.get(tab.id) === live) this.codexLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      for (const done of live.perms.values()) done(null);
      const turn = live.turn;
      live.turn = null;
      if (turn && !turn.settled) {
        turn.settled = true;
        turn.reject(new Error(turn.lastError ?? t('electron.common.the-codex-process-exited')));
      }
    });
    this.codexLive.set(tab.id, live);
    this.dormant.delete(tab.id);
    this.startIdleSweep();
    const opts = signal ? { signal } : {};
    live.ready = (async () => {
      await driver.start({ cwd: tab.cwd, resumeId: tab.cliSessionId, ...opts });
      live.threadId = driver.threadId;
    })();
    try {
      await live.ready;
    } catch (e) {
      this.teardownCodexLive(tab.id);
      if (signal?.aborted) throw new Error(t('electron.common.aborted'), { cause: e });
      if (e instanceof Error && e.message === 'ACP process exited')
        throw new AcpUnavailableError(t('electron.common.codex-could-not-start-the-app-server'), {
          cause: e,
        });
      throw new Error(innermostMessage(e instanceof Error ? e.message : String(e)), { cause: e });
    }
    return live;
  }

  private async runCodexLive(
    tab: HarnessTabMeta,
    prompt: string,
    signal: AbortSignal,
    staged: StagedImage[] = [],
    onTurn?: (turn: { sessionId: string; turnId: string }) => void,
  ): Promise<HarnessSendResult> {
    let live = await this.ensureCodexLive(tab, signal);
    // 清掉了覆盖、又不知道 CLI 的默认值：换新进程（按 config.toml 的默认模型 / 档位续接）
    const want = this.effectiveOverrides(tab);
    const catalog = this.cachedCatalog('codex');
    const defaultModel = catalog?.defaultModel?.id;
    let model: string | undefined;
    let effort: string | undefined;
    if (live.model !== want.model) model = want.model ?? defaultModel;
    if (live.effort !== want.effort || model !== undefined)
      effort =
        want.effort ??
        catalog?.models.find((m) => m.id === (want.model ?? defaultModel))?.defaultEffort;
    if ((live.model !== want.model && !model) || (live.effort !== want.effort && !effort)) {
      this.teardownCodexLive(tab.id);
      live = await this.ensureCodexLive(tab, signal);
    }
    // 第三方：模型按轮下发（inplace，§6.7），绑定跟上标签的主模型
    await this.syncTabBinding(tab);
    if (signal.aborted) throw new Error(t('electron.common.aborted'));
    if (live.turn) throw new Error(t('electron.common.previous-turn-still-running'));
    if (!live.threadId) {
      live.threadId = await live.driver.ensureThread(tab.cwd).catch((e: unknown) => {
        if (e instanceof Error && e.message === 'app-server returned no thread')
          throw new Error(t('electron.common.codex-did-not-return-a-session'), { cause: e });
        throw e;
      });
    }
    if (signal.aborted) throw new Error(t('electron.common.aborted'));
    const text = (tab.permissionMode === 'plan' ? planPromptPrefix('codex') : '') + prompt;
    const chatRoot = path.join(path.dirname(this.d.root), 'chat');
    live.used = true;
    live.lastActivityAt = Date.now();
    return new Promise<HarnessSendResult>((resolve, reject) => {
      const turn: CodexTurn = {
        events: [],
        text: '',
        breaks: [],
        lastError: null,
        settled: false,
        resolve,
        reject,
        chatRoot,
        imageAliases: loadImageAliases(chatRoot),
      };
      live.turn = turn;
      live.driver
        .send({
          text,
          ...(staged.length ? { blocks: codexTurnInput(text, staged) } : {}),
          params: {
            cwd: tab.cwd,
            ...codexTurnPolicy(tab.permissionMode, { network: this.codexNetwork }),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
          },
        })
        .then(
          (r) => {
            // turn/start 已被接受：覆盖已下发
            live.model = want.model;
            live.effort = want.effort;
            // 完成 / 中断 / 失败的轮次都在线程里：都记下，重试时按它回退
            if (r.cliTurnId && live.threadId)
              onTurn?.({ sessionId: live.threadId, turnId: r.cliTurnId });
            this.finishCodexTurn(tab.id, live, turn, r);
          },
          (e: unknown) => {
            if (live.turn === turn) live.turn = null;
            if (turn.settled) return;
            turn.settled = true;
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === 'app-server process exited') this.turnExits.add(tab.id);
            reject(
              new Error(
                msg === 'app-server process exited'
                  ? (turn.lastError ?? t('electron.common.the-codex-process-exited'))
                  : innermostMessage(msg),
              ),
            );
          },
        );
    });
  }

  private onCodexEvents(tabId: string, live: CodexLiveSession, evs: HarnessEvent[]) {
    const turn = live.turn;
    for (const raw of evs) {
      let ev = withPermissionExpiry(stampEvent(raw), this.permissionTimeoutMs(tabId));
      if (turn) {
        if (ev.type === 'tool' && ev.output) {
          materializeGeneratedImages(ev.output, this.home, turn.chatRoot, turn.imageAliases);
          turn.text = rewriteGeneratedImageLinks(turn.text, turn.imageAliases);
        }
        if (ev.type === 'text-delta' || ev.type === 'text') {
          const text = rewriteGeneratedImageLinks(ev.text, turn.imageAliases);
          if (text !== ev.text) ev = { ...ev, text };
        }
        const folded = foldAssistantEvent(turn.text, turn.breaks, ev);
        turn.text = folded.text;
        turn.breaks = folded.breaks;
        ev = folded.ev;
        if (ev.type !== 'text-delta') turn.events.push(ev);
        if (ev.type === 'error') turn.lastError = ev.message;
      }
      if (ev.type === 'permission') ev = markApprovePlanIfExit(ev);
      this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        const notify = () =>
          this.events.emit('permission-needed', {
            tabId,
            title: tab?.title ?? 'Codex',
            backend: 'codex' as HarnessBackend,
            summary: ev.summary,
            background: this.activeTabId !== tabId || !this.appFocused(),
          });
        if (ev.kind === 'approve-plan') notify();
        else this.allowIfBypass(tabId, ev.id, notify);
      }
    }
  }

  private finishCodexTurn(tabId: string, live: CodexLiveSession, turn: CodexTurn, r: TurnResult) {
    if (live.turn === turn) live.turn = null;
    live.lastActivityAt = Date.now();
    this.clearPermissionTimeouts(tabId);
    for (const fin of [...live.perms.values()]) fin(null);
    if (turn.settled) return;
    turn.settled = true;
    if (r.stopReason === 'interrupted') turn.reject(new Error(t('electron.common.aborted')));
    else if (r.stopReason === 'failed')
      turn.reject(new Error(r.error || turn.lastError || t('electron.common.codex-error')));
    else {
      const ev: HarnessEvent = {
        type: 'done',
        text: turn.text,
        sessionId: live.threadId ?? undefined,
        ...(r.usage ? { usage: r.usage } : {}),
      };
      turn.events.push(ev);
      this.emitEvent(tabId, ev);
      turn.resolve({
        text:
          rewriteGeneratedImageLinks(turn.text, turn.imageAliases) ||
          t('electron.common.no-text-output'),
        sessionId: live.threadId,
        events: turn.events,
        ...(turn.breaks.length ? { textBreaks: turn.breaks } : {}),
      });
    }
    if (live.recycleAfterTurn && this.codexLive.get(tabId) === live) this.teardownCodexLive(tabId);
  }

  /**
   * 停止 Codex 这一轮：turn/interrupt（实测 18ms 内以 interrupted 结束，进程保留）。
   * 宽限期内这一轮没结束，才拆进程兜底（下一轮 thread/resume 接上）。
   * turn/start 的应答还没回来时不立刻拆：轮询等 turnId，到了再 interrupt；
   * 否则用户刚点发送就点停止会误杀整个 app-server（macOS CI 上更容易撞上）。
   */
  private interruptCodexTurn(id: string, live: CodexLiveSession, turn: CodexTurn) {
    for (const fin of [...live.perms.values()]) fin(null);
    const grace = this.d.claudeInterruptGraceMs ?? CLAUDE_INTERRUPT_GRACE_MS;
    const fallback = () => {
      if (this.codexLive.get(id) === live && live.turn === turn && !turn.settled)
        this.teardownCodexLive(id);
    };
    setTimeout(fallback, grace).unref?.();
    // 驱动在 turn/start 的应答回来之后才发 turn/interrupt
    live.driver.interrupt().catch(fallback);
  }

  private teardownCodexLive(tabId: string) {
    const live = this.codexLive.get(tabId);
    if (!live) return;
    this.codexLive.delete(tabId);
    for (const done of [...live.perms.values()]) done(null);
    this.clearPermissionTimeouts(tabId);
    const turn = live.turn;
    live.turn = null;
    void live.driver.close();
    if (turn && !turn.settled) {
      turn.settled = true;
      turn.reject(new Error(t('electron.common.aborted')));
    }
  }

  private runCodex(
    tab: HarnessTabMeta,
    prompt: string,
    staged: StagedImage[] = [],
  ): Promise<HarnessSendResult> {
    const bin = resolveHarnessBin('codex');
    if (!bin)
      return Promise.reject(new Error(t('electron.common.codex-not-found-set-nomi-use-mock-cli')));
    const useNode = isScript(bin);
    // `exec` 默认 read-only 沙箱且禁网：沙箱 / 联网 / 自动审批都按权限模式用 -c 指定
    // （`exec resume` 不接受 --sandbox / --cd；工作目录由 spawn 的 cwd 决定，也即可写根）
    const sandbox = permissionLaunch('codex', tab.permissionMode, {
      codexNetwork: this.codexNetwork,
    }).args;
    let launch: TabLaunch;
    try {
      launch = this.launchFor(tab);
    } catch (e) {
      return Promise.reject(e);
    }
    // 标签级模型 / 思考深度覆盖（进程级 -c，不写全局 config.toml）；第三方再加指向网关的 -c
    const modelArgs = [...launch.args, ...overrideArgs('codex', this.effectiveOverrides(tab))];
    prompt = (tab.permissionMode === 'plan' ? planPromptPrefix('codex') : '') + prompt;
    // 同一份逻辑参数：.js / .mjs 入口只是经 node 启动、前面多一个脚本路径，
    // 沙箱 / 审批 / 联网参数不能因入口形式不同而丢掉（#73）
    const imgArgs = staged.length ? codexImageArgs(staged) : [];
    const argv = tab.cliSessionId
      ? [
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          ...sandbox,
          ...modelArgs,
          ...imgArgs,
          tab.cliSessionId,
          prompt,
        ]
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          ...sandbox,
          ...modelArgs,
          '--cd',
          tab.cwd,
          ...imgArgs,
          prompt,
        ];
    return this.spawnCollect(tab, {
      cmd: useNode ? process.execPath : bin,
      argv: useNode ? [bin, ...argv] : argv,
      parseLine: parseCodexLine,
      kind: 'codex',
      launch,
      asNode: useNode,
    });
  }

  /**
   * dsh 无头模式：`dsh --profile headless --json [--session-id id] <prompt>`。
   * 续接要求同一 cwd；Mock（.mjs）也收到完整参数，便于测试会话转发。
   */
  private runDsh(tab: HarnessTabMeta, prompt: string): Promise<HarnessSendResult> {
    const bin = resolveHarnessBin('dsh');
    if (!bin)
      return Promise.reject(new Error(t('electron.common.dsh-not-found-set-nomi-use-mock-cli')));
    const useNode = isScript(bin);
    // 第三方：网关地址与模型写在只给这个进程用的叠加配置里（--patch 在 profile 之后生效）
    let launch: TabLaunch;
    try {
      launch = this.launchFor(tab);
    } catch (e) {
      return Promise.reject(e);
    }
    const argv = ['--profile', 'headless', ...launch.args, '--json'];
    if (tab.cliSessionId) argv.push('--session-id', tab.cliSessionId);
    if (tab.permissionMode === 'plan') prompt = planPromptPrefix('dsh') + prompt;
    // 以 - 开头的提示会被当成参数，前置空格规避
    argv.push(prompt.startsWith('-') ? ` ${prompt}` : prompt);
    return this.spawnCollect(tab, {
      cmd: useNode ? process.execPath : bin,
      argv: useNode ? [bin, ...argv] : argv,
      parseLine: createDshParser(),
      kind: 'dsh',
      // 沙箱档位：DSH_PERMISSION_MODE（read-only / workspace-write / danger-full-access）
      env: permissionLaunch('dsh', tab.permissionMode).env,
      launch,
      asNode: useNode,
    });
  }

  /**
   * Grok 一轮：默认走 ACP 长驻会话（与 Gemini 同一套：流式、停止不杀进程、模型 / 思考深度 / 权限原地切换、
   * 逐项确认）。这台机器上的 Grok 起不来 ACP（版本过旧）时记下来，之后都退回每轮一个进程的 `grok -p`。
   */
  private async runGrokTurn(
    tab: HarnessTabMeta,
    prompt: string,
    signal: AbortSignal,
    images?: NormalizedImage[],
  ): Promise<HarnessSendResult> {
    if (this.d.grokAcp && !this.grokAcpUnavailable) {
      try {
        return await this.runAcp(tab, prompt, signal, images);
      } catch (e) {
        if (!(e instanceof AcpUnavailableError) || signal.aborted) throw e;
        this.grokAcpUnavailable = true;
        this.d.logger.warn('harness grok ACP unavailable, falling back to grok -p', e);
      }
    }
    return this.runGrok(tab, prompt, images);
  }

  /** 一轮消息的附图 / 提示文件临时目录（轮次结束 finally 里整个删除） */
  private promptImageDir(tabId: string): string {
    return path.join(this.d.root, 'prompt-images', tabId.replace(/[^\w-]/g, '_'));
  }

  /**
   * Grok Build 无头模式：`grok -p <prompt> --output-format streaming-json --no-auto-update`，
   * 权限按标签模式加 `--permission-mode <mode>`（完全放开为 `--yolo`）。
   * 续接：`--resume <sessionId>`。无头权限事件格式未在真机验证，暂不开放「逐项确认」。
   * 官方：docs.x.ai/build/cli/headless-scripting 。
   */
  private runGrok(
    tab: HarnessTabMeta,
    prompt: string,
    images?: NormalizedImage[],
  ): Promise<HarnessSendResult> {
    const bin = resolveHarnessBin('grok');
    if (!bin)
      return Promise.reject(new Error(t('electron.common.grok-not-found-set-nomi-use-mock-cli')));
    const useNode = isScript(bin);
    let launch: TabLaunch;
    try {
      launch = this.launchFor(tab);
    } catch (e) {
      return Promise.reject(e);
    }
    const promptArgv = images?.length
      ? grokPromptFileArgv(this.promptImageDir(tab.id), prompt, images)
      : ['-p', prompt.startsWith('-') ? ` ${prompt}` : prompt];
    const argv = [
      ...promptArgv,
      '--output-format',
      'streaming-json',
      '--no-auto-update',
      ...permissionLaunch('grok', tab.permissionMode).args,
      // 标签级模型 / 思考深度覆盖（进程级 -m / --reasoning-effort，不写全局配置）；
      // 第三方的模型写在私有配置里
      ...(launch.modelInConfig ? [] : overrideArgs('grok', this.effectiveOverrides(tab))),
    ];
    if (tab.cliSessionId) argv.push('--resume', tab.cliSessionId);
    if (tab.cwd) argv.push('--cwd', tab.cwd);
    return this.spawnCollect(tab, {
      cmd: useNode ? process.execPath : bin,
      argv: useNode ? [bin, ...argv] : argv,
      parseLine: createGrokParser(),
      kind: 'grok',
      launch,
      asNode: useNode,
    });
  }

  private async spawnCollect(
    tab: HarnessTabMeta,
    opts: {
      cmd: string;
      argv: string[];
      parseLine: (line: string) => HarnessEvent[];
      kind: BuiltinBackend;
      env?: Record<string, string>;
      /** 来源注入（第三方：网关；官方：剔除网关残留）；缺省按官方 */
      launch?: TabLaunch;
      /** 通过 process.execPath 跑 .mjs/.js 时为 true（需 ELECTRON_RUN_AS_NODE） */
      asNode?: boolean;
      /** 仅特殊 mock 需要保持 stdin；Codex/dsh 必须立刻 EOF。Claude 走 ensureClaudeLive */
      keepStdin?: boolean;
    },
  ): Promise<HarnessSendResult> {
    const events: HarnessEvent[] = [];
    let text = '';
    let breaks: number[] = [];
    let sessionId: string | null = tab.cliSessionId;
    const chatRoot = path.join(path.dirname(this.d.root), 'chat');
    const imageAliases = loadImageAliases(chatRoot);
    // 进程、收发与收尾判定在 cli-sdk 的 exec 驱动里；「怎样算整轮完成」由插件给（EXEC_RULES）。
    // 这里只做界面相关的处理：生成图片落盘、文本折叠、权限提示、实时广播。
    const rules = EXEC_RULES[opts.kind];
    // 每轮一个进程：每次都是新进程代次，先登记绑定再启动（§6.7）
    const launch = await this.bindTabLaunch(tab, opts.launch ?? OFFICIAL_LAUNCH);
    const driver = new ExecDriver({
      spawn: (cmd, argv, o) => {
        const child = spawnHarness(cmd, argv, {
          cwd: o.cwd,
          // 剔除 Nomi 内部变量；只有该后端自己的供应商（opts.env）才会注入额外变量
          // .mjs mock 经 Electron execPath 启动时必须 ELECTRON_RUN_AS_NODE（见 cliChildEnv）
          env: this.childEnv(Boolean(opts.asNode), launch, opts.env),
          tabId: tab.id,
        });
        this.watchTabRelease(tab, child);
        this.children.set(tab.id, child);
        return child as unknown as ChildLike;
      },
      command: opts.cmd,
      cwd: tab.cwd,
      args: () => opts.argv,
      parser: () => opts.parseLine,
      resumeId: tab.cliSessionId,
      // Codex/dsh：stdin 管道不 EOF 会挂起；仅特殊 mock 需要保持打开（见到 done 再 EOF）
      keepStdin: opts.keepStdin,
      completes: rules.completes,
      // dsh 在 Node < 24 下不报错、无输出、退出码 0
      ...(rules.silentExitIsError
        ? {
            silentExit: () =>
              t(
                'electron.common.dsh-produced-no-output-it-needs-node-the',
                DSH_MIN_NODE_MAJOR,
                readPathNodeVersion() ?? t('electron.common.not-found'),
              ),
          }
        : {}),
      // 用户停止 / 被信号杀死：不能因为「已有部分文字」就当成功完成（见 #25）
      stopRequested: () => this.stopRequested.has(tab.id),
      abortedMessage: t('electron.common.aborted'),
      exitMessage: (code) => t('electron.common.exit-code', opts.kind, code),
      onStderr: (c) => this.d.logger.warn(`harness ${opts.kind} stderr`, c.slice(0, 500)),
    });
    const take = (rawEv: HarnessEvent, live: boolean) => {
      let ev = rawEv;
      if (ev.type === 'tool' && ev.output) {
        materializeGeneratedImages(ev.output, this.home, chatRoot, imageAliases);
        // 某些 CLI 会先发 assistant 文本、后发 tool 完成事件；别名建立后同步修正已累计文本。
        text = rewriteGeneratedImageLinks(text, imageAliases);
      }
      if (ev.type === 'text-delta' || ev.type === 'text' || ev.type === 'done') {
        const text = rewriteGeneratedImageLinks(ev.text, imageAliases);
        if (text !== ev.text) ev = { ...ev, text };
      }
      ev = withPermissionExpiry(stampEvent(ev), this.permissionTimeoutMs(tab.id));
      const folded = foldAssistantEvent(text, breaks, ev);
      text = folded.text;
      breaks = folded.breaks;
      ev = folded.ev;
      if (ev.type !== 'text-delta') events.push(ev);
      if (ev.type === 'permission') ev = markApprovePlanIfExit(ev);
      if (live) this.emitEvent(tab.id, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tab.id, ev.id);
        const notify = () =>
          this.events.emit('permission-needed', {
            tabId: tab.id,
            title: tab.title,
            backend: tab.backend,
            summary: ev.summary,
            background: this.activeTabId !== tab.id || !this.appFocused(),
          });
        if (ev.kind === 'approve-plan') notify();
        else this.allowIfBypass(tab.id, ev.id, notify);
      }
      if (ev.type === 'done' && ev.sessionId) sessionId = ev.sessionId;
    };
    driver.on((se) => {
      if (se.kind === 'harness') take(se.event, !se.tail);
    });
    try {
      await driver.send({ text: '' });
    } finally {
      this.children.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      void driver.close();
    }
    return {
      text: rewriteGeneratedImageLinks(text, imageAliases) || t('electron.common.no-text-output'),
      sessionId,
      events,
      ...(breaks.length ? { textBreaks: breaks } : {}),
    };
  }

  // ───────────────────────── 广播 / IPC ─────────────────────────

  private post(channel: AppEventName, payload: unknown) {
    // 其它通道的消息（tab-message / tabs / changed）必须排在已入队的实时事件之后
    this.eventBatcher.flush();
    this.broadcast(channel, payload);
  }

  /**
   * 推送只发给对话窗口：`events.publish('harness.*', …, { surface: 'chat' })`，即契约事件 `harness.*`
   * （只推给订阅了的窗口）。没接上事件总线之前（契约处理函数 attachEvents 之前）没有订阅者，直接丢弃。
   */
  private broadcast(channel: AppEventName, payload: unknown) {
    this.appEvents?.publish(channel, payload, { surface: 'chat' });
  }

  /** 应用事件总线（发布契约事件） */
  private appEvents: AppEvents | null = null;

  /** 推送改走应用事件总线（host/contract/coding.ts 在建 router 与每次调用时接上；重复调用无副作用） */
  attachEvents(events: AppEvents): void {
    this.appEvents = events;
  }

  /** 记下一轮里最近的文本 / 工具步骤，不做任何额外计算或模型调用 */
  private trackProgress(tabId: string, ev: HarnessEvent) {
    const prev = this.progress.get(tabId);
    if (ev.type === 'text-delta' || ev.type === 'text') {
      const base = prev?.kind === 'text' ? prev.value : '';
      this.progress.set(tabId, {
        kind: 'text',
        value: (ev.type === 'text' ? ev.text : base + ev.text).slice(-400),
      });
    } else if (ev.type === 'tool' && ev.status === 'start') {
      this.progress.set(tabId, {
        kind: 'tool',
        value: (ev.detail ? `${ev.name} ${ev.detail}` : ev.name).slice(0, 160),
      });
    }
  }

  /** 标签当前这一轮的进度提示（最近一段文本或「正在执行 工具」）；没有则 undefined */
  progressHint(tabId: string): string | undefined {
    const p = this.progress.get(tabId);
    if (!p?.value.trim()) return undefined;
    const v = p.value.replace(/\s+/g, ' ').trim();
    return p.kind === 'tool' ? t('electron.common.running-named', v) : v;
  }

  private emitEvent(tabId: string, ev: HarnessEvent) {
    this.trackProgress(tabId, ev);
    if (ev.type === 'permission-resolved' && ev.reason !== 'allowed')
      this.countDelegatedApproval(tabId, ev.reason === 'timeout' ? 'timedOut' : 'denied');
    const part = this.partial.get(tabId);
    let outgoing = ev;
    if (part && ev.type === 'context') {
      part.context =
        ev.tokens === null
          ? undefined
          : {
              contextTokens: ev.tokens,
              ...(ev.window ? { contextWindow: ev.window } : {}),
              ...(ev.model ? { model: ev.model } : {}),
            };
    }
    if (part?.q) noteQuality(part.q, ev);
    if (part) {
      const folded = foldAssistantEvent(part.text, part.breaks, ev);
      part.text = folded.text;
      part.breaks = folded.breaks;
      outgoing = folded.ev;
      if (outgoing.type === 'tool' || outgoing.type === 'thinking') part.events.push(outgoing);
    }
    this.eventBatcher.push({ ...outgoing, tabId });
    this.events.emit('event', { tabId, event: outgoing });
    if (outgoing.type === 'agent') this.trackBackgroundAgent(tabId, outgoing);
  }

  /** 只记后台子代理的开始 / 结束（进度不广播标签列表，避免频繁刷新） */
  private trackBackgroundAgent(tabId: string, ev: Extract<HarnessEvent, { type: 'agent' }>) {
    let m = this.bgAgents.get(tabId);
    if (ev.op === 'start' && ev.background) {
      if (!m) this.bgAgents.set(tabId, (m = new Map()));
      if (!m.has(ev.id)) {
        m.set(ev.id, { ...(ev.label ? { label: ev.label } : {}), startedAt: Date.now() });
        this.changed();
      }
    } else if (ev.op === 'end' && m?.delete(ev.id)) {
      if (!m.size) this.bgAgents.delete(tabId);
      this.changed();
    }
  }

  /** 进程 / 轮次结束：这个标签的后台子代理随之结束 */
  private clearBackgroundAgents(tabId: string) {
    if (this.bgAgents.delete(tabId)) this.changed();
  }

  /**
   * 单独停止一个后台子代理（Claude `stop_task`，2.1.303 起支持）。其它 CLI 没有对应控制，返回 false。
   */
  stopAgent(tabId: string, agentId: string): boolean {
    const live = this.claudeLive.get(tabId);
    if (!live || !this.bgAgents.get(tabId)?.has(agentId)) return false;
    return this.writeClaudeControl(live, { subtype: 'stop_task', task_id: agentId });
  }

  /**
   * State changed: schedule the (coalesced) state files, notify in-process listeners right away,
   * and send the full state to the windows once per microtask turn, so a burst of status changes
   * in one event costs one state()/listTabs() serialization over IPC instead of one per call.
   */
  private changed() {
    this.persist();
    if (this.events.listenerCount('tabs')) this.events.emit('tabs', this.listTabs());
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    queueMicrotask(() => {
      this.broadcastQueued = false;
      if (this.disposed) return;
      this.post('harness.changed', this.state());
      this.post('harness.tabsChanged', this.listTabs());
    });
  }

  /**
   * Claude system/status.permissionMode 回写标签档位（PR3）：CLI 自己切了档，Nomi 跟上，避免不一致。
   * 认不出的原生值不覆盖（fromCliPermissionMode → null）。
   */
  private applyCliPermissionMode(tabId: string, raw: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.backend === 'nomi') return;
    const mapped = fromCliPermissionMode(tab.backend, raw);
    if (!mapped || mapped === tab.permissionMode) return;
    tab.permissionMode = mapped;
    delete tab.permissionModeSource;
    const live = this.claudeLive.get(tabId);
    if (live && !live.modeChange) live.permissionMode = mapped;
    const gl = this.acpLive.get(tabId);
    if (gl && !gl.modeChange) gl.permissionMode = mapped;
    this.rememberSettings(tab);
    this.changed();
  }

  /**
   * 用户允许/拒绝工具权限请求；写回 CLI stdin 的 control_response。
   * PR3：`approvePlan` 用于 ExitPlanMode「批准计划」——允许时顺带 set_permission_mode；
   * `execute-plan:*` 是 Codex/dsh/Grok 回合结束后的本地卡，不写 CLI。
   */
  replyPermission(
    tabId: string,
    requestId: string,
    allow: boolean,
    reason: 'allowed' | 'denied' | 'timeout' = allow ? 'allowed' : 'denied',
    opts?: { approvePlan?: ApprovePlanChoice },
  ): boolean {
    // Codex / dsh / Grok：计划模式回合结束后的「按此方案执行」（本地队列，无 CLI control）
    if (isExecutePlanId(requestId)) {
      this.clearOnePermissionTimeout(tabId, requestId);
      const choice = opts?.approvePlan ?? (allow ? 'acceptEdits' : 'deny');
      this.emitEvent(tabId, {
        type: 'permission-resolved',
        id: requestId,
        reason: choice === 'deny' ? (reason === 'timeout' ? 'timeout' : 'denied') : 'allowed',
      });
      if (choice !== 'deny') {
        const mode = approvePlanMode(choice) ?? 'acceptEdits';
        try {
          this.setTabPermissionMode(tabId, mode);
        } catch (e) {
          this.d.logger.warn('harness execute-plan mode switch failed', e);
        }
        // 切到自动改文件后发送「按上述计划实施」（设计默认）
        void this.sendTab(tabId, t(EXECUTE_PLAN_FOLLOW_UP)).catch((e) =>
          this.d.logger.warn('harness execute-plan follow-up failed', e),
        );
      } else if (reason === 'timeout') {
        this.countDelegatedApproval(tabId, 'timedOut');
      } else if (!allow) {
        this.countDelegatedApproval(tabId, 'denied');
      }
      return true;
    }

    const gemini =
      this.acpLive.get(tabId)?.perms.get(requestId) ??
      this.codexLive.get(tabId)?.perms.get(requestId);
    if (gemini) {
      this.clearOnePermissionTimeout(tabId, requestId);
      gemini(allow);
      this.emitEvent(tabId, { type: 'permission-resolved', id: requestId, reason });
      if (allow && opts?.approvePlan && opts.approvePlan !== 'deny') {
        const mode = approvePlanMode(opts.approvePlan);
        if (mode) {
          try {
            this.setTabPermissionMode(tabId, mode);
          } catch (e) {
            this.d.logger.warn('harness approve-plan mode switch failed', e);
          }
        }
      }
      return true;
    }
    // 两轮之间（后台子代理 / 自发轮次）发起的请求没有 children 记录：改用长驻进程的 stdin
    const child = this.children.get(tabId) ?? this.claudeLive.get(tabId)?.child;
    if (!child || !requestId || child.stdin.destroyed || !child.stdin.writable) return false;
    this.clearOnePermissionTimeout(tabId, requestId);
    const payload = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: t('electron.common.the-user-didn-t-allow-this-call') },
      },
    };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      // 界面按 id 移除对应卡片（并行子代理的请求排成队列，不能只清「当前那一个」）
      this.emitEvent(tabId, { type: 'permission-resolved', id: requestId, reason });
      // Claude ExitPlanMode：允许后写 set_permission_mode（设计：批准 = allow + 切档）
      if (allow && opts?.approvePlan && opts.approvePlan !== 'deny') {
        const mode = approvePlanMode(opts.approvePlan);
        if (mode) {
          try {
            this.setTabPermissionMode(tabId, mode);
          } catch (e) {
            this.d.logger.warn('harness ExitPlanMode mode switch failed', e);
          }
        }
      }
      return true;
    } catch (e) {
      this.d.logger.warn('harness permission reply failed', e);
      return false;
    }
  }

  /**
   * PR3「批准计划」卡的三选一：批准并自动改文件 / 批准并逐项确认 / 继续修改。
   * 继续修改 = deny（留在计划模式）；前两项 = allow + 切档。
   */
  replyApprovePlan(tabId: string, requestId: string, choice: ApprovePlanChoice): boolean {
    if (choice === 'deny')
      return this.replyPermission(tabId, requestId, false, 'denied', { approvePlan: 'deny' });
    return this.replyPermission(tabId, requestId, true, 'allowed', { approvePlan: choice });
  }

  /**
   * 用户在「Gemini 不信任此文件夹」的错误卡片上点了「信任此文件夹」并确认：把那条消息记录的文件夹
   * （只此一个）写进 Gemini 自己的受信任列表。文件夹取自主进程保存的消息，不接受界面传来的路径。
   */
  async trustGeminiFolder(
    tabId: string,
    messageId: string,
    opts: { confirmed?: boolean } = {},
  ): Promise<GeminiTrustResult> {
    if (!opts.confirmed)
      throw new Error(t('electron.common.please-confirm-before-trusting-this-folder'));
    if (!this.tabs.has(tabId) || tabId === MAIN_TAB_ID)
      throw new Error(t('electron.common.tab-not-found'));
    const msg = this.tabMessages(tabId).find((m) => m.id === messageId);
    const folder = msg?.geminiTrust?.folder;
    if (!folder) throw new Error(t('electron.common.this-message-has-no-folder-to-trust'));
    const env = { ...process.env };
    const r = await trustGeminiFolder(folder, { home: this.home, env });
    this.d.logger.info('gemini folder trusted by user', { folder: r.folder, file: r.file });
    // 旧进程在信任前就已退出；保险起见清掉，下一轮按新的信任状态重新启动
    if (this.acpLive.has(tabId)) this.teardownAcpLive(tabId);
    return r;
  }

  /**
   * 这个标签的「完全放开」是否已在 CLI 侧生效。长驻进程（Claude / Gemini / Grok）以进程确认过的档位为准：
   * 切换被拒（如组织策略禁用了完全放开）或还在等确认时都不算，不能替 CLI 放行它要问的请求。
   * Codex 每轮按标签档位下发审批策略，本轮的旧策略仍会来问，按标签档位算。
   */
  private bypassInEffect(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (tab?.permissionMode !== 'bypass') return false;
    const live = this.claudeLive.get(tabId) ?? this.acpLive.get(tabId);
    if (live) return live.permissionMode === 'bypass' && !live.modeChange;
    return tab.backend === 'codex' && this.codexLive.has(tabId);
  }

  /**
   * 「完全放开」已生效，CLI 却仍发来确认请求（Codex 本轮的审批策略在开轮时定下等）：直接放行，
   * 不再发通知。卡片事件已发出，放行后随 permission-resolved 一起移除；放行没写进去就照常通知。
   */
  private allowIfBypass(tabId: string, requestId: string, notify: () => void): void {
    if (!this.bypassInEffect(tabId)) {
      notify();
      return;
    }
    queueMicrotask(() => {
      if (!this.replyPermission(tabId, requestId, true)) notify();
    });
  }

  private armPermissionTimeout(tabId: string, requestId: string) {
    let m = this.pendingPermissions.get(tabId);
    if (!m) {
      m = new Map();
      this.pendingPermissions.set(tabId, m);
    }
    const prev = m.get(requestId);
    if (prev) clearTimeout(prev);
    if (!prev) this.countDelegatedApproval(tabId, 'asked');
    const timer = setTimeout(() => {
      this.replyPermission(tabId, requestId, false, 'timeout');
    }, this.permissionTimeoutMs(tabId));
    // 权限卡 120s 超时不应拖住进程退出
    (timer as { unref?: () => void }).unref?.();
    m.set(requestId, timer);
  }

  /** 审批等待时间：Nomi 委派开、用户还没接手的标签 10 分钟，其余 120 秒 */
  permissionTimeoutMs(tabId: string): number {
    const d = this.tabs.get(tabId)?.delegation;
    return d && !d.takenOver ? DELEGATED_PERMISSION_TIMEOUT_MS : PERMISSION_TIMEOUT_MS;
  }

  private countDelegatedApproval(tabId: string, k: 'asked' | 'denied' | 'timedOut') {
    const d = this.tabs.get(tabId)?.delegation;
    if (d) d.approvals[k] += 1;
  }

  /** 用户在委派开的标签里自己发了消息：标签归用户（Nomi 不再往里发），审批等待恢复 120 秒 */
  private markTakenOver(id: string) {
    const d = this.tabs.get(id)?.delegation;
    if (d && !d.takenOver) {
      d.takenOver = true;
      this.changed();
    }
  }

  /**
   * 用户在委派标签中发送消息时，先取消 Nomi 当前轮次并等待它真正回到 idle，
   * 再把标签归用户。这样不会让两个 sendTab 同时写入同一个 CLI 会话。
   */
  private async takeOverDelegatedTab(id: string): Promise<void> {
    const existing = this.takeoverInFlight.get(id);
    if (existing) return existing;
    const p = this.performTakeover(id).finally(() => {
      if (this.takeoverInFlight.get(id) === p) this.takeoverInFlight.delete(id);
    });
    this.takeoverInFlight.set(id, p);
    return p;
  }

  private async performTakeover(id: string): Promise<void> {
    const tab = this.requireTab(id);
    const delegation = tab.delegation;
    if (!delegation || delegation.takenOver) return;
    // 先标记接管，再 cancel：委派 finalize 看到 takenOver 就不会删 worktree（#118）
    this.markTakenOver(id);
    if (tab.status === 'running' || tab.status === 'queued') {
      if (!this.cancelTab(id))
        throw new Error(t('electron.common.cannot-take-over-the-previous-turn-is-still'));
      await this.waitForTabIdle(id, 30_000);
    }
    const current = this.requireTab(id);
    if (current.status === 'running' || current.status === 'queued')
      throw new Error(t('electron.common.cannot-take-over-the-previous-turn-is-still'));
  }

  private waitForTabIdle(id: string, timeoutMs: number): Promise<void> {
    const isIdle = () => {
      const status = this.tabs.get(id)?.status;
      return status !== 'running' && status !== 'queued';
    };
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(t('electron.common.cannot-take-over-the-previous-turn-did-not')));
      }, timeoutMs);
      const cleanup = () => {
        this.events.off('tabs', onTabs);
        clearTimeout(timer);
      };
      const onTabs = () => {
        if (!isIdle()) return;
        cleanup();
        resolve();
      };
      this.events.on('tabs', onTabs);
      (timer as { unref?: () => void }).unref?.();
    });
  }

  private clearOnePermissionTimeout(tabId: string, requestId: string) {
    const m = this.pendingPermissions.get(tabId);
    const tmr = m?.get(requestId);
    if (tmr) clearTimeout(tmr);
    m?.delete(requestId);
    if (m && m.size === 0) this.pendingPermissions.delete(tabId);
  }

  private clearPermissionTimeouts(tabId: string) {
    const m = this.pendingPermissions.get(tabId);
    if (!m) return;
    for (const tmr of m.values()) clearTimeout(tmr);
    this.pendingPermissions.delete(tabId);
  }

  // ─────────────── 渲染层入口（契约处理函数用；cwd 先核对是已知工作区） ───────────────

  /** 渲染层读状态：先确认各 CLI 的可执行文件（后台探测好的缓存），再返回主标签状态 */
  async stateFresh(): Promise<ReturnType<HarnessOrchestrator['state']>> {
    await this.refreshBins().catch(() => undefined);
    return this.state();
  }

  /** 主标签发送；返回给渲染层的结果不含逐条事件 */
  async sendReply(prompt: string): Promise<HarnessSendReply> {
    return slimResult(await this.send(prompt));
  }
  /** 用户在标签里发送（userInitiated：接管委派标签）；返回给渲染层的结果不含逐条事件 */
  async sendTabReply(
    id: string,
    prompt: string,
    images?: HarnessImageInput[],
  ): Promise<HarnessSendReply> {
    return slimResult(await this.sendTab(id, prompt, images, { userInitiated: true }));
  }

  slashDiscoverIn(backend: unknown, cwd: unknown) {
    return discoverSlash(asSlashBackend(backend), this.knownDir(cwd));
  }
  slashExpandIn(backend: unknown, cwd: unknown, id: unknown, args: unknown) {
    return expandSlash(
      asSlashBackend(backend),
      this.knownDir(cwd),
      String(id ?? ''),
      String(args ?? '').slice(0, 4000),
    );
  }
  gitDiffIn(cwd: unknown) {
    return gitDiff(this.knownDir(cwd));
  }
  gitBranchIn(cwd: unknown) {
    return gitBranch(this.knownDir(cwd));
  }
  gitSyncStatusIn(cwd: unknown) {
    return gitSyncStatus(this.knownDir(cwd));
  }
  gitStageIn(cwd: unknown, paths: unknown) {
    return gitStage(this.knownDir(cwd), paths);
  }
  gitUnstageIn(cwd: unknown, paths: unknown) {
    return gitUnstage(this.knownDir(cwd), paths);
  }
  gitCommitIn(cwd: unknown, message: unknown, paths?: unknown) {
    return gitCommit(this.knownDir(cwd), message, paths ?? undefined);
  }
  gitCommitUndoIn(cwd: unknown, sha: unknown) {
    return gitCommitUndo(this.knownDir(cwd), sha);
  }
  gitFetchIn(cwd: unknown) {
    return gitFetch(this.knownDir(cwd));
  }
  gitPullIn(cwd: unknown) {
    return gitPull(this.knownDir(cwd));
  }
  gitPushIn(cwd: unknown) {
    return gitPush(this.knownDir(cwd));
  }
  gitDiscardIn(cwd: unknown, paths: unknown) {
    return gitDiscard(this.knownDir(cwd), paths);
  }
  gitDiscardUndoIn(cwd: unknown, stashes: unknown) {
    return gitDiscardUndo(this.knownDir(cwd), stashes);
  }
  workspaceReadIn(cwd: unknown, filePath: unknown) {
    return readWorkspaceFile(this.knownDir(cwd), String(filePath ?? ''));
  }
  workspaceWriteIn(cwd: unknown, filePath: unknown, content: unknown) {
    return writeWorkspaceFile(this.knownDir(cwd), String(filePath ?? ''), String(content ?? ''));
  }
  workspaceDeleteIn(cwd: unknown, filePath: unknown) {
    return deleteWorkspaceFile(this.knownDir(cwd), String(filePath ?? ''));
  }
  workspaceGitCheckoutIn(cwd: unknown, filePath: unknown) {
    return gitCheckoutWorkspaceFile(this.knownDir(cwd), String(filePath ?? ''));
  }
  workspaceListIn(cwd: unknown) {
    return listWorkspaceTree(this.knownDir(cwd));
  }

  /** 上下文环：Claude 标签空闲时以 CLI 自己的会话记录为准（见 transcriptContext.ts）；没有时 null */
  async tabContext(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.backend !== 'claude' || !tab.cliSessionId) return null;
    return claudeTranscriptContext(
      claudeConfigDir(this.home, process.env),
      tab.cwd,
      tab.cliSessionId,
    ).catch(() => null);
  }

  /** 权限卡的回答：带 approvePlan（批准计划三选一）时按计划处理，否则允许 / 拒绝 */
  answerPermission(tabId: string, requestId: string, allow: boolean, approvePlan?: unknown) {
    if (approvePlan === 'acceptEdits' || approvePlan === 'manual' || approvePlan === 'deny')
      return this.replyApprovePlan(tabId, requestId, approvePlan);
    return this.replyPermission(tabId, requestId, allow);
  }

  /** 批准计划卡（批准并自动改文件 / 批准并逐项确认 / 继续修改）；其他值报错 */
  answerApprovePlan(tabId: string, requestId: string, choice: unknown) {
    const c = String(choice);
    if (c !== 'acceptEdits' && c !== 'manual' && c !== 'deny')
      throw new Error(t('electron.common.invalid-approve-plan-choice'));
    return this.replyApprovePlan(tabId, requestId, c);
  }
}

/** Claude 长驻会话：一标签一进程，多轮共用 */
type ClaudeTurnWaiter = {
  resolve: (r: HarnessSendResult) => void;
  reject: (e: Error) => void;
  events: HarnessEvent[];
  text: string;
  breaks: number[];
  sessionId: string | null;
  lastError: string | null;
  settled: boolean;
};

type AcpBackend = 'gemini' | 'grok' | 'external';

/** ACP 后端的显示名：外部插件用清单里的名称 */
function acpDisplayName(backend: AcpBackend, ext?: ExternalCliSpec): string {
  if (backend === 'grok') return 'Grok';
  if (backend === 'gemini') return 'Gemini';
  return ext?.displayName ?? 'CLI';
}

type CodexTurn = {
  events: HarnessEvent[];
  text: string;
  breaks: number[];
  lastError: string | null;
  settled: boolean;
  resolve: (r: HarnessSendResult) => void;
  reject: (e: Error) => void;
  chatRoot: string;
  imageAliases: Map<string, string>;
};

/** `codex app-server` 长驻进程：一个标签一个线程 */
type CodexLiveSession = {
  /** 启动时的来源注入签名（见 launchFor）：变了就不能复用 */
  launchSig: string;
  child: ChildProcessWithoutNullStreams;
  /** app-server 协议（线程、轮次、审批、用量）由 cli-sdk 的驱动负责 */
  driver: AppServerDriver;
  /** 线程 id（= cliSessionId）；新会话在第一条消息时才 thread/start */
  threadId: string | null;
  cwd: string;
  /** 已随 turn/start 下发的模型 / 思考深度覆盖（null = 沿用 config.toml 默认） */
  model: string | null;
  effort: string | null;
  turn: CodexTurn | null;
  /** 挂起的审批：id → 应答（true 允许 / false 拒绝 / null 取消） */
  perms: Map<string, (allow: boolean | null) => void>;
  lastActivityAt: number;
  ready: Promise<void>;
  used?: boolean;
  /** 换了账号 / 供应商：这一轮结束后拆掉，下一轮按新配置重拉 */
  recycleAfterTurn?: boolean;
};

/** ACP 握手阶段进程就退出（CLI 太旧 / 不支持 ACP）：Grok 据此退回每轮一个进程的 `grok -p` */
class AcpUnavailableError extends Error {}

/* ------------------------- 模型质量（CLI 层，docs/design/model-quality.md §4.4） ------------------------- */

/** 一轮里的质量计时（epoch ms）与 CLI 报的 API 重试次数 */
interface TurnQuality {
  first?: number;
  firstText?: number;
  last?: number;
  retries: number;
}

/** 这一轮发送时定下的来源字段 */
type QualityBase = Pick<QualityRecord, 'client' | 'source' | 'provider' | 'accountId'>;

/** 官方账号标签的服务商（CLI 直连的官方接口） */
const OFFICIAL_PROVIDER: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
  gemini: 'google',
  dsh: 'deepseek',
};

/** 生成时长不到这么久、输出又不少：上游 / CLI 缓冲后整段吐出（§2.2 突发度） */
const BURST_MS = 100;
const BURST_MIN_TOKENS = 20;

/**
 * 按事件更新这一轮的计时：正文、推理、工具调用开始都算内容。逐字增量之后 CLI 往往再给一次完整正文，
 * 那次不再推后「最后一个内容」（否则生成时长被拉到结束时刻）；只给完整正文的 CLI 以它为准。
 */
function noteQuality(q: TurnQuality, ev: HarnessEvent, now = Date.now()): void {
  if (ev.type === 'status') {
    if (ev.kind === 'retry') q.retries += 1;
    return;
  }
  const isText = (ev.type === 'text-delta' || ev.type === 'text') && !!ev.text;
  if (ev.type === 'text' && q.firstText !== undefined) return;
  const content =
    isText ||
    (ev.type === 'thinking' && !!ev.text) ||
    (ev.type === 'tool' && ev.status === 'start');
  if (!content) return;
  q.first ??= now;
  q.last = now;
  if (isText) q.firstText ??= now;
}

/** 错误链里有「长驻进程已退出」（ACP / app-server 驱动的原始错误）：一轮进行中进程退出 */
function exitedCause(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur instanceof Error && i < 8; cur = cur.cause, i++)
    if (cur.message === RPC_EXITED || cur.message === 'app-server process exited') return true;
  return false;
}

type AcpTurn = {
  /** 这一轮里用户拒绝过工具调用（Grok 会以 cancelled 结束整轮） */
  denied?: boolean;
  events: HarnessEvent[];
  text: string;
  breaks: number[];
};

type AcpLiveSession = {
  /** 启动时的来源注入签名（见 launchFor）：变了就不能复用 */
  launchSig: string;
  backend: AcpBackend;
  /** 已下发到会话的标签级模型 / 思考深度覆盖（null = 沿用 CLI 默认；仅 Grok） */
  model: string | null;
  effort: string | null;
  child: ChildProcessWithoutNullStreams;
  /** ACP 协议（握手、会话、权限、取消）由 cli-sdk 的驱动负责 */
  driver: AcpDriver;
  sessionId: string | null;
  cwd: string;
  permissionMode: HarnessPermissionMode;
  turn: AcpTurn | null;
  /** 挂起的审批：id → 应答（true 允许 / false 拒绝 / null 取消） */
  perms: Map<string, (allow: boolean | null) => void>;
  lastActivityAt: number;
  ready: Promise<void>;
  /** 最近一次还没得到确认的权限模式切换（permissionMode 只在确认后更新，#72） */
  modeChange: ModeChange | null;
  /** 账号切换时正在跑：这一轮结束后拆掉，下一轮按新登录重拉 */
  recycleAfterTurn?: boolean;
  /** 发过消息；没发过的（预热拉起的）没有会话也可回收（不丢上下文） */
  used?: boolean;
};

/**
 * 发给长驻进程、还在等后端确认的权限模式切换。done 只在「最新一次」切换失败时 reject
 * （此时进程 / 会话已拆除，下一轮按标签档位重新拉起）；被更新的切换取代的旧请求不报错。
 */
type ModeChange = { mode: HarnessPermissionMode; done: Promise<void> };

/** 某个后端最近一次的标签设置（新会话的起点） */
type LastTabSettings = {
  permissionMode?: HarnessPermissionMode;
  modelOverride?: string;
  reasoningEffort?: string;
  /** 上面的模型属于哪个来源（第三方供应商 id；缺省 = 官方账号） */
  modelScope?: string;
};

/** 长驻 Claude 进程上还有后台任务或自发轮次在跑（拆进程会把它们一起杀掉） */
function claudeBackgroundActive(live: ClaudeLiveSession): boolean {
  return live.bgTasks.size > 0 || live.auto !== null;
}

type ClaudeLiveSession = {
  /** 启动时的来源注入签名（见 launchFor）：变了就不能复用 */
  launchSig: string;
  /** 启动时的 TabLaunch.modelSig */
  modelSig: string;
  child: ChildProcessWithoutNullStreams;
  /** stdin / stdout 与 control_request ↔ control_response 由 cli-sdk 的 stream-json 驱动负责 */
  driver: StreamJsonDriver;
  parseLine: (line: string) => HarnessEvent[];
  turn: ClaudeTurnWaiter | null;
  cwd: string;
  /** 进程已生效的权限模式：启动参数，或最近一次得到成功 control_response 的 set_permission_mode */
  permissionMode: HarnessPermissionMode;
  /** 最近一次还没得到确认的权限模式切换；确认前不复用进程跑下一轮（#72） */
  modeChange: ModeChange | null;
  /** 进程当前的标签级模型 / 思考深度覆盖（启动参数或最近一次成功的 set_model；复用键的一部分） */
  modelOverride: string | null;
  reasoningEffort: string | null;
  /**
   * 轮次归属（docs/design/cli-subagents.md §4）：用户消息带 uuid 写入，CLI 开始处理它时原样回显
   * （--replay-user-messages）。回显到达前的输出不属于这一轮；没有进行中的用户轮次时来的输出是自发轮次。
   */
  turnUuid: string | null;
  turnStarted: boolean;
  /** 本进程见过回显：老版本 CLI 不回显时退回「写入即开始」 */
  replaySeen: boolean;
  /** 自发轮次（后台子代理完成后主代理的跟进），result 到达时落盘 */
  auto: (ClaudeTurnWaiter & { startedAt: number }) | null;
  /** 仍在运行的后台任务 id（Claude task_started.is_backgrounded） */
  bgTasks: Set<string>;
  /** 最近一次活动（拉起 / 发送 / 收到输出）；空闲回收据此判断 */
  lastActivityAt: number;
  /** 供应商已换：这一轮结束后拆进程，不打断当前回复 */
  recycleAfterTurn?: boolean;
  /** 预热拉起、还没发过消息：没有会话也可回收（不丢上下文） */
  prewarmed?: boolean;
};

/** Claude 后台任务的终态（task_updated.patch.status / task_notification.status） */
const TERMINAL_TASK_STATUS = new Set([
  'completed',
  'failed',
  'stopped',
  'killed',
  'cancelled',
  'error',
]);

/** 会让 CLI「正在输出」的事件：没有进行中的用户轮次时，它们开启一个自发轮次 */
function isTurnContent(ev: HarnessEvent): boolean {
  return (
    ev.type === 'text-delta' ||
    ev.type === 'text' ||
    ev.type === 'tool' ||
    ev.type === 'thinking' ||
    ev.type === 'permission' ||
    ev.type === 'agent'
  );
}

function samePath(a: string, b: string): boolean {
  const key = (p: string) => {
    const r = realDir(p);
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return key(a) === key(b);
}

function validDir(cwd: string): string {
  const abs = path.resolve(String(cwd ?? ''));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(t('electron.common.invalid-working-directory'));
  }
  return abs;
}

function asSlashBackend(b: unknown): SlashBackend {
  return b === 'claude' || b === 'codex' || b === 'grok' || b === 'dsh' ? b : 'nomi';
}

function slimResult(r: HarnessSendResult): HarnessSendReply {
  const { events: _events, ...rest } = r;
  return rest;
}

/** 播种（分叉 / 历史恢复）消息时保留的结构化字段：轨迹、耗时、用量、中断标记 */
/**
 * Codex 原地回退的目标轮次：这条用户消息记着它在当前线程里的 turn id，且它之前还有这个线程的轮次
 * （回退到线程开头时改开新会话，免得丢掉分叉带进第一轮的前文）。
 */
function codexRevertTarget(
  list: readonly HarnessTabMessage[],
  idx: number,
  threadId: string,
): string | null {
  const turn = list[idx]?.cliTurn;
  if (turn?.sessionId !== threadId) return null;
  const earlier = list
    .slice(0, idx)
    .some((m) => m.role === 'user' && m.cliTurn?.sessionId === threadId);
  return earlier ? turn.turnId : null;
}

function seedExtras(m: HarnessTabMessage): Partial<HarnessTabMessage> {
  return {
    ...(Array.isArray(m.trace) && m.trace.length ? { trace: m.trace.slice(0, 300) } : {}),
    ...(typeof m.durationMs === 'number' ? { durationMs: m.durationMs } : {}),
    ...(m.usage && typeof m.usage === 'object' ? { usage: m.usage } : {}),
    ...(m.stopped ? { stopped: true as const } : {}),
    ...withModel(m.model),
  };
}

/** 消息上的模型字段：只收非空字符串 */
function withModel(model: unknown): { model?: string } {
  return typeof model === 'string' && model.trim() ? { model: model.trim().slice(0, 200) } : {};
}

/** 一轮里 CLI 最后一次报告的模型（context 事件，如 Claude assistant.message.model） */
function reportedModel(events: readonly HarnessEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'context' && e.model) return e.model;
  }
  return undefined;
}

/** 对外名字不变：编排层的类就是 HarnessOrchestrator */
export const CliHarnessService = HarnessOrchestrator;
export type CliHarnessService = HarnessOrchestrator;

/** 落盘的长上下文选择：形状不对就丢弃（回到跟随模型默认） */
function sanitizeLongContext(v: unknown): HarnessTabMeta['longContext'] {
  if (!v || typeof v !== 'object') return null;
  const o = v as { model?: unknown; on?: unknown };
  return typeof o.model === 'string' && o.model && typeof o.on === 'boolean'
    ? { model: o.model, on: o.on }
    : null;
}
