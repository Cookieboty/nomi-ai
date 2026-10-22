/**
 * 对话后端：Nomi | Claude Code | Codex | dsh | Grok，按「标签」并发运行。
 *
 * - 标签 'main'：原有对话，后端可为 Nomi 或任一 CLI；消息由渲染层存进 Nomi 历史。
 *   旧的单会话接口（state / setBackend / setCwd / send）都作用于它。
 * - 其它标签：只绑定 CLI 后端，带独立的 CLI 会话与 cwd，消息存于 harness/tabs/<id>.json。
 * - 全局并发上限（默认 3）：超出的轮次排队（status = queued）。
 * - CLI 模式下禁用 Nomi 工具（send 不走 AIClient）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, dialog } from 'electron';

import { t } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { CoalescedWriter, flushPendingWritesSync } from '../utils/coalescedWriter';
import { writePrivateFile } from '../utils/privateFile';

import { buildCliEnv } from './cliEnv';
import { resolveHarnessLaunch } from './cliLaunch';
import {
  codexApprovalSummary,
  codexExecItem,
  codexTokenTotals,
  codexTurnPolicy,
  codexTurnUsage,
  type CodexTokenTotals,
} from './codex/appServer';
import { codexConfigPath, grokHomePath } from './configPatch';
import { buildCarriedContext, carriedBudget, fitCarried, withCarriedContext } from './contextCarry';
import {
  DSH_MIN_NODE_MAJOR,
  peekCliBin,
  readPathNodeVersion,
  refreshCliBin,
  resolveCliBinCached,
  withCliPath,
} from './detect';
import { EventBatcher } from './eventBatcher';
import { AcpConnection, innermostMessage } from './gemini/acp';
import { createGeminiMapper, permissionSummary, pickPermissionOption } from './gemini/geminiEvents';
import { GeminiUntrustedError, isGeminiUntrustedExit } from './gemini/trust';
import {
  type GeminiTrustResult,
  isBroadGeminiFolder,
  trustGeminiFolder,
} from './gemini/trustedFolders';
import { pickIdle, resolveIdleReclaimMs, sweepIntervalMs } from './idleReclaim';
import {
  effortsForModel,
  isValidModelId,
  isReasoningEffort,
  overrideArgs,
  sanitizeEffort,
  supportsModelOverride,
  type BackendModelCatalog,
  type CatalogModel,
} from './modelCatalog';
import { discoverModels } from './modelDiscovery';
import {
  DEFAULT_PERMISSION_MODE,
  claudeModeName,
  effectiveMode,
  acpModeId,
  fromCliPermissionMode,
  isPermissionMode,
  permissionLaunch,
  planPromptPrefix,
} from './permissionMode';
import { killProcessTree } from './processTree';
import { discoverSlash, expandSlash, gitDiff, type SlashBackend } from './slashDiscovery';
import {
  createClaudeParser,
  createDshParser,
  createGrokParser,
  parseCodexLine,
  parseUsage,
} from './streamParse';
import { foldAssistantEvent } from './textCursor';
import {
  MAX_TAB_FILE_BYTES,
  buildTrace,
  compactOldTraces,
  mergeUsage,
  stampEvent,
} from './traceBuilder';
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
} from './types';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

type CliBackend = Exclude<HarnessBackend, 'nomi'>;

/** 统一网关提供给编程助手的能力（主进程 GatewayService，§12） */
export interface HarnessGateway {
  /** 新标签默认来源与第三方时用的模型（clients.<cli>） */
  defaults(kind: CliBackend): { source: HarnessTabSource; model: string | null };
  /** 第三方会话的进程级注入；网关没在运行时返回 null */
  launch(
    kind: CliBackend,
    tabId: string,
    model: string,
  ): {
    env: Record<string, string>;
    args: string[];
    strip: readonly string[];
    modelInConfig?: boolean;
  } | null;
  /** 官方会话：剔除指向网关的残留变量 */
  officialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** 第三方可选模型 */
  models(): Array<{ ref: string; provider: string; label: string }>;
  /** 标签关闭后回收它的进程级私有目录 */
  releaseAgent(kind: CliBackend, tabId: string): void;
}

/** 一次启动的来源注入（见 launchFor） */
interface TabLaunch {
  env: Record<string, string>;
  args: string[];
  strip: readonly string[];
  official: boolean;
  modelInConfig: boolean;
  /** 长驻进程复用键的一部分 */
  sig: string;
}

const OFFICIAL_LAUNCH: TabLaunch = {
  env: {},
  args: [],
  strip: [],
  official: true,
  modelInConfig: false,
  sig: 'official',
};

/** 第三方来源在 modelScope / modelByScope 里的键 */
const GATEWAY_SCOPE = 'gateway';

export const MAIN_TAB_ID = 'main';
export const DEFAULT_MAX_CONCURRENT = 3;
const MAX_TAB_MESSAGES = 300;
/** Trailing debounce for session.json / tabs.json / tab message files */
const PERSIST_DEBOUNCE_MS = 200;
const MAX_RECENT_CWDS = 8;
/** 权限卡超时：与桌面能力一致，默认拒绝 */
const PERMISSION_TIMEOUT_MS = 120_000;
const CHAT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_ALIAS_FILE = 'image-aliases.json';

const BACKENDS: readonly HarnessBackend[] = ['nomi', 'claude', 'codex', 'dsh', 'grok', 'gemini'];

/** Gemini 一轮 5 分钟没有任何输出：多半卡在网络或上游，取消这一轮 */
const GEMINI_PROMPT_IDLE_MS = 5 * 60_000;
/** Claude control_request（如 set_permission_mode）等 control_response 的上限 */
const CLAUDE_CONTROL_TIMEOUT_MS = 10_000;
/** 停止后等中断那一轮 result 的宽限期；超过就拆进程（下一轮 --resume） */
const CLAUDE_INTERRUPT_GRACE_MS = 5_000;

function isBackend(v: unknown): v is HarnessBackend {
  return typeof v === 'string' && (BACKENDS as readonly string[]).includes(v);
}

/** Grok image_gen 返回本地图片路径；复制到 chat-asset 根目录后才能被渲染进程安全加载。 */
export function materializeGeneratedImages(
  rawOutput: string,
  home: string,
  chatRoot: string,
  aliases: Map<string, string>,
): void {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput);
  } catch {
    return;
  }
  const paths = new Set<string>();
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 6 || v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.path === 'string') paths.add(o.path);
    for (const key of ['content', 'rawOutput', 'output', 'result', 'data'])
      visit(o[key], depth + 1);
  };
  visit(value);
  if (!paths.size) return;
  const roots = [
    path.join(home, '.grok', 'sessions'),
    process.env.GROK_HOME ? path.join(process.env.GROK_HOME, 'sessions') : '',
  ]
    .filter(Boolean)
    .map((x) => {
      const resolved = path.resolve(x);
      // 候选路径会做 realpath；根目录也要 realpath，否则 HOME 经符号链接（macOS 的 /var → /private/var）时合法图片会被拒掉
      try {
        return fs.realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
  const destDir = path.join(chatRoot, 'images');
  let changed = false;
  for (const raw of paths) {
    const ext = path.extname(raw).toLowerCase();
    if (!CHAT_IMAGE_EXTS.has(ext)) continue;
    const normalized = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    const marker = normalized.lastIndexOf('/images/');
    const shortAlias = marker >= 0 ? normalized.slice(marker + 1) : normalized;
    // 仅按完整源路径复用；不同 session 都可能使用 images/1.jpg，不能跨 session 误绑定。
    const existing = aliases.get(normalized) ?? aliases.get(raw);
    if (existing && materializedImageExists(chatRoot, existing)) {
      aliases.set(normalized, existing);
      aliases.set(raw, existing);
      aliases.set(shortAlias, existing);
      continue;
    }
    const candidate = path.isAbsolute(raw)
      ? path.resolve(raw)
      : path.resolve(roots[0] ?? path.join(home, '.grok', 'sessions'), raw);
    let real: string;
    try {
      real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > MAX_GENERATED_IMAGE_BYTES) continue;
    } catch {
      continue;
    }
    if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) continue;
    const file = `grok-${randomUUID()}${ext}`;
    const dest = path.join(destDir, file);
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(real, dest);
    } catch {
      continue;
    }
    const url = `chat-asset://images/${file}`;
    aliases.set(normalized, url);
    aliases.set(raw, url);
    aliases.set(shortAlias, url);
    changed = true;
  }
  if (changed) persistImageAliases(chatRoot, aliases);
}

function materializedImageExists(chatRoot: string, url: string): boolean {
  const match = /^chat-asset:\/\/images\/([^/]+)$/.exec(url);
  if (!match) return false;
  const file = path.resolve(chatRoot, 'images', match[1]!);
  return file.startsWith(`${path.resolve(chatRoot, 'images')}${path.sep}`) && fs.existsSync(file);
}

function loadImageAliases(chatRoot: string): Map<string, string> {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(chatRoot, IMAGE_ALIAS_FILE), 'utf8'),
    ) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
    return new Map(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string' &&
          /^chat-asset:\/\/images\/[A-Za-z0-9._-]+$/.test(entry[1]),
      ),
    );
  } catch {
    return new Map();
  }
}

function persistImageAliases(chatRoot: string, aliases: Map<string, string>): void {
  try {
    fs.mkdirSync(chatRoot, { recursive: true });
    fs.writeFileSync(
      path.join(chatRoot, IMAGE_ALIAS_FILE),
      JSON.stringify(Object.fromEntries(aliases)),
      'utf8',
    );
  } catch {
    /* 图片已经复制成功；索引写入失败不影响当前轮显示。 */
  }
}

export function rewriteGeneratedImageLinks(text: string, aliases: Map<string, string>): string {
  if (!aliases.size || !text.includes('![')) return text;
  return text.replace(/(!\[[^\]]*\]\()([^\)]+)(\))/g, (full, before, rawUrl, after) => {
    const key = String(rawUrl).trim();
    let decoded = key;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      /* 保留原始 key；畸形百分号编码不应中断整轮输出。 */
    }
    const url = aliases.get(key) ?? aliases.get(decoded);
    return url ? `${before}${url}${after}` : full;
  });
}

const BACKEND_TITLE: Record<HarnessBackend, string> = {
  nomi: 'Nomi',
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
  gemini: 'Gemini',
};

function mockDir(): string {
  // packages/electron/scripts/mock-cli（开发）或随包 resources
  const candidates = [
    path.resolve(__dirname, '../../scripts/mock-cli'),
    path.resolve(__dirname, '../scripts/mock-cli'),
    path.resolve(process.cwd(), 'packages/electron/scripts/mock-cli'),
    path.resolve(process.cwd(), 'scripts/mock-cli'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'mock-claude.mjs'))) return c;
  }
  return candidates[0]!;
}

export function resolveHarnessBin(backend: CliBackend): string | null {
  if (process.env.NOMI_USE_MOCK_CLI === '1') {
    return path.join(mockDir(), `mock-${backend}.mjs`);
  }
  return resolveCliBinCached(backend);
}

/** 模型目录缓存时长：CLI 升级 / 官方目录更新后最迟这么久会重新读到 */
const MODEL_CATALOG_TTL_MS = 10 * 60_000;

