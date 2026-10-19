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

import { buildCliEnv } from './cliEnv';
import { resolveHarnessLaunch } from './cliLaunch';
import {
  DSH_MIN_NODE_MAJOR,
  peekCliBin,
  readPathNodeVersion,
  refreshCliBin,
  resolveCliBinCached,
} from './detect';
import { EventBatcher } from './eventBatcher';
import { pickIdle, resolveIdleReclaimMs, sweepIntervalMs } from './idleReclaim';
import {
  DEFAULT_PERMISSION_MODE,
  claudeModeName,
  effectiveMode,
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
  HarnessTabsState,
} from './types';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

type CliBackend = Exclude<HarnessBackend, 'nomi'>;

export const MAIN_TAB_ID = 'main';
export const DEFAULT_MAX_CONCURRENT = 3;
const MAX_TAB_MESSAGES = 300;
const MAX_RECENT_CWDS = 8;
/** 权限卡超时：与桌面能力一致，默认拒绝 */
const PERMISSION_TIMEOUT_MS = 120_000;
const CHAT_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_ALIAS_FILE = 'image-aliases.json';

const BACKENDS: readonly HarnessBackend[] = ['nomi', 'claude', 'codex', 'dsh', 'grok'];

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

const CLI_BACKENDS: readonly CliBackend[] = ['claude', 'codex', 'dsh', 'grok'];

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
  private codexNetwork = true;
  private readonly home: string;
  private readonly statePath: string;
  private readonly tabsPath: string;
  private readonly tabsDir: string;
  private readonly recentPath: string;
  private recent: string[] = [];
  readonly events = new EventEmitter();

  constructor(
    private readonly d: {
      root: string;
      logger: Logger;
      home?: string;
      defaultCwd?: string;
      /** 启动 dsh 时注入的额外环境变量（例如启用档案的 NOMI_DSH_API_KEY） */
      dshEnv?: () => Record<string, string>;
      /** 启动 Grok 时注入的额外环境变量（例如启用档案写入的 XAI_API_KEY） */
      grokEnv?: () => Record<string, string>;
      /** 长驻 CLI 进程空闲多久后回收（毫秒，0 = 不回收）；缺省读 NOMI_HARNESS_IDLE_MS，再缺省 30 分钟 */
      idleReclaimMs?: number;
    },
  ) {
    this.idleReclaimMs = resolveIdleReclaimMs(d.idleReclaimMs, process.env.NOMI_HARNESS_IDLE_MS);
    this.home = d.home ?? os.homedir();
    this.statePath = path.join(d.root, 'session.json');
    this.tabsPath = path.join(d.root, 'tabs.json');
    this.tabsDir = path.join(d.root, 'tabs');
    this.recentPath = path.join(d.root, 'recent-cwds.json');
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
      ) as Partial<HarnessSessionState> & { title?: string; permissionMode?: unknown };
      const m = this.main;
      if (isBackend(raw.backend)) m.backend = raw.backend;
      if (typeof raw.cwd === 'string' && raw.cwd) m.cwd = raw.cwd;
      if (typeof raw.cliSessionId === 'string') m.cliSessionId = raw.cliSessionId;
      if (typeof raw.title === 'string' && raw.title.trim()) m.title = raw.title;
      mainMode = raw.permissionMode;
    } catch {
      /* */
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.tabsPath, 'utf8')) as {
        activeTabId?: string;
        maxConcurrent?: number;
        defaultPermissionMode?: unknown;
        codexNetwork?: unknown;
        tabs?: HarnessTabMeta[];
      };
      if (typeof raw.maxConcurrent === 'number') this.maxConcurrent = clampLimit(raw.maxConcurrent);
      if (isPermissionMode(raw.defaultPermissionMode) && raw.defaultPermissionMode !== 'bypass') {
        this.defaultPermissionMode = raw.defaultPermissionMode;
      }
      if (typeof raw.codexNetwork === 'boolean') this.codexNetwork = raw.codexNetwork;
      for (const tab of raw.tabs ?? []) {
        if (!tab || typeof tab.id !== 'string' || tab.id === MAIN_TAB_ID) continue;
        if (!isBackend(tab.backend) || tab.backend === 'nomi') continue;
        // 重启时中断的轮次回到空闲
        this.tabs.set(tab.id, {
          ...tab,
          status: tab.status === 'error' ? 'error' : 'idle',
          unread: Number(tab.unread) || 0,
          permissionMode: this.restoredMode(tab.backend, tab.permissionMode),
        });
      }
      if (raw.activeTabId && this.tabs.has(raw.activeTabId)) this.activeTabId = raw.activeTabId;
    } catch {
      /* */
    }
    this.main.permissionMode = this.restoredMode(this.main.backend, mainMode);
  }

  private persist() {
    const m = this.main;
    const s: HarnessSessionState & { title: string; permissionMode: HarnessPermissionMode } = {
      backend: m.backend,
      cwd: m.cwd,
      cliSessionId: m.cliSessionId,
      busy: m.status === 'running' || m.status === 'queued',
      title: m.title,
      permissionMode: m.permissionMode,
    };
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(s, null, 2), 'utf8');
      const tabs = [...this.tabs.values()].filter((x) => x.id !== MAIN_TAB_ID);
      fs.writeFileSync(
        this.tabsPath,
        JSON.stringify(
          {
            activeTabId: this.activeTabId,
            maxConcurrent: this.maxConcurrent,
            defaultPermissionMode: this.defaultPermissionMode,
            codexNetwork: this.codexNetwork,
            tabs,
          },
          null,
          2,
        ),
        'utf8',
      );
    } catch (e) {
      this.d.logger.warn('harness persist failed', e);
    }
  }

  private messagesPath(id: string) {
    return path.join(this.tabsDir, `${id.replace(/[^\w-]/g, '_')}.json`);
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
      fs.writeFileSync(this.messagesPath(id), JSON.stringify(list), 'utf8');
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
    try {
      let json = JSON.stringify(list);
      // 文件过大：较早消息的轨迹只保留骨架，避免每条消息都整文件同步写几十 MB
      if (json.length > MAX_TAB_FILE_BYTES && compactOldTraces(list)) json = JSON.stringify(list);
      fs.writeFileSync(this.messagesPath(id), json, 'utf8');
    } catch (e) {
      this.d.logger.warn('harness tab messages write failed', e);
    }
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

  setCwd(cwd: string): State {
    this.setTabCwd(MAIN_TAB_ID, cwd);
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
    };
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
        fs.writeFileSync(this.messagesPath(tab.id), JSON.stringify(seeded), 'utf8');
      } catch (e) {
        this.d.logger.warn('harness tab seed write failed', e);
      }
      tab.updatedAt = seeded[seeded.length - 1]!.timestamp;
    }
    this.activeTabId = tab.id;
    this.changed();
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
      fs.writeFileSync(this.messagesPath(id), JSON.stringify(seeded), 'utf8');
    } catch (e) {
      this.d.logger.warn('harness tab seed write failed', e);
    }
    if (seeded.length) tab.updatedAt = seeded[seeded.length - 1]!.timestamp;
    this.changed();
    return { ...tab };
  }

  closeTab(id: string): HarnessTabsState {
    if (id === MAIN_TAB_ID) throw new Error(t('主对话标签不能关闭'));
    this.requireTab(id);
    this.cancelTab(id);
    this.teardownClaudeLive(id);
    const order = [...this.tabs.keys()];
    const idx = order.indexOf(id);
    this.tabs.delete(id);
    this.messages.delete(id);
    this.progress.delete(id);
    try {
      fs.rmSync(this.messagesPath(id), { force: true });
    } catch {
      /* */
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
    if (!next) throw new Error(t('标题不能为空'));
    tab.title = next;
    this.changed();
    return { ...tab };
  }

  setActiveTab(id: string): HarnessTabsState {
    const tab = this.requireTab(id);
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
      tab.cliSessionId = null;
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
    // 新后端不支持当前档位时降到更安全的一档
    tab.permissionMode = effectiveMode(backend, tab.permissionMode).mode;
    // 后端没变（侧栏切回 Nomi 会话时会再设一次）：不必落盘 / 广播
    if (switched) this.changed();
    return { ...tab };
  }

  setTabCwd(id: string, cwd: string): HarnessTabMeta {
    const tab = this.requireTab(id);
    const abs = validDir(cwd);
    // CLI 续接与 cwd 绑定：换目录即开新会话，并拆掉 Claude 长驻进程
    if (abs !== tab.cwd) {
      this.teardownClaudeLive(id);
      tab.cliSessionId = null;
    }
    tab.cwd = abs;
    if (tab.backend !== 'nomi') this.rememberCwd(abs);
    this.changed();
    return { ...tab };
  }

  /**
   * 切换标签权限模式。返回实际生效的档位（后端不支持时已降级）。
   * 「完全放开」必须带 confirmed（渲染层确认框之后），防止绕过确认。
   * Claude 长驻进程用 control_request 即时切换；Codex / dsh / Grok 下一轮启动时生效。
   */
  setTabPermissionMode(
    id: string,
    mode: HarnessPermissionMode,
    opts: { confirmed?: boolean } = {},
  ): HarnessTabMeta & { degraded: boolean } {
    const tab = this.requireTab(id);
    if (!isPermissionMode(mode)) throw new Error(t('未知权限模式'));
    if (mode === 'bypass' && !opts.confirmed) throw new Error(t('完全放开需要先确认'));
    const next = effectiveMode(tab.backend, mode);
    if (next.mode !== tab.permissionMode) {
      tab.permissionMode = next.mode;
      const live = this.claudeLive.get(id);
      if (live && live.permissionMode !== next.mode) {
        const sent = this.writeClaudeControl(live, {
          subtype: 'set_permission_mode',
          mode: claudeModeName(next.mode),
        });
        // 写不进去：拆掉，下一轮带新模式 --resume 重拉
        if (sent) live.permissionMode = next.mode;
        else this.teardownClaudeLive(id);
      }
      this.changed();
    }
    return { ...tab, degraded: next.degraded };
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

  /** 中止标签当前轮次；Claude 长驻进程一并拆除（下一轮可 --resume） */
  cancelTab(id: string): boolean {
    const queued = this.tabs.get(id)?.status === 'queued';
    if (queued) this.stopRequested.add(id);
    const live = this.claudeLive.get(id);
    if (live?.turn) {
      this.writeClaudeControl(live, { subtype: 'interrupt' });
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

  /** 测试 / 应用退出：拆除所有长驻 Claude 与残留子进程（含其子孙进程）、清掉所有定时器 */
  dispose(): void {
    this.stopIdleSweep();
    this.eventBatcher.dispose();
    for (const id of [...this.claudeLive.keys()]) this.teardownClaudeLive(id);
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
    const startedAt = Date.now();
    this.partial.set(id, { text: '', breaks: [], events: [] });
    this.changed();
    try {
      const result =
        backend === 'claude'
          ? await this.runClaude(tab, text)
          : backend === 'dsh'
            ? await this.runDsh(tab, text)
            : backend === 'grok'
              ? await this.runGrok(tab, text)
              : await this.runCodex(tab, text);
      if (result.sessionId && tab.backend === backend) tab.cliSessionId = result.sessionId;
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
          const partText = part?.text ?? '';
          this.appendMessage(id, {
            id: randomUUID(),
            role: 'assistant',
            content: partText.trim() ? `${partText}\n\n${message}` : message,
            timestamp: Date.now(),
            error: true,
            durationMs,
            ...(trace.length ? { trace } : {}),
            ...(partText.trim() && part?.breaks.length ? { textBreaks: part.breaks } : {}),
          });
          this.finish(tab, false, '', message);
        }
      }
      throw e;
    } finally {
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
  private runClaude(tab: HarnessTabMeta, prompt: string): Promise<HarnessSendResult> {
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

  private ensureClaudeLive(tab: HarnessTabMeta): ClaudeLiveSession {
    const existing = this.claudeLive.get(tab.id);
    if (
      existing &&
      existing.cwd === tab.cwd &&
      existing.permissionMode === tab.permissionMode &&
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
      '--permission-prompt-tool',
      'stdio',
      '--replay-user-messages',
      ...permissionLaunch('claude', tab.permissionMode).args,
    ];
    if (tab.cliSessionId) argv.push('--resume', tab.cliSessionId);
    const child = spawnHarness(useNode ? process.execPath : bin, useNode ? [bin, ...argv] : argv, {
      cwd: tab.cwd,
      env: cliChildEnv(useNode),
    });
    const live: ClaudeLiveSession = {
      child,
      parseLine: createClaudeParser(),
      buf: '',
      turn: null,
      cwd: tab.cwd,
      permissionMode: tab.permissionMode,
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

  private writeClaudeControl(live: ClaudeLiveSession, request: Record<string, unknown>) {
    if (!live.child.stdin.writable) return false;
    const payload = {
      type: 'control_request',
      request_id: randomUUID(),
      request,
    };
    try {
      live.child.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
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
        this.events.emit('permission-needed', {
          tabId,
          title: tab?.title ?? 'Claude Code',
          backend: 'claude' as HarnessBackend,
          summary: ev.agent ? t('子代理「{0}」：{1}', ev.agent, ev.summary) : ev.summary,
          background: this.activeTabId !== tabId || !anyWindowFocused(),
        });
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

  /**
   * 不产生界面事件的协议行：用户消息回显（轮次开始标记）与后台任务生命周期。返回 true 表示已处理完。
   */
  private onClaudeMeta(tabId: string, live: ClaudeLiveSession, line: string): boolean {
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
      [...this.claudeLive.entries()].map(([id, live]) => ({
        id,
        lastActivityAt: live.lastActivityAt,
        turnActive: live.turn !== null,
        permissionPending: (this.pendingPermissions.get(id)?.size ?? 0) > 0,
        tabBusy: ['running', 'queued'].includes(this.tabs.get(id)?.status ?? 'idle'),
        resumable: Boolean(this.tabs.get(id)?.cliSessionId),
        backgroundActive: live.bgTasks.size > 0 || live.auto !== null,
      })),
      now,
      this.idleReclaimMs,
    );
    for (const id of picked) {
      this.teardownClaudeLive(id);
      this.dormant.add(id);
      this.d.logger.info('harness idle process reclaimed', { tabId: id });
    }
    if (picked.length) this.changed();
    if (!this.claudeLive.size) this.stopIdleSweep();
    return picked;
  }

  /**
   * 供应商配置已经落到磁盘。正在跑的进程不会重读环境变量和配置文件。
   * Claude 是唯一跨轮长驻的进程：空闲的悄悄拆掉，下一轮用原来的 cliSessionId
   * 带 --resume 重拉。这一轮还在输出时先记下，等它正常结束再拆，避免「已中止」或休眠条。
   * Codex / dsh / Grok 每条消息都是新进程，下一轮自己读新配置；不杀掉正在跑的那一轮。
   */
  recycleBackend(kind: HarnessBackend): void {
    if (kind !== 'claude') return;
    for (const [id, live] of [...this.claudeLive.entries()]) {
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

  private runCodex(tab: HarnessTabMeta, prompt: string): Promise<HarnessSendResult> {
    const bin = resolveHarnessBin('codex');
    if (!bin) return Promise.reject(new Error(t('未找到 Codex（可设 NOMI_USE_MOCK_CLI=1）')));
    const useNode = isScript(bin);
    // `exec` 默认 read-only 沙箱且禁网：沙箱 / 联网 / 自动审批都按权限模式用 -c 指定
    // （`exec resume` 不接受 --sandbox / --cd；工作目录由 spawn 的 cwd 决定，也即可写根）
    const sandbox = permissionLaunch('codex', tab.permissionMode, {
      codexNetwork: this.codexNetwork,
    }).args;
    prompt = (tab.permissionMode === 'plan' ? planPromptPrefix('codex') : '') + prompt;
    const argv = useNode
      ? tab.cliSessionId
        ? [bin, 'exec', 'resume', '--json', tab.cliSessionId, prompt]
        : [bin, 'exec', '--json', prompt]
      : tab.cliSessionId
        ? [
            'exec',
            'resume',
            '--json',
            '--skip-git-repo-check',
            ...sandbox,
            tab.cliSessionId,
            prompt,
          ]
        : ['exec', '--json', '--skip-git-repo-check', ...sandbox, '--cd', tab.cwd, prompt];
    return this.spawnCollect(tab, {
      cmd: useNode ? process.execPath : bin,
      argv,
      parseLine: parseCodexLine,
      kind: 'codex',
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
    const argv = ['--profile', 'headless', '--json'];
    if (tab.cliSessionId) argv.push('--session-id', tab.cliSessionId);
    if (tab.permissionMode === 'plan') prompt = planPromptPrefix('dsh') + prompt;
    // 以 - 开头的提示会被当成参数，前置空格规避
    argv.push(prompt.startsWith('-') ? ` ${prompt}` : prompt);
    let extraEnv: Record<string, string> = {};
    try {
      extraEnv = this.d.dshEnv?.() ?? {};
    } catch (e) {
      this.d.logger.warn('harness dsh env failed', e);
    }
    // 沙箱档位：DSH_PERMISSION_MODE（read-only / workspace-write / danger-full-access）
    extraEnv = { ...extraEnv, ...permissionLaunch('dsh', tab.permissionMode).env };
    return this.spawnCollect(tab, {
      cmd: useNode ? process.execPath : bin,
      argv: useNode ? [bin, ...argv] : argv,
      parseLine: createDshParser(),
      kind: 'dsh',
      env: extraEnv,
      asNode: useNode,
    });
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
    const argv = [
      '-p',
      prompt.startsWith('-') ? ` ${prompt}` : prompt,
      '--output-format',
      'streaming-json',
      '--no-auto-update',
      ...permissionLaunch('grok', tab.permissionMode).args,
    ];
    if (tab.cliSessionId) argv.push('--resume', tab.cliSessionId);
    if (tab.cwd) argv.push('--cwd', tab.cwd);
    let extraEnv: Record<string, string> = {};
    try {
      extraEnv = this.d.grokEnv?.() ?? {};
    } catch (e) {
      this.d.logger.warn('harness grok env failed', e);
    }
    return this.spawnCollect(tab, {
      cmd: useNode ? process.execPath : bin,
      argv: useNode ? [bin, ...argv] : argv,
      parseLine: createGrokParser(),
      kind: 'grok',
      env: extraEnv,
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
        // 剔除 Nomi 内部变量；只有该后端自己的档案（opts.env）才会注入额外变量
        // .mjs mock 经 Electron execPath 启动时必须 ELECTRON_RUN_AS_NODE（见 cliChildEnv）
        env: cliChildEnv(Boolean(opts.asNode), opts.env),
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
            this.events.emit('permission-needed', {
              tabId: tab.id,
              title: tab.title,
              backend: tab.backend,
              summary: ev.summary,
              background: this.activeTabId !== tab.id || !anyWindowFocused(),
            });
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

  private changed() {
    this.persist();
    this.post('ai:harness:changed', this.state());
    const tabs = this.listTabs();
    this.post('ai:harness:tabs', tabs);
    this.events.emit('tabs', tabs);
  }

  /** 用户允许/拒绝 Claude 工具权限请求；写回 CLI stdin 的 control_response */
  replyPermission(
    tabId: string,
    requestId: string,
    allow: boolean,
    reason: 'allowed' | 'denied' | 'timeout' = allow ? 'allowed' : 'denied',
  ): boolean {
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
    handle('ai:harness:set-cwd', (c) => this.setCwd(String(c)));
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
    handle('ai:harness:tab-cwd', (id, c) => this.setTabCwd(String(id), String(c)));
    handle('ai:harness:tab-permission-mode', (id, m, o) =>
      this.setTabPermissionMode(String(id), m as HarnessPermissionMode, {
        confirmed: (o as { confirmed?: unknown } | undefined)?.confirmed === true,
      }),
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

type ClaudeLiveSession = {
  child: ChildProcessWithoutNullStreams;
  parseLine: (line: string) => HarnessEvent[];
  buf: string;
  turn: ClaudeTurnWaiter | null;
  cwd: string;
  /** 进程当前的权限模式（启动参数或最近一次 set_permission_mode） */
  permissionMode: HarnessPermissionMode;
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
  return buildCliEnv(process.env, useNode ? { ELECTRON_RUN_AS_NODE: '1', ...extra } : extra);
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
