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
import {
  DSH_MIN_NODE_MAJOR,
  peekCliBin,
  readPathNodeVersion,
  refreshCliBin,
  resolveCliBinCached,
} from './detect';
import { EventBatcher } from './eventBatcher';
import { killProcessTree } from './processTree';
import { discoverSlash, expandSlash, gitDiff, type SlashBackend } from './slashDiscovery';
import {
  createClaudeParser,
  createDshParser,
  createGrokParser,
  parseCodexLine,
} from './streamParse';
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
  private readonly partial = new Map<string, { text: string; events: HarnessEvent[] }>();
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
  private readonly waiters: Array<{
    tabId: string;
    resume: () => void;
    abort: (e: Error) => void;
  }> = [];
  private running = 0;
  private activeTabId = MAIN_TAB_ID;
  private maxConcurrent = DEFAULT_MAX_CONCURRENT;
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
    },
  ) {
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
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.statePath, 'utf8'),
      ) as Partial<HarnessSessionState> & { title?: string };
      const m = this.main;
      if (isBackend(raw.backend)) m.backend = raw.backend;
      if (typeof raw.cwd === 'string' && raw.cwd) m.cwd = raw.cwd;
      if (typeof raw.cliSessionId === 'string') m.cliSessionId = raw.cliSessionId;
      if (typeof raw.title === 'string' && raw.title.trim()) m.title = raw.title;
    } catch {
      /* */
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.tabsPath, 'utf8')) as {
        activeTabId?: string;
        maxConcurrent?: number;
        tabs?: HarnessTabMeta[];
      };
      if (typeof raw.maxConcurrent === 'number') this.maxConcurrent = clampLimit(raw.maxConcurrent);
      for (const tab of raw.tabs ?? []) {
        if (!tab || typeof tab.id !== 'string' || tab.id === MAIN_TAB_ID) continue;
        if (!isBackend(tab.backend) || tab.backend === 'nomi') continue;
        // 重启时中断的轮次回到空闲
        this.tabs.set(tab.id, {
          ...tab,
          status: tab.status === 'error' ? 'error' : 'idle',
          unread: Number(tab.unread) || 0,
        });
      }
      if (raw.activeTabId && this.tabs.has(raw.activeTabId)) this.activeTabId = raw.activeTabId;
    } catch {
      /* */
    }
  }

  private persist() {
    const m = this.main;
    const s: HarnessSessionState & { title: string } = {
      backend: m.backend,
      cwd: m.cwd,
      cliSessionId: m.cliSessionId,
      busy: m.status === 'running' || m.status === 'queued',
      title: m.title,
    };
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(s, null, 2), 'utf8');
      const tabs = [...this.tabs.values()].filter((x) => x.id !== MAIN_TAB_ID);
      fs.writeFileSync(
        this.tabsPath,
        JSON.stringify(
          { activeTabId: this.activeTabId, maxConcurrent: this.maxConcurrent, tabs },
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
      tabs: tabs.map((x) => ({ ...x })),
      activeTabId: this.activeTabId,
      maxConcurrent: this.maxConcurrent,
      running: tabs.filter((x) => x.status === 'running').length,
      queued: tabs.filter((x) => x.status === 'queued').length,
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
    if (tab.status === 'running' || tab.status === 'queued') throw new Error(t('上一轮尚未结束'));
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
    this.partial.set(id, { text: '', events: [] });
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
      tab.status = 'idle';
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
          });
          this.progress.delete(id);
          this.changed();
        } else {
          tab.status = 'error';
          tab.lastError = message;
          this.appendMessage(id, {
            id: randomUUID(),
            role: 'assistant',
            content: message,
            timestamp: Date.now(),
            error: true,
            durationMs,
            ...(trace.length ? { trace } : {}),
          });
          this.finish(tab, false, '', message);
        }
      }
      throw e;
    } finally {
      this.partial.delete(id);
      this.stopRequested.delete(id);
      this.release();
    }
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
        sessionId: tab.cliSessionId,
        lastError: null,
        settled: false,
      };
      live.turn = turn;
      this.children.set(tab.id, live.child);
      try {
        this.writeClaudeUser(live, prompt);
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
    ];
    if (tab.cliSessionId) argv.push('--resume', tab.cliSessionId);
    const child: ChildProcessWithoutNullStreams = spawn(
      useNode ? process.execPath : bin,
      useNode ? [bin, ...argv] : argv,
      {
        cwd: tab.cwd,
        env: cliChildEnv(useNode),
        windowsHide: true,
      },
    );
    const live: ClaudeLiveSession = {
      child,
      parseLine: createClaudeParser(),
      buf: '',
      turn: null,
      cwd: tab.cwd,
    };
    this.claudeLive.set(tab.id, live);

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

  private writeClaudeUser(live: ClaudeLiveSession, prompt: string) {
    if (!live.child.stdin.writable) throw new Error(t('Claude 进程 stdin 不可写'));
    const payload = {
      type: 'user',
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
    const turn = live.turn;
    for (const ev of live.parseLine(line)) {
      stampEvent(ev);
      if (turn) {
        // 流式文本片段已累计在 turn.text 里，不再逐条留存（长回答会有上万个）
        if (ev.type !== 'text-delta') turn.events.push(ev);
        if (ev.type === 'text-delta' || ev.type === 'text') turn.text += ev.text;
        if (ev.type === 'error') turn.lastError = ev.message;
        if (ev.type === 'done') {
          if (ev.text) turn.text = ev.text;
          if (ev.sessionId) turn.sessionId = ev.sessionId;
        }
      }
      if (liveEmit) this.emitEvent(tabId, ev);
      if (ev.type === 'permission') {
        this.armPermissionTimeout(tabId, ev.id);
        const tab = this.tabs.get(tabId);
        this.events.emit('permission-needed', {
          tabId,
          title: tab?.title ?? 'Claude Code',
          backend: 'claude' as HarnessBackend,
          summary: ev.summary,
          background: this.activeTabId !== tabId || !anyWindowFocused(),
        });
      }
      // 一轮失败（result.is_error / error 事件）：结束当前 Promise，进程保持长驻供下一轮
      if (ev.type === 'error' && turn && live.turn === turn) {
        live.turn = null;
        this.children.delete(tabId);
        if (!turn.settled) {
          turn.settled = true;
          turn.reject(new Error(ev.message));
        }
        continue;
      }
      // 一轮 result：结束当前 Promise，但保持 stdin 打开供下一轮
      if (ev.type === 'done' && turn && live.turn === turn) {
        live.turn = null;
        this.children.delete(tabId);
        if (!turn.settled) {
          turn.settled = true;
          turn.resolve({
            text: turn.text || t('（无文本输出）'),
            sessionId: turn.sessionId,
            events: turn.events,
          });
        }
      }
    }
  }

  /** 拆除 Claude 长驻进程（不 reject 当前 turn——由 close/kill 路径处理） */
  private teardownClaudeLive(tabId: string) {
    const live = this.claudeLive.get(tabId);
    if (!live) return;
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
    // `exec resume` 不接受 --cd；工作目录由 spawn 的 cwd 决定
    const argv = useNode
      ? tab.cliSessionId
        ? [bin, 'exec', 'resume', '--json', tab.cliSessionId, prompt]
        : [bin, 'exec', '--json', prompt]
      : tab.cliSessionId
        ? ['exec', 'resume', '--json', '--skip-git-repo-check', tab.cliSessionId, prompt]
        : ['exec', '--json', '--skip-git-repo-check', '--cd', tab.cwd, prompt];
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
    // 以 - 开头的提示会被当成参数，前置空格规避
    argv.push(prompt.startsWith('-') ? ` ${prompt}` : prompt);
    let extraEnv: Record<string, string> = {};
    try {
      extraEnv = this.d.dshEnv?.() ?? {};
    } catch (e) {
      this.d.logger.warn('harness dsh env failed', e);
    }
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
   * Grok Build 无头模式：`grok -p <prompt> --output-format streaming-json --no-auto-update [--yolo]`。
   * 续接：`--resume <sessionId>`。权限在接管场景默认 `--yolo`（与 Codex/dsh 一致：UI 侧不弹交互确认；
   * 真实权限事件格式未在真机验证，见文档「未验证」）。
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
      '--yolo',
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
      let sessionId: string | null = tab.cliSessionId;
      let buf = '';
      let lastError: string | null = null;
      const chatRoot = path.join(path.dirname(this.d.root), 'chat');
      const imageAliases = loadImageAliases(chatRoot);
      const child: ChildProcessWithoutNullStreams = spawn(opts.cmd, opts.argv, {
        cwd: tab.cwd,
        // 剔除 Nomi 内部变量；只有该后端自己的档案（opts.env）才会注入额外变量
        // .mjs mock 经 Electron execPath 启动时必须 ELECTRON_RUN_AS_NODE（见 cliChildEnv）
        env: cliChildEnv(Boolean(opts.asNode), opts.env),
        windowsHide: true,
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
          stampEvent(ev);
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
          if (ev.type === 'text-delta' || ev.type === 'text') text += ev.text;
          if (ev.type === 'error') lastError = ev.message;
          if (ev.type === 'done') {
            if (ev.text) text = ev.text;
            if (ev.sessionId) sessionId = ev.sessionId;
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
        if (signal && !text) {
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
        if (code && code !== 0 && !text) {
          reject(new Error(lastError ?? t('{0} 退出码 {1}', opts.kind, code)));
          return;
        }
        resolve({
          text: rewriteGeneratedImageLinks(text, imageAliases) || t('（无文本输出）'),
          sessionId,
          events,
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
    if (part) {
      if (ev.type === 'text-delta') part.text += ev.text;
      else if (ev.type === 'text') part.text = ev.text;
      else if (ev.type === 'tool' || ev.type === 'thinking') part.events.push(ev);
    }
    this.eventBatcher.push({ ...ev, tabId });
    this.events.emit('event', { tabId, event: ev });
  }

  private changed() {
    this.persist();
    this.post('ai:harness:changed', this.state());
    const tabs = this.listTabs();
    this.post('ai:harness:tabs', tabs);
    this.events.emit('tabs', tabs);
  }

  /** 用户允许/拒绝 Claude 工具权限请求；写回 CLI stdin 的 control_response */
  replyPermission(tabId: string, requestId: string, allow: boolean): boolean {
    const child = this.children.get(tabId);
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
      this.replyPermission(tabId, requestId, false);
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
    handle('ai:harness:tab-pick-cwd', (id) => this.pickTabCwd(String(id)));
    handle('ai:harness:pick-dir', (p) => this.pickDirectory(p ? String(p) : undefined));
    handle('ai:harness:recent-cwds', () => this.recentCwds());
    handle('ai:harness:tab-messages', (id) => this.tabMessages(String(id)));
    handle('ai:harness:tab-send', async (id, p) =>
      slimResult(await this.sendTab(String(id), String(p ?? ''))),
    );
    handle('ai:harness:tab-cancel', (id) => this.cancelTab(String(id)));
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
};

function isScript(bin: string) {
  return bin.endsWith('.mjs') || bin.endsWith('.js');
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