const CLI_BACKENDS: readonly CliBackend[] = ['claude', 'codex', 'dsh', 'grok', 'gemini'];

/** 状态里展示用的可执行文件路径：只读缓存，绝不在这里 spawn（未缓存的由 refreshBins 异步补上） */
function peekHarnessBin(backend: CliBackend): string | null {
  if (process.env.NOMI_USE_MOCK_CLI === '1') return resolveHarnessBin(backend);
  return peekCliBin(backend) ?? null;
}

/** 标签结束一轮 / 出错时发给主进程订阅者（看板娘、灵动岛、监视器） */
export interface HarnessTabFinished {
  tabId: string;
  title: string;
  backend: HarnessBackend;
  ok: boolean;
  text: string;
  error?: string;
  /** 结束时该标签不在前台（需要提醒） */
  background: boolean;
}

type State = ReturnType<CliHarnessService['state']>;

export class CliHarnessService {
  private readonly tabs = new Map<string, HarnessTabMeta>();
  private readonly messages = new Map<string, HarnessTabMessage[]>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  /** tabId → 当前这一轮最近的输出 / 步骤（轻量进度提示，仅内存；供监视器定时汇总用） */
  private readonly progress = new Map<string, { kind: 'text' | 'tool'; value: string }>();
  /** 每个运行中标签这一轮已收到的文本 / 轨迹事件：中断或失败时据此保留已有进度 */
  private readonly partial = new Map<
    string,
    { text: string; breaks: number[]; events: HarnessEvent[] }
  >();
  /** 用户在排队 / 运行期间点了停止的标签 */
  private readonly stopRequested = new Set<string>();
  /**
   * 每次发送一个中止令牌（标签 → 这一轮）：从开始运行到这一轮真正发给 CLI 之间（Gemini 握手、
   * 等权限模式确认）点停止，靠它让晚到的握手 / 确认结果不再把这一轮发出去（#75）
   */
  private readonly sendAborts = new Map<string, AbortController>();
  /** 实时事件按帧合批后再广播（见 eventBatcher） */
  private readonly eventBatcher = new EventBatcher<HarnessEvent & { tabId: string }>((batch) =>
    this.broadcast('ai:harness:events', batch),
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
  private readonly waiters: Array<{
    tabId: string;
    resume: () => void;
    abort: (e: Error) => void;
  }> = [];
  private running = 0;
  private activeTabId = MAIN_TAB_ID;
  private maxConcurrent = DEFAULT_MAX_CONCURRENT;
  private defaultPermissionMode: HarnessPermissionMode = DEFAULT_PERMISSION_MODE;
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

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      home?: string;
      defaultCwd?: string;
      /**
       * 统一网关（docs/design/unified-gateway.md §12）：第三方标签的进程级注入、新标签默认来源、
       * 第三方可选模型、官方标签剔除网关残留变量。没有时只有官方来源。
       */
      gateway?: HarnessGateway;
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
    },
  ) {
    this.idleReclaimMs = resolveIdleReclaimMs(d.idleReclaimMs, process.env.NOMI_HARNESS_IDLE_MS);
    this.home = d.home ?? os.homedir();
    this.statePath = path.join(d.root, 'session.json');
    this.tabsPath = path.join(d.root, 'tabs.json');
    this.tabsDir = path.join(d.root, 'tabs');
    this.recentPath = path.join(d.root, 'recent-cwds.json');
    this.writer = new CoalescedWriter(PERSIST_DEBOUNCE_MS, (file, e) =>
      d.logger.warn('harness persist failed', { file: path.basename(file), e }),
    );
    // another instance on this root (restart in-process / tests) may still hold unwritten state
    flushPendingWritesSync(d.root);
    fs.mkdirSync(this.tabsDir, { recursive: true });
    const now = Date.now();
    this.tabs.set(MAIN_TAB_ID, {
      id: MAIN_TAB_ID,
      title: t('对话'),
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

  private rememberCwd(abs: string) {
    this.recent = [abs, ...this.recent.filter((p) => p !== abs)].slice(0, MAX_RECENT_CWDS);
    try {
      fs.writeFileSync(this.recentPath, JSON.stringify(this.recent), 'utf8');
    } catch (e) {
      this.d.logger.warn('harness recent cwd write failed', e);
    }
  }

  /** 原生文件夹选择器（不绑定到任何标签），取消返回 null */
  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const r = await dialog.showOpenDialog({
      title: t('选择编程助手工作目录'),
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  }

  // ───────────────────────── 持久化 ─────────────────────────

  private get main(): HarnessTabMeta {
    return this.tabs.get(MAIN_TAB_ID)!;
  }

  private load() {
    // 主标签的档位要等 tabs.json 里的默认档读完再还原
    let mainMode: unknown;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.statePath, 'utf8'),
      ) as Partial<HarnessSessionState> & {
        title?: string;
        permissionMode?: unknown;
        modelOverride?: unknown;
        reasoningEffort?: unknown;
      };
      const m = this.main;
      if (isBackend(raw.backend)) m.backend = raw.backend;
      if (typeof raw.cwd === 'string' && raw.cwd) m.cwd = raw.cwd;
      if (typeof raw.cliSessionId === 'string') m.cliSessionId = raw.cliSessionId;
      if (typeof raw.title === 'string' && raw.title.trim()) m.title = raw.title;
      mainMode = raw.permissionMode;
      this.restoreOverrides(m, raw);
    } catch {
      /* */
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.tabsPath, 'utf8')) as {
        activeTabId?: string;
        maxConcurrent?: number;
        defaultPermissionMode?: unknown;
        codexNetwork?: unknown;
        lastSettings?: Record<string, unknown>;
        tabs?: HarnessTabMeta[];
      };
      if (typeof raw.maxConcurrent === 'number') this.maxConcurrent = clampLimit(raw.maxConcurrent);
      if (isPermissionMode(raw.defaultPermissionMode) && raw.defaultPermissionMode !== 'bypass') {
        this.defaultPermissionMode = raw.defaultPermissionMode;
      }
      if (typeof raw.codexNetwork === 'boolean') this.codexNetwork = raw.codexNetwork;
      this.restoreLastSettings(raw.lastSettings);
      for (const tab of raw.tabs ?? []) {
        if (!tab || typeof tab.id !== 'string' || tab.id === MAIN_TAB_ID) continue;
        if (!isBackend(tab.backend) || tab.backend === 'nomi') continue;
        // 重启时中断的轮次回到空闲
        const restored: HarnessTabMeta = {
          ...tab,
          status: tab.status === 'error' ? 'error' : 'idle',
          unread: Number(tab.unread) || 0,
          permissionMode: this.restoredMode(tab.backend, tab.permissionMode),
        };
        this.restoreOverrides(restored, tab);
        this.tabs.set(tab.id, restored);
      }
      if (raw.activeTabId && this.tabs.has(raw.activeTabId)) this.activeTabId = raw.activeTabId;
    } catch {
      /* */
    }
    this.main.permissionMode = this.restoredMode(this.main.backend, mainMode);
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
    } = {
      backend: m.backend,
      cwd: m.cwd,
      cliSessionId: m.cliSessionId,
      busy: m.status === 'running' || m.status === 'queued',
      title: m.title,
      permissionMode: m.permissionMode,
      ...(m.modelOverride ? { modelOverride: m.modelOverride } : {}),
      ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}),
    };
    return s;
  }

  private tabsSnapshot() {
    return {
      activeTabId: this.activeTabId,
      maxConcurrent: this.maxConcurrent,
      defaultPermissionMode: this.defaultPermissionMode,
      codexNetwork: this.codexNetwork,
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
    this.post('ai:harness:tab-message', { tabId: id, message: msg });
  }

  // ───────────────────────── 旧接口（main 标签） ─────────────────────────

  state(): HarnessSessionState & { toolsDisabled: boolean; bins: Record<string, string | null> } {
    const m = this.main;
    return {
      backend: m.backend,
      cwd: m.cwd,
      cliSessionId: m.cliSessionId,
      busy: m.status === 'running' || m.status === 'queued',
      toolsDisabled: m.backend !== 'nomi',
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
      this.post('ai:harness:changed', this.state());
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
    if (!tab) throw new Error(t('标签不存在'));
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
      maxConcurrent: this.maxConcurrent,
      running: tabs.filter((x) => x.status === 'running').length,
      queued: tabs.filter((x) => x.status === 'queued').length,
      defaultPermissionMode: this.defaultPermissionMode,
      codexNetwork: this.codexNetwork,
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
    } = {},
  ): HarnessTabMeta {
    const backend = opts.backend ?? 'claude';
    if (!isBackend(backend) || backend === 'nomi') {
      throw new Error(t('新标签只能绑定编程助手后端'));
    }
    const cwd = opts.cwd ? validDir(opts.cwd) : this.tabs.get(this.activeTabId)!.cwd;
    if (opts.cwd) this.rememberCwd(cwd);
    const now = Date.now();
    const sameKind = [...this.tabs.values()].filter((x) => x.backend === backend).length;
    const tab: HarnessTabMeta = {
      id: randomUUID(),
      title:
        opts.title?.trim().slice(0, 60) ||
        (sameKind ? `${BACKEND_TITLE[backend]} ${sameKind + 1}` : BACKEND_TITLE[backend]),
      backend,
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
          : this.defaultPermissionMode,
      ).mode,
      ...(opts.permissionModeSource ? { permissionModeSource: opts.permissionModeSource } : {}),
    };
    // 新标签的来源：显式指定的，否则「模型」页给这个编程助手设的「新标签默认用」
    tab.source = this.defaultSource(backend, opts.source);
    this.inheritSettings(
      tab,
      isPermissionMode(opts.permissionMode) && opts.permissionMode !== 'bypass',
    );
    if (opts.modelOverride && isValidModelId(opts.modelOverride))
      tab.modelOverride = opts.modelOverride;
    if (opts.reasoningEffort && isReasoningEffort(opts.reasoningEffort))
      tab.reasoningEffort = opts.reasoningEffort;
    this.tabs.set(tab.id, tab);
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
    this.activeTabId = tab.id;
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
      // 不能作为第三方模型覆盖（否则按裸名解析可能歧义）；用网关给这个助手分配的默认模型。
      ...(o.source !== 'thirdParty' && o.modelOverride ? { modelOverride: o.modelOverride } : {}),
      reasoningEffort: o.reasoningEffort,
      permissionMode: o.permissionMode,
      permissionModeSource: o.permissionModeSource,
      ...(o.source ? { source: o.source } : {}),
    });
    return { tab, reused: false };
  }

  /** 用可见消息覆盖标签转录（分叉 / 导入）；不改 cliSessionId */
  seedTabMessages(id: string, messages: HarnessTabMessage[]): HarnessTabMeta {
    const tab = this.requireTab(id);
    if (id === MAIN_TAB_ID) throw new Error(t('主对话标签不能写入 CLI 转录'));
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
    if (id === MAIN_TAB_ID) throw new Error(t('主对话标签不能关闭'));
    const tab = this.requireTab(id);
    this.cancelTab(id);
    this.teardownClaudeLive(id);
    const order = [...this.tabs.keys()];
    const idx = order.indexOf(id);
    this.tabs.delete(id);
    this.messages.delete(id);
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
    if (tab.backend !== 'nomi') this.d.gateway?.releaseAgent(tab.backend, id);
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
    if (!next) throw new Error(t('标题不能为空'));
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
    if (!isBackend(backend)) throw new Error(t('未知后端'));
    if (backend === 'nomi' && id !== MAIN_TAB_ID) {
      throw new Error(t('新标签只能绑定编程助手后端'));
    }
    if (tab.status === 'running' || tab.status === 'queued') throw new Error(t('上一轮尚未结束'));
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
    if (!g || backend === 'nomi') return 'official';
    const d = g.defaults(backend as CliBackend);
    const source = want ?? d.source;
    return source === 'thirdParty' && (d.model || want) ? 'thirdParty' : 'official';
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
    if (tab.backend === 'nomi') throw new Error(t('Nomi 对话没有来源可选'));
    if (source !== 'official' && source !== 'thirdParty') throw new Error(t('未知来源'));
    if (source === 'thirdParty' && !this.d.gateway) throw new Error(t('模型网关不可用'));
    if (tab.status === 'running' || tab.status === 'queued')
      throw new Error(t('这一轮结束后再切换'));
    const ref = model?.trim() || '';
    if (ref && !isValidModelId(ref)) throw new Error(t('模型名不合法'));
    if (source === this.sourceOf(tab)) return ref ? this.setTabModel(id, ref) : { ...tab };
    if (
      source === 'thirdParty' &&
      !ref &&
      !this.d.gateway?.defaults(tab.backend as CliBackend).model
    )
      throw new Error(t('先在「模型」页给这个编程助手分配一个第三方模型'));
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
   * 否则清掉之前留下的前文，干净地开新会话。正在跑的轮次不受影响（在原目录跑完）。
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
    }
    tab.cwd = abs;
    if (tab.backend !== 'nomi') this.rememberCwd(abs);
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
    if (!isPermissionMode(mode)) throw new Error(t('未知权限模式'));
    if (mode === 'bypass' && !opts.confirmed) throw new Error(t('完全放开需要先确认'));
    const want = opts.expect;
    if (
      mode === 'bypass' &&
      want &&
      ((want.backend !== undefined && want.backend !== tab.backend) ||
        (want.cwd !== undefined && want.cwd !== tab.cwd))
    )
      throw new Error(t('标签的后端或工作目录已变化，请重新确认「完全放开」'));
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
            'Claude Code 没有确认权限模式切换（{0}），已停止当前进程，下一轮会按新模式重新启动',
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
    const change: ModeChange = { mode, done: Promise.resolve() };
    change.done = gl.conn
      .request('session/set_mode', { sessionId: gl.sessionId, modeId: acpModeId(gl.backend, mode) })
      .then(
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
              ? t('Grok 没有确认权限模式切换（{0}），已停止当前会话，下一轮会按新模式重新开始', why)
              : t(
                  'Gemini 没有确认权限模式切换（{0}），已停止当前会话，下一轮会按新模式重新开始',
                  why,
                ),
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
    if (opts.source === 'thirdParty' && backend !== 'nomi') return this.gatewayCatalog(backend);
    if (!supportsModelOverride(backend)) return null;
    const cached = this.modelCatalogs.get(backend);
    if (!opts.refresh && cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) {
      return cached.catalog;
    }
    const inflight = this.modelCatalogInflight.get(backend);
    if (inflight) return inflight;
    const run = discoverModels(backend, {
      spawn: (b, args) => {
        const bin = resolveHarnessBin(b);
        if (!bin) return null;
        const useNode = isScript(bin);
        // 官方来源的目录：从 CLI 自己读，不带任何第三方注入
        return spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...args] : args, {
          cwd: os.tmpdir(),
          env: this.childEnv(useNode, OFFICIAL_LAUNCH),
        });
      },
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
        // 失败结果不缓存，下次打开浮层再试
        if (catalog.error) this.modelCatalogs.delete(backend);
        else this.modelCatalogs.set(backend, { at: Date.now(), catalog });
        return catalog;
      })
      .finally(() => this.modelCatalogInflight.delete(backend));
    this.modelCatalogInflight.set(backend, run);
    return run;
  }

  /** 第三方来源的模型目录：网关里启用的模型（`供应商/模型`），默认 = 「模型」页给这个编程助手分配的 */
  private gatewayCatalog(backend: CliBackend): BackendModelCatalog {
    const g = this.d.gateway;
    const list = g?.models() ?? [];
    const def = g?.defaults(backend).model ?? null;
    const models: CatalogModel[] = list.map((m) => ({
      id: m.ref,
      label: `${m.provider} / ${m.label}`,
      reasoning: false,
      efforts: [],
    }));
    return {
      backend,
      models,
      defaultModel: (def && models.find((m) => m.id === def)) || null,
      provider: { id: GATEWAY_SCOPE, name: t('第三方模型') },
    };
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
  setTabModel(id: string, model: string): HarnessTabMeta {
    const tab = this.requireTab(id);
    const backend = tab.backend;
    if (!this.canOverride(tab)) throw new Error(t('这个编程助手不支持切换模型'));
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
    if (!isValidModelId(name)) throw new Error(t('模型名不合法'));
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
    if (!this.canOverride(tab)) throw new Error(t('这个编程助手不支持切换模型'));
    if (this.adoptScope(tab)) throw new Error(t('第三方供应商的模型不能在这里调思考深度'));
    if (!isReasoningEffort(effort)) throw new Error(t('未知思考深度'));
    const levels = effortsForModel(this.cachedCatalog(backend), tab.modelOverride);
    if (levels === null) throw new Error(t('这个模型不支持思考深度'));
    if (levels && !levels.includes(effort)) throw new Error(t('这个模型不支持该思考深度'));
    if (tab.reasoningEffort !== effort) {
      tab.reasoningEffort = effort;
      this.rememberSettings(tab);
      this.changed();
      this.recycleLiveForOverride(tab);
    }
    return { ...tab };
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
    return tab.backend !== 'nomi' && tab.source === 'thirdParty' && this.d.gateway
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
   * 本轮实际下发的模型 / 思考深度。只下发属于当前来源的选择（官方账号下选的模型名不发到网关，
   * 反之亦然）。第三方来源没选模型时用「模型」页给这个编程助手分配的模型；第三方不带思考深度。
   */
  private effectiveOverrides(tab: HarnessTabMeta): { model: string | null; effort: string | null } {
    const scope = this.scopeOf(tab);
    if (scope) {
      const own = (tab.modelScope ?? null) === scope ? tab.modelOverride?.trim() : '';
      return {
        model: own || this.d.gateway?.defaults(tab.backend as CliBackend).model || null,
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
    if (this.sourceOf(tab) === 'official')
      return {
        env: {},
        args: [],
        strip: [],
        official: true,
        modelInConfig: false,
        sig: 'official',
      };
    const model = this.effectiveOverrides(tab).model;
    if (!model) throw new Error(t('这个标签还没有选第三方模型，请先在「模型」页给它分配一个'));
    const l = this.d.gateway!.launch(tab.backend as CliBackend, tab.id, model);
    if (!l) throw new Error(t('模型网关没有运行，暂时不能使用第三方模型'));
    const modelInConfig = Boolean(l.modelInConfig);
    const stable = Object.fromEntries(
      Object.entries(l.env).filter(([k]) => modelInConfig || !/MODEL/.test(k)),
    );
    return {
      env: l.env,
      args: l.args,
      strip: l.strip,
      official: false,
      modelInConfig,
      sig: JSON.stringify(['thirdParty', stable, l.args, modelInConfig ? model : '']),
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
  }): HarnessTabsState {
    if (o.defaultPermissionMode !== undefined) {
      if (!isPermissionMode(o.defaultPermissionMode)) throw new Error(t('未知权限模式'));
      if (o.defaultPermissionMode === 'bypass') throw new Error(t('完全放开不能设为默认模式'));
      this.defaultPermissionMode = o.defaultPermissionMode;
      // 设置页改了默认档：新会话按新默认档开始，不再沿用之前标签上的选择
      for (const s of this.lastSettings.values()) delete s.permissionMode;
    }
    if (typeof o.codexNetwork === 'boolean') this.codexNetwork = o.codexNetwork;
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
          : this.defaultPermissionMode;
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
    if (!explicitMode && s.permissionMode)
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
      try {
        this.ensureClaudeLive(tab).prewarmed = true;
      } catch (e) {
        this.d.logger.warn('harness claude prewarm failed', e);
      }
    } else if (tab.backend === 'codex' && this.usesCodexApp() && !this.codexLive.has(id)) {
      this.ensureCodexLive(tab).catch((e: unknown) => {
        if (e instanceof AcpUnavailableError) this.codexAppUnavailable = true;
        this.d.logger.info('harness codex prewarm skipped', { error: String(e) });
      });
    } else if (
      (tab.backend === 'gemini' || (tab.backend === 'grok' && this.usesGrokAcp())) &&
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
    const r = await dialog.showOpenDialog({
      title: t('选择编程助手工作目录'),
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: tab.cwd,
    });
    if (r.canceled || !r.filePaths[0]) return { ...tab };
    return this.setTabCwd(id, r.filePaths[0]);
  }

  setMaxConcurrent(n: number): HarnessTabsState {
    this.maxConcurrent = clampLimit(n);
    this.pump();
    this.changed();
    return this.listTabs();
  }

  /**
   * 中止标签当前轮次。Claude 用户轮次只发 interrupt、进程保留（下一轮不用冷启动）；
   * CLI 没应答 / 这条消息还在它的队列里 / 宽限期内这一轮没结束时，才拆进程（下一轮 --resume）。
   */
  cancelTab(id: string): boolean {
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
        const i = this.waiters.findIndex((w) => w.tabId === id);
        if (i >= 0) this.waiters.splice(i, 1)[0]!.abort(new Error(t('已停止')));
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

  /** 发送一轮到指定标签；多个标签并发，超出上限排队 */
  async sendTab(id: string, prompt: string): Promise<HarnessSendResult> {
    const tab = this.requireTab(id);
    if (tab.backend === 'nomi') throw new Error(t('当前为 Nomi 后端，请走原生对话'));
    // 只有自发轮次在跑时允许发送：CLI 会排队处理，回显到达时再切换归属（§4）
    const autoOnly = tab.status === 'running' && this.isAutoOnly(id);
    if ((tab.status === 'running' && !autoOnly) || tab.status === 'queued')
      throw new Error(t('上一轮尚未结束'));
    const text = String(prompt ?? '').slice(0, 100_000);
    if (!text.trim()) throw new Error(t('消息为空'));
    const backend = tab.backend;
    // 模型来源（官方 / 第三方供应商）变了却还没收到通知：先对齐，不把别的来源的模型名发出去
    if ((tab.modelScope ?? null) !== this.scopeOf(tab)) {
      this.adoptScope(tab);
      this.changed();
    }
    this.appendMessage(id, {
      id: randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });
    tab.status = 'queued';
    tab.lastError = undefined;
    this.changed();
    try {
      await this.acquire(id);
    } catch (e) {
      // 排队时被用户停止
      this.stopRequested.delete(id);
      if (this.tabs.has(id)) {
        tab.status = 'idle';
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
    // 排队期间标签可能被关闭
    if (!this.tabs.has(id)) {
      this.release();
      throw new Error(t('标签已关闭'));
    }
    tab.status = 'running';
    const abort = new AbortController();
    this.sendAborts.set(id, abort);
    const startedAt = Date.now();
    this.partial.set(id, { text: '', breaks: [], events: [] });
    this.changed();
    const runCwd = tab.cwd;
    // 新会话的第一轮：把换目录 / 分叉时留下的前文放在用户消息前面一起发（界面上只显示用户原话）
    // 按这个 CLI 收消息的方式裁到预算内（命令行参数有长度上限，见 carriedBudget）
    const stored = tab.cliSessionId ? null : this.carriedText(id);
    const carried = stored ? fitCarried(stored, carriedBudget(backend, process.platform)) : null;
    const toCli = withCarriedContext(carried, text);
    try {
      const result =
        backend === 'claude'
          ? await this.runClaude(tab, toCli, abort.signal)
          : backend === 'dsh'
            ? await this.runDsh(tab, toCli)
            : backend === 'grok'
              ? await this.runGrokTurn(tab, toCli, abort.signal)
              : backend === 'gemini'
                ? await this.runAcp(tab, toCli, abort.signal)
                : await this.runCodexTurn(tab, toCli, abort.signal);
      if (result.sessionId && tab.backend === backend && tab.cwd === runCwd)
        tab.cliSessionId = result.sessionId;
      // 前文已经进了新会话：清掉，之后的轮次靠 CLI 自己续接
      if (stored) this.setCarried(tab, null);
      tab.status = this.claudeLive.get(id)?.auto ? 'running' : 'idle';
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
        ...(usage ? { usage } : {}),
        ...(tools.length ? { tools } : {}),
        ...(trace.length ? { trace } : {}),
        ...(result.textBreaks?.length ? { textBreaks: result.textBreaks } : {}),
      });
      this.finish(tab, true, result.text);
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
          tab.status = 'idle';
          this.appendMessage(id, {
            id: randomUUID(),
            role: 'assistant',
            content: part?.text ?? '',
            timestamp: Date.now(),
            durationMs,
            stopped: true,
            ...(trace.length ? { trace } : {}),
            ...(part?.breaks.length ? { textBreaks: part.breaks } : {}),
          });
          this.progress.delete(id);
          this.changed();
        } else {
          tab.status = 'error';
          tab.lastError = message;
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
            // Gemini 不信任这个文件夹：界面在错误卡片上提供「信任此文件夹」
            ...(e instanceof GeminiUntrustedError
              ? {
                  geminiTrust: {
                    folder: e.folder,
                    broad: isBroadGeminiFolder(e.folder, this.home, [this.d.defaultCwd ?? '']),
                  },
                }
              : {}),
            ...(trace.length ? { trace } : {}),
            ...(partText.trim() && part?.breaks.length ? { textBreaks: part.breaks } : {}),
          });
          this.finish(tab, false, '', message);
        }
      }
      throw e;
    } finally {
      if (this.sendAborts.get(id) === abort) this.sendAborts.delete(id);
      this.partial.delete(id);
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

  private finish(tab: HarnessTabMeta, ok: boolean, text: string, error?: string) {
    this.progress.delete(tab.id);
    const background = this.activeTabId !== tab.id || !anyWindowFocused();
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
  }

  // ───────────────────────── 并发控制 ─────────────────────────

  private acquire(tabId: string): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({
        tabId,
        resume: () => {
          this.running += 1;
          resolve();
        },
        abort: reject,
      });
    });
  }

  private release() {
    this.running = Math.max(0, this.running - 1);
    this.pump();
  }

  private pump() {
    while (this.running < this.maxConcurrent && this.waiters.length) this.waiters.shift()!.resume();
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
  ): Promise<HarnessSendResult> {
    // 刚切过权限模式、后端还没确认：先等结果。确认了就复用进程；失败时进程已拆，下面按标签档位
    // 重新拉起。不会把这一轮发进档位未确认的进程（#72）
    await this.claudeLive.get(tab.id)?.modeChange?.done.catch(() => undefined);
    await this.syncClaudeModel(tab);
    // 等待期间点了停止：不再拉起进程、不发送（#75）
    if (signal?.aborted) throw new Error(t('已中止'));
    const live = this.ensureClaudeLive(tab);
    return new Promise<HarnessSendResult>((resolve, reject) => {
      if (live.turn) {
        reject(new Error(t('上一轮尚未结束')));
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
      live.turnUuid = randomUUID();
      live.turnStarted = false;
      live.lastActivityAt = Date.now();
      this.children.set(tab.id, live.child);
      try {
        this.writeClaudeUser(live, prompt, live.turnUuid);
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

  private ensureClaudeLive(tab: HarnessTabMeta): ClaudeLiveSession {
    const existing = this.claudeLive.get(tab.id);
    const overrides = this.effectiveOverrides(tab);
    const launch = this.launchFor(tab);
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
        existing.reasoningEffort === overrides.effort) ||
        claudeBackgroundActive(existing)) &&
      !existing.child.killed &&
      existing.child.exitCode === null &&
      existing.child.signalCode === null
    ) {
      return existing;
    }
    if (existing) this.teardownClaudeLive(tab.id);

    const bin = resolveHarnessBin('claude');
    if (!bin) throw new Error(t('未找到 Claude Code（可设 NOMI_USE_MOCK_CLI=1）'));
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
    if (tab.cliSessionId) argv.push('--resume', tab.cliSessionId);
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      env: this.childEnv(useNode, launch),
    });
    const live: ClaudeLiveSession = {
      child,
      parseLine: createClaudeParser(),
      buf: '',
      turn: null,
      cwd: tab.cwd,
      permissionMode: tab.permissionMode,
      modeChange: null,
      controls: new Map(),
      modelOverride: overrides.model,
      reasoningEffort: overrides.effort,
      launchSig: launch.sig,
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

    child.stdout.on('data', (chunk: Buffer) => {
      live.buf += chunk.toString('utf8');
      const parts = live.buf.split(/\r?\n/);
      live.buf = parts.pop() ?? '';
      for (const line of parts) this.onClaudeLine(tab.id, live, line, true);
    });
    child.stderr.on('data', (c) => {
      this.d.logger.warn('harness claude stderr', String(c).slice(0, 500));
    });
    child.on('error', (e) => {
      const turn = live.turn;
      live.turn = null;
      this.children.delete(tab.id);
      this.claudeLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      this.failClaudeControls(live);
      turn?.reject(e);
    });
    child.on('close', (code, signal) => {
      if (live.buf.trim()) this.onClaudeLine(tab.id, live, live.buf, false);
      live.buf = '';
      const turn = live.turn;
      live.turn = null;
      this.children.delete(tab.id);
      this.claudeLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      this.failClaudeControls(live);
      if (!turn || turn.settled) return;
      turn.settled = true;
      if (signal && !turn.text) {
        turn.reject(new Error(t('已中止')));
        return;
      }
      if (code && code !== 0 && !turn.text) {
        turn.reject(new Error(turn.lastError ?? t('{0} 退出码 {1}', 'claude', code)));
        return;
      }
      turn.resolve({
        text: turn.text || t('（无文本输出）'),
        sessionId: turn.sessionId,
        events: turn.events,
      });
    });
    return live;
  }

  private writeClaudeUser(live: ClaudeLiveSession, prompt: string, uuid: string) {
    if (!live.child.stdin.writable) throw new Error(t('Claude 进程 stdin 不可写'));
    const payload = {
      type: 'user',
      uuid,
      message: { role: 'user', content: prompt },
    };
    live.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private writeClaudeControl(
    live: ClaudeLiveSession,
    request: Record<string, unknown>,
    requestId: string = randomUUID(),
  ) {
    if (!live.child.stdin.writable) return false;
    const payload = {
      type: 'control_request',
      request_id: requestId,
      request,
    };
    try {
      live.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** 发 control_request 并等同 request_id 的 control_response；负确认 / 超时 / 写不进去都会 reject */
  private requestClaudeControl(
    live: ClaudeLiveSession,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        live.controls.delete(requestId);
        reject(new Error(t('超时')));
      }, this.d.claudeControlTimeoutMs ?? CLAUDE_CONTROL_TIMEOUT_MS);
      live.controls.set(requestId, { resolve, reject, timer });
      if (!this.writeClaudeControl(live, request, requestId)) {
        clearTimeout(timer);
        live.controls.delete(requestId);
        reject(new Error(t('Claude 进程 stdin 不可写')));
      }
    });
  }

  /** 进程结束 / 拆除：在途的 control_request 一律失败，不留挂起的计时器 */
  private failClaudeControls(live: ClaudeLiveSession) {
    for (const w of live.controls.values()) {
      clearTimeout(w.timer);
      w.reject(new Error(t('进程已结束')));
    }
    live.controls.clear();
  }

  /** CLI 对我们 control_request 的应答（按 request_id 交给等待者；不认识的 id 直接忽略） */
  private onClaudeControlResponse(live: ClaudeLiveSession, j: Record<string, unknown>) {
    const r = (j.response ?? {}) as Record<string, unknown>;
    const requestId = typeof r.request_id === 'string' ? r.request_id : '';
    const w = live.controls.get(requestId);
    if (!w) return;
    live.controls.delete(requestId);
    clearTimeout(w.timer);
    if (r.subtype === 'success') w.resolve((r.response ?? {}) as Record<string, unknown>);
    else
      w.reject(new Error(typeof r.error === 'string' && r.error ? r.error : t('后端拒绝了请求')));
  }

  private onClaudeLine(tabId: string, live: ClaudeLiveSession, line: string, liveEmit: boolean) {
    live.lastActivityAt = Date.now();
    if (this.onClaudeMeta(tabId, live, line)) return;
    // 回显到达前（或老 CLI 不回显时）的归属：见 ClaudeLiveSession.turnUuid
    const userTurn = live.turn && (live.turnStarted || !live.replaySeen) ? live.turn : null;
    let turn: ClaudeTurnWaiter | null = userTurn ?? live.auto;
    let dropAfter = false;
    for (const raw of live.parseLine(line)) {
      let ev = withPermissionExpiry(stampEvent(raw));
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
      if (liveEmit) this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        this.allowIfBypass(tabId, ev.id, () =>
          this.events.emit('permission-needed', {
            tabId,
            title: tab?.title ?? 'Claude Code',
            backend: 'claude' as HarnessBackend,
            summary: ev.agent ? t('子代理「{0}」：{1}', ev.agent, ev.summary) : ev.summary,
            background: this.activeTabId !== tabId || !anyWindowFocused(),
          }),
        );
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
            text: turn.text || t('（无文本输出）'),
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
      !existing.conn.isClosed
    ) {
      await existing.ready;
      return this.confirmAcpMode(tab, existing);
    }
    if (existing) this.teardownAcpLive(tab.id);
    const backend: AcpBackend = tab.backend === 'grok' ? 'grok' : 'gemini';
    const bin = resolveHarnessBin(backend);
    if (!bin)
      throw new Error(
        backend === 'grok'
          ? t('未找到 Grok（可设 NOMI_USE_MOCK_CLI=1）')
          : t('未找到 Gemini CLI（可设 NOMI_USE_MOCK_CLI=1）'),
      );
    const useNode = isScript(bin);
    const argv = backend === 'grok' ? ['agent', 'stdio'] : ['--acp'];
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      // 不设 GEMINI_CLI_TRUST_WORKSPACE：信任与否交给 Gemini 自己的受信任文件夹（见 gemini/trust.ts）
      // 第三方：Grok 用私有 GROK_HOME、Gemini 用环境变量指向网关；官方剔除网关残留
      env: this.childEnv(useNode, launch),
    });
    let stderrTail = '';
    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + String(c)).slice(-4000);
      this.d.logger.warn(`harness ${backend} stderr`, String(c).slice(0, 500));
    });
    const live: AcpLiveSession = {
      backend,
      model: null,
      effort: null,
      launchSig: launch.sig,
      child,
      conn: null as unknown as AcpConnection,
      sessionId: null,
      cwd: tab.cwd,
      permissionMode: tab.permissionMode,
      turn: null,
      perms: new Map(),
      lastActivityAt: Date.now(),
      ready: Promise.resolve(),
      modeChange: null,
    };
    live.conn = new AcpConnection(child, {
      onNotification: (method, params) => {
        if (method !== 'session/update') return;
        live.lastActivityAt = Date.now();
        const u = (params.update ?? {}) as Record<string, unknown>;
        if (live.turn) this.onAcpEvents(tab.id, live, live.turn.mapper.update(u));
      },
      onRequest: async (method, params) => {
        if (method !== 'session/request_permission')
          throw new Error(`unsupported client method ${method}`);
        const id = `gemini-perm-${randomUUID()}`;
        const allowed = await new Promise<boolean | null>((resolve) => {
          live.perms.set(id, (allow) => {
            live.perms.delete(id);
            resolve(allow);
          });
          const ev = withPermissionExpiry({
            type: 'permission',
            id,
            summary: permissionSummary(params),
          });
          this.onAcpEvents(tab.id, live, [ev]);
        });
        // Grok 拒绝一次调用会以 cancelled 结束整轮：记下来，不当成用户停止（见 runAcp）
        if (allowed === false && live.turn) live.turn.denied = true;
        const optionId = allowed === null ? null : pickPermissionOption(params.options, allowed);
        return optionId
          ? { outcome: { outcome: 'selected', optionId } }
          : { outcome: { outcome: 'cancelled' } };
      },
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
      await live.conn.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        },
        opts,
      );
      type SessionResult = { sessionId?: string; modes?: { currentModeId?: unknown } } | null;
      let sid: string | null = null;
      let modeNow: unknown;
      if (tab.cliSessionId) {
        sid = await live.conn
          .request<SessionResult>(
            'session/load',
            { sessionId: tab.cliSessionId, cwd: tab.cwd, mcpServers: [] },
            opts,
          )
          .then((r) => {
            modeNow = r?.modes?.currentModeId;
            return tab.cliSessionId;
          })
          .catch(() => null);
      }
      if (!sid) {
        const r = await live.conn.request<SessionResult>(
          'session/new',
          { cwd: tab.cwd, mcpServers: [] },
          opts,
        );
        sid = r?.sessionId ?? null;
        modeNow = r?.modes?.currentModeId;
      }
      if (!sid)
        throw new Error(backend === 'grok' ? t('Grok 没有返回会话') : t('Gemini 没有返回会话'));
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
      const want = acpModeId(backend, initMode);
      if (!adoptedHistoryMode && modeNow !== want)
        await live.conn
          .request('session/set_mode', { sessionId: sid, modeId: want }, opts)
          .catch((e: unknown) => {
            const why = innermostMessage(e instanceof Error ? e.message : String(e));
            throw new Error(
              backend === 'grok'
                ? t('Grok 没有确认权限模式（{0}），这条消息没有发送', why)
                : t('Gemini 没有确认权限模式（{0}），这条消息没有发送', why),
              { cause: e },
            );
          });
      live.permissionMode = initMode;
    })();
    try {
      await live.ready;
    } catch (e) {
      this.teardownAcpLive(tab.id);
      if (signal?.aborted) throw new Error(t('已中止'), { cause: e });
      // Grok 握手阶段就退出 / 不认识 ACP：交给 sendTab 退回 `grok -p`
      if (backend === 'grok' && e instanceof Error && e.message === 'ACP process exited')
        throw new AcpUnavailableError(t('Grok 没能启动 ACP 会话'), { cause: e });
      // 工作区未受信任：headless 的 ACP 弹不出 Gemini 的信任对话框，以 55 退出
      if (
        e instanceof Error &&
        e.message === 'ACP process exited' &&
        isGeminiUntrustedExit(child.exitCode, stderrTail)
      )
        throw new GeminiUntrustedError(tab.cwd, { cause: e });
      // 进程在握手阶段就退出：多半是旧版 Gemini CLI，还不认识 --acp
      if (e instanceof Error && e.message === 'ACP process exited')
        throw new Error(
          t('Gemini CLI 没能启动 ACP 会话，可能版本过旧。请在「编程助手 → Gemini」里更新后再试。'),
          { cause: e },
        );
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
    throw failure instanceof Error ? failure : new Error(t('Gemini 会话已结束，这条消息没有发送'));
  }

  private onAcpEvents(tabId: string, live: AcpLiveSession, evs: HarnessEvent[]) {
    for (const raw of evs) {
      let ev = withPermissionExpiry(stampEvent(raw));
      const turn = live.turn;
      if (turn) {
        const folded = foldAssistantEvent(turn.text, turn.breaks, ev);
        turn.text = folded.text;
        turn.breaks = folded.breaks;
        ev = folded.ev;
        if (ev.type !== 'text-delta') turn.events.push(ev);
      }
      this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        this.allowIfBypass(tabId, ev.id, () =>
          this.events.emit('permission-needed', {
            tabId,
            title: tab?.title ?? (live.backend === 'grok' ? 'Grok' : 'Gemini'),
            backend: live.backend as HarnessBackend,
            summary: ev.summary,
            background: this.activeTabId !== tabId || !anyWindowFocused(),
          }),
        );
      }
    }
  }

  private async runAcp(
    tab: HarnessTabMeta,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<HarnessSendResult> {
    let live = await this.ensureAcpLive(tab, signal);
    if (!(await this.syncAcpOverrides(tab, live))) {
      // 清掉了覆盖、又不知道 CLI 的默认值：换新进程（session/load 接上会话），按默认参数开始
      this.teardownAcpLive(tab.id);
      live = await this.ensureAcpLive(tab, signal);
    }
    // 握手 / 模式确认期间点了停止：即使握手随后成功，也不再发送这一轮（#75）
    if (signal?.aborted) throw new Error(t('已中止'));
    if (live.turn) throw new Error(t('上一轮尚未结束'));
    const turn: AcpTurn = { mapper: createGeminiMapper(), events: [], text: '', breaks: [] };
    live.turn = turn;
    live.used = true;
    live.lastActivityAt = Date.now();
    try {
      const r = await live.conn.request<{
        stopReason?: string;
        _meta?: {
          quota?: { token_count?: { input_tokens?: number; output_tokens?: number } };
          /** Grok：整轮累计（inputTokens / outputTokens / cachedReadTokens） */
          usage?: unknown;
        };
      }>(
        'session/prompt',
        { sessionId: live.sessionId, prompt: [{ type: 'text', text: prompt }] },
        {
          // 一直有输出就不算超时；等用户确认权限时也不计时（权限另有自己的超时）
          idle: true,
          timeoutMs: this.d.geminiPromptIdleMs ?? GEMINI_PROMPT_IDLE_MS,
          onTimeout: () => {
            this.cancelAcpTurn(live);
            // 卡住的进程不再复用：这一轮结束后回收，下一轮重新拉起（session/load 接上会话）
            live.recycleAfterTurn = true;
          },
        },
      );
      this.onAcpEvents(tab.id, live, turn.mapper.flush());
      // 用户拒绝了一次工具调用、Grok 随之结束这一轮：不是「已中止」，按正常结束落盘
      if (r?.stopReason === 'cancelled' && !(turn.denied && !this.stopRequested.has(tab.id)))
        throw new Error(t('已中止'));
      if (r?.stopReason === 'cancelled' && !turn.text.trim())
        turn.text = t('已拒绝这次工具调用，这一轮已结束');
      const tc = r?._meta?.quota?.token_count;
      const usage =
        tc && (tc.input_tokens !== undefined || tc.output_tokens !== undefined)
          ? {
              ...(tc.input_tokens !== undefined ? { inputTokens: tc.input_tokens } : {}),
              ...(tc.output_tokens !== undefined ? { outputTokens: tc.output_tokens } : {}),
            }
          : parseUsage(r?._meta?.usage, {});
      const done: HarnessEvent = {
        type: 'done',
        text: turn.text,
        sessionId: live.sessionId ?? undefined,
        ...(usage ? { usage } : {}),
      };
      turn.events.push(done);
      this.emitEvent(tab.id, done);
      return {
        text: turn.text || t('（无文本输出）'),
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
          'Grok 没有切换{0}（{1}）',
          what,
          innermostMessage(e instanceof Error ? e.message : String(e)),
        ),
        { cause: e },
      );
    };
    if (live.model !== want.model) {
      const modelId = want.model ?? catalog?.defaultModel?.id;
      if (!modelId) return false;
      await live.conn
        .request('session/set_model', { sessionId: live.sessionId, modelId })
        .catch(fail(t('模型')));
      live.model = want.model;
      // 换模型后 CLI 会换成那个模型的默认档位：思考深度覆盖要重新下发
      live.effort = null;
    }
    if (live.effort !== want.effort) {
      const modelId = want.model ?? catalog?.defaultModel?.id;
      const value =
        want.effort ?? catalog?.models.find((m) => m.id === modelId)?.defaultEffort ?? null;
      if (!value) return want.effort === null;
      await live.conn
        .request('session/set_config_option', {
          sessionId: live.sessionId,
          configId: 'reasoning_effort',
          value,
        })
        .catch(fail(t('思考深度')));
      live.effort = want.effort;
    }
    return true;
  }

  private cancelAcpTurn(live: AcpLiveSession) {
    if (live.sessionId) live.conn.notify('session/cancel', { sessionId: live.sessionId });
    // 规范要求：取消时挂起的权限请求按 cancelled 应答
    for (const done of [...live.perms.values()]) done(null);
  }

  private teardownAcpLive(tabId: string) {
    const live = this.acpLive.get(tabId);
    if (!live) return;
    this.acpLive.delete(tabId);
    for (const done of [...live.perms.values()]) done(null);
    try {
      if (live.child.stdin.writable) live.child.stdin.end();
    } catch {
      /* */
    }
    try {
      if (!live.child.killed && live.child.exitCode === null) killProcessTree(live.child);
    } catch {
      /* */
    }
  }

  /**
   * 不产生界面事件的协议行：用户消息回显（轮次开始标记）与后台任务生命周期。返回 true 表示已处理完。
   */
  private onClaudeMeta(tabId: string, live: ClaudeLiveSession, line: string): boolean {
    if (line.includes('"control_response"')) {
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (j.type === 'control_response') {
          this.onClaudeControlResponse(live, j);
          return true;
        }
      } catch {
        /* 不是完整 JSON：交给解析器 */
      }
    }
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
    if (auto.sessionId && tab.backend === 'claude') tab.cliSessionId = auto.sessionId;
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
      ...(error ? { error: true as const } : {}),
      ...(stopped ? { stopped: true as const } : {}),
      ...(usage ? { usage } : {}),
      ...(trace.length ? { trace } : {}),
      ...(auto.breaks.length ? { textBreaks: auto.breaks } : {}),
    };
    if (tabId === MAIN_TAB_ID) {
      // 主标签的消息由渲染层存进 Nomi 历史：广播出去由它落盘
      tab.updatedAt = msg.timestamp;
      this.post('ai:harness:tab-message', { tabId, message: msg });
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
    if (this.claudeLive.size) this.startIdleSweep();
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
  recycleBackend(kind: HarnessBackend): void {
    // 换了账号：官方可选模型跟着变，下次打开浮层重新从 CLI 读
    this.modelCatalogs.delete(kind);
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
      return !tab || this.sourceOf(tab) === 'official';
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
    this.failClaudeControls(live);
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
    try {
      if (child.stdin.writable) child.stdin.end();
    } catch {
      /* */
    }
    try {
      if (!child.killed && child.exitCode === null) {
        killProcessTree(child);
      }
    } catch {
      /* */
    }
    if (turn && !turn.settled) {
      turn.settled = true;
      turn.reject(new Error(t('已中止')));
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
  ): Promise<HarnessSendResult> {
    if (this.usesCodexApp()) {
      try {
        return await this.runCodexLive(tab, prompt, signal);
      } catch (e) {
        if (!(e instanceof AcpUnavailableError) || signal.aborted) throw e;
        this.codexAppUnavailable = true;
        this.d.logger.warn('harness codex app-server unavailable, falling back to codex exec', e);
      }
    }
    return this.runCodex(tab, prompt);
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
      !existing.conn.isClosed
    ) {
      await existing.ready;
      return existing;
    }
    if (existing) this.teardownCodexLive(tab.id);
    const bin = resolveHarnessBin('codex');
    if (!bin) throw new Error(t('未找到 Codex（可设 NOMI_USE_MOCK_CLI=1）'));
    const useNode = isScript(bin);
    // 第三方：-c 指向网关（模型按轮下发，见 runCodexLive）
    const argv = ['app-server', ...launch.args];
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      env: this.childEnv(useNode, launch),
    });
    child.stderr.on('data', (c) => {
      this.d.logger.warn('harness codex stderr', String(c).slice(0, 500));
    });
    const live: CodexLiveSession = {
      child,
      conn: null as unknown as AcpConnection,
      threadId: null,
      cwd: tab.cwd,
      model: null,
      effort: null,
      launchSig: launch.sig,
      turn: null,
      perms: new Map(),
      totals: null,
      lastActivityAt: Date.now(),
      ready: Promise.resolve(),
    };
    live.conn = new AcpConnection(child, {
      onNotification: (method, params) => this.onCodexNotification(tab.id, live, method, params),
      onRequest: async (method, params) => {
        if (
          method !== 'item/commandExecution/requestApproval' &&
          method !== 'item/fileChange/requestApproval'
        )
          throw new Error(`unsupported client method ${method}`);
        const id = `codex-perm-${randomUUID()}`;
        const allowed = await new Promise<boolean | null>((resolve) => {
          live.perms.set(id, (allow) => {
            live.perms.delete(id);
            resolve(allow);
          });
          this.onCodexEvents(tab.id, live, [
            withPermissionExpiry({
              type: 'permission',
              id,
              summary: codexApprovalSummary(method, params),
            }),
          ]);
        });
        return { decision: allowed === null ? 'cancel' : allowed ? 'accept' : 'decline' };
      },
    });
    child.on('close', () => {
      if (this.codexLive.get(tab.id) === live) this.codexLive.delete(tab.id);
      this.clearPermissionTimeouts(tab.id);
      for (const done of live.perms.values()) done(null);
      const turn = live.turn;
      live.turn = null;
      if (turn && !turn.settled) {
        turn.settled = true;
        turn.reject(new Error(turn.lastError ?? t('Codex 进程已退出')));
      }
    });
    this.codexLive.set(tab.id, live);
    this.dormant.delete(tab.id);
    this.startIdleSweep();
    const opts = signal ? { signal } : {};
    live.ready = (async () => {
      await live.conn.request(
        'initialize',
        { clientInfo: { name: 'nomi', title: 'Nomi', version: '1' }, capabilities: null },
        opts,
      );
      live.conn.notify('initialized', {});
      if (tab.cliSessionId) {
        const r = await live.conn.request<{ thread?: { id?: string } } | null>(
          'thread/resume',
          { threadId: tab.cliSessionId, cwd: tab.cwd },
          opts,
        );
        live.threadId = r?.thread?.id ?? tab.cliSessionId;
      }
    })();
    try {
      await live.ready;
    } catch (e) {
      this.teardownCodexLive(tab.id);
      if (signal?.aborted) throw new Error(t('已中止'), { cause: e });
      if (e instanceof Error && e.message === 'ACP process exited')
        throw new AcpUnavailableError(t('Codex 没能启动 app-server'), { cause: e });
      throw new Error(innermostMessage(e instanceof Error ? e.message : String(e)), { cause: e });
    }
    return live;
  }

  private async runCodexLive(
    tab: HarnessTabMeta,
    prompt: string,
    signal: AbortSignal,
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
    if (signal.aborted) throw new Error(t('已中止'));
    if (live.turn) throw new Error(t('上一轮尚未结束'));
    if (!live.threadId) {
      const r = await live.conn.request<{ thread?: { id?: string } } | null>('thread/start', {
        cwd: tab.cwd,
      });
      live.threadId = r?.thread?.id ?? null;
      if (!live.threadId) throw new Error(t('Codex 没有返回会话'));
    }
    if (signal.aborted) throw new Error(t('已中止'));
    const text = (tab.permissionMode === 'plan' ? planPromptPrefix('codex') : '') + prompt;
    const chatRoot = path.join(path.dirname(this.d.root), 'chat');
    live.used = true;
    live.lastActivityAt = Date.now();
    return new Promise<HarnessSendResult>((resolve, reject) => {
      const turn: CodexTurn = {
        id: null,
        events: [],
        text: '',
        breaks: [],
        lastItem: null,
        totalsBefore: live.totals,
        lastError: null,
        settled: false,
        resolve,
        reject,
        chatRoot,
        imageAliases: loadImageAliases(chatRoot),
      };
      live.turn = turn;
      live.conn
        .request<{ turn?: { id?: string } } | null>('turn/start', {
          threadId: live.threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          cwd: tab.cwd,
          ...codexTurnPolicy(tab.permissionMode, { network: this.codexNetwork }),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        })
        .then(
          (r) => {
            turn.id = r?.turn?.id ?? null;
            live.model = want.model;
            live.effort = want.effort;
          },
          (e: unknown) => {
            if (live.turn === turn) live.turn = null;
            if (turn.settled) return;
            turn.settled = true;
            reject(new Error(innermostMessage(e instanceof Error ? e.message : String(e))));
          },
        );
    });
  }

  /** app-server 推送 → 这一轮的事件。只认主线程（子代理线程的条目另有 collab 事件概括） */
  private onCodexNotification(
    tabId: string,
    live: CodexLiveSession,
    method: string,
    params: Record<string, unknown>,
  ) {
    live.lastActivityAt = Date.now();
    if (method === 'thread/tokenUsage/updated' && params.threadId === live.threadId) {
      live.totals = codexTokenTotals(params.tokenUsage) ?? live.totals;
      return;
    }
    const turn = live.turn;
    if (!turn || (params.threadId !== undefined && params.threadId !== live.threadId)) return;
    if (method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : null;
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const evs: HarnessEvent[] = [];
      // 同一轮里的下一条消息：补段落分隔，避免两段流式文本粘在一起
      if (itemId !== turn.lastItem && turn.text.trim())
        evs.push({ type: 'text-delta', text: '\n\n' });
      turn.lastItem = itemId;
      if (delta) evs.push({ type: 'text-delta', text: delta });
      this.onCodexEvents(tabId, live, evs);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = codexExecItem((params.item ?? {}) as Record<string, unknown>);
      if (!item) return;
      const line = JSON.stringify({
        type: method === 'item/started' ? 'item.started' : 'item.completed',
        item,
      });
      // exec 的 agent_message 完成时附带一个 done：这里的整轮结束由 turn/completed 决定，去掉它
      const evs = parseCodexLine(line).filter((e) => e.type !== 'done');
      this.onCodexEvents(tabId, live, evs);
      return;
    }
    if (method === 'error') {
      const err = (params.error ?? {}) as { message?: unknown };
      const message = typeof err.message === 'string' ? err.message : t('Codex 错误');
      if (params.willRetry === true)
        this.onCodexEvents(tabId, live, [{ type: 'status', kind: 'reconnect', text: message }]);
      else turn.lastError = message;
      return;
    }
    if (method === 'turn/completed') {
      const done = (params.turn ?? {}) as { id?: unknown; status?: unknown; error?: unknown };
      if (turn.id && done.id !== turn.id) return;
      this.finishCodexTurn(tabId, live, turn, done);
    }
  }

  private onCodexEvents(tabId: string, live: CodexLiveSession, evs: HarnessEvent[]) {
    const turn = live.turn;
    for (const raw of evs) {
      let ev = withPermissionExpiry(stampEvent(raw));
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
      this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        this.allowIfBypass(tabId, ev.id, () =>
          this.events.emit('permission-needed', {
            tabId,
            title: tab?.title ?? 'Codex',
            backend: 'codex' as HarnessBackend,
            summary: ev.summary,
            background: this.activeTabId !== tabId || !anyWindowFocused(),
          }),
        );
      }
    }
  }

  private finishCodexTurn(
    tabId: string,
    live: CodexLiveSession,
    turn: CodexTurn,
    done: { status?: unknown; error?: unknown },
  ) {
    if (live.turn === turn) live.turn = null;
    live.lastActivityAt = Date.now();
    this.clearPermissionTimeouts(tabId);
    for (const fin of [...live.perms.values()]) fin(null);
    if (turn.settled) return;
    turn.settled = true;
    if (done.status === 'interrupted') turn.reject(new Error(t('已中止')));
    else if (done.status === 'failed') {
      const err = done.error as { message?: unknown } | null;
      turn.reject(
        new Error(
          (typeof err?.message === 'string' && err.message) || turn.lastError || t('Codex 错误'),
        ),
      );
    } else {
      const usage = codexTurnUsage(turn.totalsBefore, live.totals);
      const ev: HarnessEvent = {
        type: 'done',
        text: turn.text,
        sessionId: live.threadId ?? undefined,
        ...(usage ? { usage } : {}),
      };
      turn.events.push(ev);
      this.emitEvent(tabId, ev);
      turn.resolve({
        text: rewriteGeneratedImageLinks(turn.text, turn.imageAliases) || t('（无文本输出）'),
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
    const send = () => {
      if (turn.settled || this.codexLive.get(id) !== live || live.turn !== turn) return;
      if (!turn.id || !live.threadId) return;
      live.conn
        .request('turn/interrupt', { threadId: live.threadId, turnId: turn.id })
        .catch(fallback);
    };
    if (turn.id && live.threadId) {
      send();
      return;
    }
    const poll = setInterval(() => {
      if (turn.settled || this.codexLive.get(id) !== live || live.turn !== turn) {
        clearInterval(poll);
        return;
      }
      if (turn.id && live.threadId) {
        clearInterval(poll);
        send();
      }
    }, 20);
    poll.unref?.();
  }

  private teardownCodexLive(tabId: string) {
    const live = this.codexLive.get(tabId);
    if (!live) return;
    this.codexLive.delete(tabId);
    for (const done of [...live.perms.values()]) done(null);
    this.clearPermissionTimeouts(tabId);
    const turn = live.turn;
    live.turn = null;
    try {
      if (live.child.stdin.writable) live.child.stdin.end();
    } catch {
      /* */
    }
    try {
      if (!live.child.killed && live.child.exitCode === null) killProcessTree(live.child);
    } catch {
      /* */
    }
    if (turn && !turn.settled) {
      turn.settled = true;
      turn.reject(new Error(t('已中止')));
    }
  }

  private runCodex(tab: HarnessTabMeta, prompt: string): Promise<HarnessSendResult> {
    const bin = resolveHarnessBin('codex');
    if (!bin) return Promise.reject(new Error(t('未找到 Codex（可设 NOMI_USE_MOCK_CLI=1）')));
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
    const argv = tab.cliSessionId
      ? [
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          ...sandbox,
          ...modelArgs,
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
    if (!bin) return Promise.reject(new Error(t('未找到 dsh（可设 NOMI_USE_MOCK_CLI=1）')));
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
  ): Promise<HarnessSendResult> {
    if (this.d.grokAcp && !this.grokAcpUnavailable) {
      try {
        return await this.runAcp(tab, prompt, signal);
      } catch (e) {
        if (!(e instanceof AcpUnavailableError) || signal.aborted) throw e;
        this.grokAcpUnavailable = true;
        this.d.logger.warn('harness grok ACP unavailable, falling back to grok -p', e);
      }
    }
    return this.runGrok(tab, prompt);
  }

  /**
   * Grok Build 无头模式：`grok -p <prompt> --output-format streaming-json --no-auto-update`，
   * 权限按标签模式加 `--permission-mode <mode>`（完全放开为 `--yolo`）。
   * 续接：`--resume <sessionId>`。无头权限事件格式未在真机验证，暂不开放「逐项确认」。
   * 官方：docs.x.ai/build/cli/headless-scripting 。
   */
  private runGrok(tab: HarnessTabMeta, prompt: string): Promise<HarnessSendResult> {
    const bin = resolveHarnessBin('grok');
    if (!bin) return Promise.reject(new Error(t('未找到 Grok（可设 NOMI_USE_MOCK_CLI=1）')));
    const useNode = isScript(bin);
    let launch: TabLaunch;
    try {
      launch = this.launchFor(tab);
    } catch (e) {
      return Promise.reject(e);
    }
    const argv = [
      '-p',
      prompt.startsWith('-') ? ` ${prompt}` : prompt,
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

  private spawnCollect(
    tab: HarnessTabMeta,
    opts: {
      cmd: string;
      argv: string[];
      parseLine: (line: string) => HarnessEvent[];
      kind: CliBackend;
      env?: Record<string, string>;
      /** 来源注入（第三方：网关；官方：剔除网关残留）；缺省按官方 */
      launch?: TabLaunch;
      /** 通过 process.execPath 跑 .mjs/.js 时为 true（需 ELECTRON_RUN_AS_NODE） */
      asNode?: boolean;
      /** 仅特殊 mock 需要保持 stdin；Codex/dsh 必须立刻 EOF。Claude 走 ensureClaudeLive */
      keepStdin?: boolean;
    },
  ): Promise<HarnessSendResult> {
    return new Promise((resolve, reject) => {
      const events: HarnessEvent[] = [];
      let text = '';
      let breaks: number[] = [];
      let sessionId: string | null = tab.cliSessionId;
      let buf = '';
      let lastError: string | null = null;
      /**
       * 见过「整轮完成」事件。done 事件在各 CLI 里含义不同（Codex 每条 agent_message 都带 done、
       * 会话 id 也走 done），所以只认：带用量的 done（Codex turn.completed / Grok usage）
       * 和 dsh 的 final（done 且不带会话 id）。
       */
      let completed = false;
      const chatRoot = path.join(path.dirname(this.d.root), 'chat');
      const imageAliases = loadImageAliases(chatRoot);
      const child = spawnHarness(opts.cmd, opts.argv, {
        cwd: tab.cwd,
        // 剔除 Nomi 内部变量；只有该后端自己的供应商（opts.env）才会注入额外变量
        // .mjs mock 经 Electron execPath 启动时必须 ELECTRON_RUN_AS_NODE（见 cliChildEnv）
        env: this.childEnv(Boolean(opts.asNode), opts.launch ?? OFFICIAL_LAUNCH, opts.env),
      });
      this.children.set(tab.id, child);

      // Codex/dsh：stdin 管道不 EOF 会挂起；Claude 权限回传需要保持打开
      if (!opts.keepStdin) child.stdin.end();

      const take = (line: string, live: boolean) => {
        for (const rawEv of opts.parseLine(line)) {
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
          ev = withPermissionExpiry(stampEvent(ev));
          const folded = foldAssistantEvent(text, breaks, ev);
          text = folded.text;
          breaks = folded.breaks;
          ev = folded.ev;
          if (ev.type !== 'text-delta') events.push(ev);
          if (live) this.emitEvent(tab.id, ev);
          if (ev.type === 'permission') {
            this.armPermissionTimeout(tab.id, ev.id);
            this.allowIfBypass(tab.id, ev.id, () =>
              this.events.emit('permission-needed', {
                tabId: tab.id,
                title: tab.title,
                backend: tab.backend,
                summary: ev.summary,
                background: this.activeTabId !== tab.id || !anyWindowFocused(),
              }),
            );
          }
          if (ev.type === 'error') lastError = ev.message;
          if (ev.type === 'done') {
            if (ev.sessionId) sessionId = ev.sessionId;
            if (ev.usage || (opts.kind === 'dsh' && !ev.sessionId)) completed = true;
            // 一轮结束：若仍开着 stdin，补 EOF，避免 CLI 空等
            if (opts.keepStdin && child.stdin.writable) {
              try {
                child.stdin.end();
              } catch {
                /* */
              }
            }
          }
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? '';
        for (const line of parts) take(line, true);
      });
      child.stderr.on('data', (c) => {
        this.d.logger.warn(`harness ${opts.kind} stderr`, String(c).slice(0, 500));
      });
      child.on('error', (e) => {
        this.children.delete(tab.id);
        this.clearPermissionTimeouts(tab.id);
        reject(e);
      });
      child.on('close', (code, signal) => {
        this.children.delete(tab.id);
        this.clearPermissionTimeouts(tab.id);
        if (buf.trim()) take(buf, false);
        // 用户停止 / 被信号杀死 / 非零退出：不能因为「已有部分文字」就当成功完成（见 #25）。
        // 已见到一轮完成事件时，收尾阶段的非零退出不再翻案为失败。
        if (!completed && (this.stopRequested.has(tab.id) || signal)) {
          reject(new Error(t('已中止')));
          return;
        }
        // dsh 在 Node < 24 下不报错、无输出、退出码 0
        if (opts.kind === 'dsh' && events.length === 0 && !code) {
          reject(
            new Error(
              t(
                'dsh 没有任何输出：需要 Node ≥ {0}（当前 PATH 上的 Node 为 {1}）',
                DSH_MIN_NODE_MAJOR,
                readPathNodeVersion() ?? t('未找到'),
              ),
            ),
          );
          return;
        }
        if (code && code !== 0 && !completed) {
          reject(new Error(lastError ?? t('{0} 退出码 {1}', opts.kind, code)));
          return;
        }
        // 报了错、一个字也没回：按失败处理（dsh 上游 401 / 模型不存在时照样输出空的 final，
        // 不能把它当成「无文本输出」的正常完成，否则用户看不到原因）
        if (lastError && !text.trim()) {
          reject(new Error(lastError));
          return;
        }
        resolve({
          text: rewriteGeneratedImageLinks(text, imageAliases) || t('（无文本输出）'),
          sessionId,
          events,
          ...(breaks.length ? { textBreaks: breaks } : {}),
        });
      });
    });
  }

  // ───────────────────────── 广播 / IPC ─────────────────────────

  private post(channel: string, payload: unknown) {
    // 其它通道的消息（tab-message / tabs / changed）必须排在已入队的实时事件之后
    this.eventBatcher.flush();
    this.broadcast(channel, payload);
  }

  private broadcast(channel: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* */
      }
    }
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
    return p.kind === 'tool' ? t('正在执行 {0}', v) : v;
  }

  private emitEvent(tabId: string, ev: HarnessEvent) {
    this.trackProgress(tabId, ev);
    const part = this.partial.get(tabId);
    let outgoing = ev;
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
      this.post('ai:harness:changed', this.state());
      this.post('ai:harness:tabs', this.listTabs());
    });
  }

  /** 用户允许/拒绝 Claude 工具权限请求；写回 CLI stdin 的 control_response */
  replyPermission(
    tabId: string,
    requestId: string,
    allow: boolean,
    reason: 'allowed' | 'denied' | 'timeout' = allow ? 'allowed' : 'denied',
  ): boolean {
    const gemini =
      this.acpLive.get(tabId)?.perms.get(requestId) ??
      this.codexLive.get(tabId)?.perms.get(requestId);
    if (gemini) {
      this.clearOnePermissionTimeout(tabId, requestId);
      gemini(allow);
      this.emitEvent(tabId, { type: 'permission-resolved', id: requestId, reason });
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
          : { behavior: 'deny', message: t('用户没有允许这次调用') },
      },
    };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      // 界面按 id 移除对应卡片（并行子代理的请求排成队列，不能只清「当前那一个」）
      this.emitEvent(tabId, { type: 'permission-resolved', id: requestId, reason });
      return true;
    } catch (e) {
      this.d.logger.warn('harness permission reply failed', e);
      return false;
    }
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
    if (!opts.confirmed) throw new Error(t('需要先确认才能信任这个文件夹'));
    if (!this.tabs.has(tabId) || tabId === MAIN_TAB_ID) throw new Error(t('标签不存在'));
    const msg = this.tabMessages(tabId).find((m) => m.id === messageId);
    const folder = msg?.geminiTrust?.folder;
    if (!folder) throw new Error(t('这条消息没有需要信任的文件夹'));
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
    const timer = setTimeout(() => {
      this.replyPermission(tabId, requestId, false, 'timeout');
    }, PERMISSION_TIMEOUT_MS);
    // 权限卡 120s 超时不应拖住进程退出
    (timer as { unref?: () => void }).unref?.();
    m.set(requestId, timer);
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

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'CliHarnessService' });
    // 启动时就在后台把各 CLI 的可执行文件探测好，之后的状态读取都只读缓存
    void this.refreshBins().catch(() => undefined);
    handle('ai:harness:state', async () => {
      await this.refreshBins().catch(() => undefined);
      return this.state();
    });
    handle('ai:harness:set-backend', (b) => this.setBackend(b as HarnessBackend));
    handle('ai:harness:tab-carry-clear', (id) => this.clearTabCarry(String(id)));
    handle('ai:harness:set-cwd', (c, o) =>
      this.setCwd(String(c), { carry: (o as { carry?: unknown } | undefined)?.carry === true }),
    );
    handle('ai:harness:pick-cwd', () => this.pickCwd());
    handle('ai:harness:send', async (p) => slimResult(await this.send(String(p ?? ''))));
    handle('ai:harness:tabs', () => this.listTabs());
    handle('ai:harness:tab-create', (o) =>
      this.createTab(
        (o ?? {}) as {
          backend?: HarnessBackend;
          cwd?: string;
          title?: string;
          messages?: HarnessTabMessage[];
          permissionMode?: HarnessPermissionMode;
        },
      ),
    );
    handle('ai:harness:tab-seed', (id, msgs) =>
      this.seedTabMessages(String(id), (msgs ?? []) as HarnessTabMessage[]),
    );
    handle('ai:harness:tab-close', (id) => this.closeTab(String(id)));
    handle('ai:harness:tab-rename', (id, title) => this.renameTab(String(id), String(title)));
    handle('ai:harness:tab-activate', (id) => this.setActiveTab(String(id)));
    handle('ai:harness:tab-backend', (id, b) =>
      this.setTabBackend(String(id), b as HarnessBackend),
    );
    handle('ai:harness:tab-cwd', (id, c, o) =>
      this.setTabCwd(String(id), String(c), {
        carry: (o as { carry?: unknown } | undefined)?.carry === true,
      }),
    );
    handle('ai:harness:tab-permission-mode', (id, m, o) => {
      const raw = o as { confirmed?: unknown; expect?: unknown } | undefined;
      // 等长驻进程确认后再回复：后端拒绝 / 超时时界面拿到错误，而不是把没生效的档位当成已生效（#72）
      return this.applyTabPermissionMode(String(id), m as HarnessPermissionMode, {
        confirmed: raw?.confirmed === true,
        // 原样核对：类型不对的值与标签不相等，按「已变化」拒绝
        expect:
          raw?.expect && typeof raw.expect === 'object'
            ? (raw.expect as { backend?: string; cwd?: string })
            : undefined,
      });
    });
    handle('ai:harness:model-catalog', (b, o) =>
      this.modelCatalogFor(String(b ?? '') as HarnessBackend, {
        refresh: (o as { refresh?: unknown } | undefined)?.refresh === true,
        source:
          (o as { source?: unknown } | undefined)?.source === 'thirdParty'
            ? 'thirdParty'
            : 'official',
      }),
    );
    handle('ai:harness:tab-source', (id, src, m) =>
      this.setTabSource(
        String(id),
        src as HarnessTabSource,
        m === undefined || m === null ? undefined : String(m),
      ),
    );
    handle('ai:harness:tab-model', (id, m) => this.setTabModel(String(id), String(m ?? '')));
    handle('ai:harness:tab-effort', (id, e) =>
      this.setTabReasoningEffort(String(id), e === null || e === undefined ? null : String(e)),
    );
    handle('ai:harness:permission-defaults', (o) =>
      this.setPermissionDefaults(
        (o ?? {}) as { defaultPermissionMode?: HarnessPermissionMode; codexNetwork?: boolean },
      ),
    );
    handle('ai:harness:tab-pick-cwd', (id) => this.pickTabCwd(String(id)));
    handle('ai:harness:pick-dir', (p) => this.pickDirectory(p ? String(p) : undefined));
    handle('ai:harness:recent-cwds', () => this.recentCwds());
    handle('ai:harness:tab-messages', (id) => this.tabMessages(String(id)));
    handle('ai:harness:tab-send', async (id, p) =>
      slimResult(await this.sendTab(String(id), String(p ?? ''))),
    );
    handle('ai:harness:tab-cancel', (id) => this.cancelTab(String(id)));
    handle('ai:harness:stop-agent', (id, agentId) =>
      this.stopAgent(String(id), String(agentId ?? '')),
    );
    handle('ai:harness:set-max-concurrent', (n) => this.setMaxConcurrent(Number(n)));
    // 斜杠命令：只读发现 / 按 id 展开 / 只读 git diff（见 slashDiscovery.ts）
    handle('ai:harness:slash-discover', (b, cwd) =>
      discoverSlash(asSlashBackend(b), validDir(String(cwd ?? ''))),
    );
    handle('ai:harness:slash-expand', (b, cwd, id, args) =>
      expandSlash(
        asSlashBackend(b),
        validDir(String(cwd ?? '')),
        String(id ?? ''),
        String(args ?? '').slice(0, 4000),
      ),
    );
    handle('ai:harness:git-diff', (cwd) => gitDiff(validDir(String(cwd ?? ''))));
    handle('ai:harness:gemini-trust-folder', (tabId, messageId, o) =>
      this.trustGeminiFolder(String(tabId), String(messageId ?? ''), {
        confirmed: (o as { confirmed?: unknown } | undefined)?.confirmed === true,
      }),
    );
    handle('ai:harness:reply-permission', (tabId, requestId, allow) =>
      this.replyPermission(String(tabId), String(requestId), Boolean(allow)),
    );
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

type AcpBackend = 'gemini' | 'grok';

type CodexTurn = {
  /** turn/start 应答里的 turnId（停止用；应答到达前为 null） */
  id: string | null;
  events: HarnessEvent[];
  text: string;
  breaks: number[];
  /** 最近一段流式正文所属的消息条目：换条目时补段落分隔 */
  lastItem: string | null;
  /** 这一轮开始时的线程累计用量（结束时求差即这一轮的用量） */
  totalsBefore: CodexTokenTotals | null;
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
  conn: AcpConnection;
  /** 线程 id（= cliSessionId）；新会话在第一条消息时才 thread/start */
  threadId: string | null;
  cwd: string;
  /** 已随 turn/start 下发的模型 / 思考深度覆盖（null = 沿用 config.toml 默认） */
  model: string | null;
  effort: string | null;
  turn: CodexTurn | null;
  /** 挂起的审批：id → 应答（true 允许 / false 拒绝 / null 取消） */
  perms: Map<string, (allow: boolean | null) => void>;
  /** 最近一次 thread/tokenUsage/updated 的线程累计 */
  totals: CodexTokenTotals | null;
  lastActivityAt: number;
  ready: Promise<void>;
  used?: boolean;
  /** 换了账号 / 供应商：这一轮结束后拆掉，下一轮按新配置重拉 */
  recycleAfterTurn?: boolean;
};

/** ACP 握手阶段进程就退出（CLI 太旧 / 不支持 ACP）：Grok 据此退回每轮一个进程的 `grok -p` */
class AcpUnavailableError extends Error {}

type AcpTurn = {
  /** 这一轮里用户拒绝过工具调用（Grok 会以 cancelled 结束整轮） */
  denied?: boolean;
  mapper: ReturnType<typeof createGeminiMapper>;
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
  conn: AcpConnection;
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

/** 在途的 Claude control_request：等同 request_id 的 control_response */
type ClaudeControlWaiter = {
  resolve: (response: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

/** 长驻 Claude 进程上还有后台任务或自发轮次在跑（拆进程会把它们一起杀掉） */
function claudeBackgroundActive(live: ClaudeLiveSession): boolean {
  return live.bgTasks.size > 0 || live.auto !== null;
}

type ClaudeLiveSession = {
  /** 启动时的来源注入签名（见 launchFor）：变了就不能复用 */
  launchSig: string;
  child: ChildProcessWithoutNullStreams;
  parseLine: (line: string) => HarnessEvent[];
  buf: string;
  turn: ClaudeTurnWaiter | null;
  cwd: string;
  /** 进程已生效的权限模式：启动参数，或最近一次得到成功 control_response 的 set_permission_mode */
  permissionMode: HarnessPermissionMode;
  /** 最近一次还没得到确认的权限模式切换；确认前不复用进程跑下一轮（#72） */
  modeChange: ModeChange | null;
  /** 在途的 control_request：request_id → 应答 */
  controls: Map<string, ClaudeControlWaiter>;
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

/** 权限请求带上超时时间点：界面显示倒计时，与主进程的自动拒绝同一个时钟 */
function withPermissionExpiry(ev: HarnessEvent): HarnessEvent {
  return ev.type === 'permission' && ev.expiresAt === undefined
    ? { ...ev, expiresAt: Date.now() + PERMISSION_TIMEOUT_MS }
    : ev;
}

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

function isScript(bin: string) {
  return bin.endsWith('.mjs') || bin.endsWith('.js');
}

/** spawn 一个 CLI。Windows 的 npm 垫片先解开，避免对无扩展名脚本报 ENOENT。 */
function spawnHarness(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  const launch = resolveHarnessLaunch(command, args, opts.env);
  const child = spawn(launch.file, launch.args, {
    cwd: opts.cwd,
    env: launch.env,
    windowsHide: true,
    ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  // 子进程先退出时，之后的 stdin 写入（NDJSON / control_response / end）会异步 EPIPE；
  // 没有监听就成了主进程 uncaughtException。轮次的失败由 close / error 事件负责（#46）
  child.stdin.on('error', () => {});
  return child;
}

/**
 * Electron 的 process.execPath 是 Electron 本体；跑 .mjs/.js mock/脚本时必须带
 * ELECTRON_RUN_AS_NODE=1，否则 Windows 上会以 GUI 子系统拉起，stdin 管道失效，
 * harness 收到空输出（「无文本输出」），并发/续接用例随之失败。Node 下该变量无害。
 */
function cliChildEnv(useNode: boolean, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // 带上补全后的 PATH：`#!/usr/bin/env node` 的 CLI 要能找到 nvm / volta 等装的 node（#76）
  return buildCliEnv(
    withCliPath(process.env),
    useNode ? { ELECTRON_RUN_AS_NODE: '1', ...extra } : extra,
  );
}

function clampLimit(n: number): number {
  return Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : DEFAULT_MAX_CONCURRENT;
}

function validDir(cwd: string): string {
  const abs = path.resolve(String(cwd ?? ''));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(t('工作目录无效'));
  }
  return abs;
}

function anyWindowFocused(): boolean {
  try {
    return BrowserWindow.getAllWindows().some((w) => w.isFocused?.());
  } catch {
    return false;
  }
}

function asSlashBackend(b: unknown): SlashBackend {
  return b === 'claude' || b === 'codex' || b === 'grok' || b === 'dsh' ? b : 'nomi';
}

let inst: CliHarnessService | null = null;
export function initCliHarnessService(
  d: ConstructorParameters<typeof CliHarnessService>[0],
): CliHarnessService {
  inst = new CliHarnessService(d);
  return inst;
}
export function getCliHarnessService(): CliHarnessService | null {
  return inst;
}

function slimResult(r: HarnessSendResult): HarnessSendReply {
  const { events: _events, ...rest } = r;
  return rest;
}

/** 播种（分叉 / 历史恢复）消息时保留的结构化字段：轨迹、耗时、用量、中断标记 */
function seedExtras(m: HarnessTabMessage): Partial<HarnessTabMessage> {
  return {
    ...(Array.isArray(m.trace) && m.trace.length ? { trace: m.trace.slice(0, 300) } : {}),
    ...(typeof m.durationMs === 'number' ? { durationMs: m.durationMs } : {}),
    ...(m.usage && typeof m.usage === 'object' ? { usage: m.usage } : {}),
    ...(m.stopped ? { stopped: true as const } : {}),
  };
}
