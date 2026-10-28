/**
 * 编程助手进度监视：只读本机 Codex / Claude Code / dsh / Grok / Gemini CLI
 * 已暴露的日志与会话文件，状态变化时通过看板娘气泡提醒。绝不刮取远端账号。
 * 同时汇总 Nomi 自己的对话标签（实时状态优先于文件推断），在一个列表里展示所有端点。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sendMascotCommand } from '../ai/mascotCommand';
import type { AppEvents } from '../core/appEvents';
import type { DesktopNotice, DesktopService } from '../desktop/DesktopService';
import { t as tr } from '../i18n';

import { ScanCache } from './fsScan';
import {
  type AgentKind,
  type AgentStatus,
  type LastPhase,
  type SessionInfo,
  decideStatus,
  parseClaudeSession,
  parseCodexSession,
  parseDshProjcache,
  parseGeminiSession,
} from './parsers';
import { type AgentProc, listAgentProcesses, readLockedInodesAsync } from './processes';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export interface AgentWatchSettings {
  enabled: boolean;
  /** 多久无写入视为卡住 */
  stallMs: number;
  /** 同工具同状态最短提醒间隔 */
  cooldownMs: number;
  /** 编程助手消息语音播报：朗读任务提示文字（语音走 TTS，默认关） */
  summaryEnabled: boolean;
  tools: Record<AgentKind, boolean>;
}

export const DEFAULT_AGENT_WATCH: AgentWatchSettings = {
  enabled: true,
  stallMs: 5 * 60_000,
  cooldownMs: 90_000,
  summaryEnabled: false,
  tools: {
    codex: true,
    claude: true,
    dsh: true,
    grok: true,
    gemini: true,
  },
};

/** 监听开启后，每隔多久汇总一次「还有几个任务进行中」 */
export const DIGEST_INTERVAL_MS = 10 * 60_000;
/** 刚发过结束 / 权限 / 卡住等提示后的这段时间内跳过汇总，避免刷屏 */
export const DIGEST_QUIET_AFTER_REMIND_MS = 60_000;
/** 汇总里最多逐条列出几个任务的进度（消息语音播报开启时） */
const DIGEST_MAX_DETAIL = 2;

/** 已结束的会话在列表里保留多久 */
export const ENDED_VISIBLE_MS = 30 * 60_000;
/** 进程存活匹配时考虑多久内写过的会话文件（等你回复的会话可能挂很久） */
const ALIVE_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
const MAX_FILES_PER_KIND = 60;
/**
 * 冷文件（超过 ALIVE_LOOKBACK_MS 没写过）平时用缓存的 mtime，每隔这么久整体重新 stat 一次：
 * 续写很久以前的会话（resume）最迟这么久后被发现。
 */
const FULL_RESTAT_MS = 60_000;

export interface AgentSessionView {
  id: string;
  /** 'nomi' = Nomi 主对话标签（Nomi 后端） */
  kind: AgentKind | 'nomi';
  /** 来源：本机会话文件 / Nomi 对话标签 */
  source?: 'file' | 'tab';
  /** source = tab 时的标签 id */
  tabId?: string;
  /** source = tab 时的未读结果数 */
  unread?: number;
  /** 工具名 */
  label: string;
  /** 项目目录名（cwd basename） */
  project?: string;
  cwd?: string;
  /** 会话标题：第一条用户提问 → 项目名 → cwd */
  title: string;
  status: AgentStatus;
  /** 最后一步的描述 */
  summary?: string;
  /** 进程是否在跑（undefined = 无法判断） */
  alive?: boolean;
  path: string;
  /** 最后活动时间（文件写入 / 事件时间戳） */
  mtime: number;
  updatedAt: number;
  /** 这个会话累计的 Token / 费用（用量统计开着、且能对上会话时才有） */
  usage?: SessionUsageView;
}

/** 会话累计用量（来自用量统计；costUsd 为 null = 全部来自未定价模型） */
export interface SessionUsageView {
  tokens: number;
  costUsd: number | null;
  calls: number;
  unpriced: boolean;
}

export interface AgentWatchState {
  settings: AgentWatchSettings;
  sessions: AgentSessionView[];
  detected: AgentKind[];
  lastRemindAt: number;
}

interface Tracked extends AgentSessionView {
  lastRemindStatus?: AgentStatus;
  lastRemindAt: number;
}

interface Candidate {
  key: string;
  kind: AgentKind;
  path: string;
  mtime: number;
  info: SessionInfo;
  /** dsh：session.lock 是否被持有（undefined = 无法判断） */
  lockHeld?: boolean;
}

type Deps = {
  root: string;
  logger: Logger;
  /** 进度变化通知界面（ai:agents:changed） */
  events: AppEvents;
  desktop: DesktopService;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** 测试注入：返回编程助手进程；null = 无法判断 */
  processes?: () => AgentProc[] | null;
  platform?: NodeJS.Platform;
  /** dsh 家目录（默认 DSH_HOME 或 ~/.dsh） */
  dshHome?: string;
  /** Grok 家目录（默认 GROK_HOME 或 ~/.grok） */
  grokHome?: string;
  /** 测试注入：被 flock 持有的 inode；null = 无法判断 */
  lockedInodes?: () => Set<number> | null | Promise<Set<number> | null>;
  /** 免打扰中：定时汇总不弹（结束 / 权限提示不受影响） */
  isQuiet?: () => boolean;
  /** 汇总间隔（默认 DIGEST_INTERVAL_MS），测试可调 */
  digestMs?: number;
  /** 会话累计用量（CodingMonitor 显示）；source = claude / codex / dsh */
  usageOf?: (source: string, session: string) => SessionUsageView | null;
  /** 任务结束播报附带的「本次花费」一句话；消息语音播报开着时才会调用 */
  taskCost?: (q: { source: string; session?: string; since: number }) => Promise<string | null>;
};

/** Nomi 对话标签（来自 CliHarnessService），避免 agents 依赖 cli 模块 */
export interface WatchedTab {
  id: string;
  title: string;
  backend: 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok' | 'gemini';
  cwd: string;
  cliSessionId: string | null;
  status: 'idle' | 'queued' | 'running' | 'error';
  unread: number;
  updatedAt: number;
  lastError?: string;
  /** 这一轮最近的输出 / 步骤（轻量进度提示，可选） */
  progress?: string;
}

/** 某个端点的一轮结束 / 需要注意（由 harness 推送） */
export interface EndpointFinished {
  tabId: string;
  title: string;
  backend: WatchedTab['backend'];
  ok: boolean;
  text: string;
  error?: string;
  background: boolean;
}

/** Claude 工具权限待确认（由 harness 推送） */
export interface EndpointPermissionNeeded {
  tabId: string;
  title: string;
  backend: WatchedTab['backend'];
  summary: string;
  background: boolean;
}

const LABEL: Record<AgentKind, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  dsh: 'dsh',
  grok: 'Grok',
  gemini: 'Gemini CLI',
};

const REMIND: Record<AgentStatus, (label: string, summary?: string) => string> = {
  running: (l, s) => tr('electron.common.is-still-busy', l, s || tr('electron.common.working')),
  completed: (l, s) => tr('electron.common.is-done', l, s ? ` ${s}` : ''),
  failed: (l, s) =>
    tr('electron.common.hit-an-error', l, s || tr('electron.common.check-the-terminal')),
  stalled: (l) => tr('electron.common.seems-stuck-want-to-take-a-look', l),
  waiting: (l) => tr('electron.common.finished-this-turn-and-is-waiting-for-you', l),
  idle: () => '',
};

/** 读文件开头 / 结尾若干字节，不把几十 MB 的 JSONL 整个读进内存（同步版，轮询里用 ScanCache.readSlice） */
export function readSlice(p: string, which: 'head' | 'tail', bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, which === 'head' ? 0 : size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function sanitizeAgentWatch(raw: unknown, base = DEFAULT_AGENT_WATCH): AgentWatchSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentWatchSettings>;
  const tools = { ...base.tools, ...(o.tools ?? {}) };
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const n = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  return {
    enabled: b(o.enabled, base.enabled),
    stallMs: n(o.stallMs, base.stallMs),
    cooldownMs: n(o.cooldownMs, base.cooldownMs),
    summaryEnabled: b(o.summaryEnabled, base.summaryEnabled),
    tools: {
      codex: b(tools.codex, true),
      claude: b(tools.claude, true),
      dsh: b(tools.dsh, true),
      grok: b(tools.grok, true),
      gemini: b(tools.gemini, true),
    },
  };
}

export class AgentProgressService {
  private settings: AgentWatchSettings = {
    ...DEFAULT_AGENT_WATCH,
    tools: { ...DEFAULT_AGENT_WATCH.tools },
  };
  private tracked = new Map<string, Tracked>();
  /** 上次广播时的会话快照签名：tick 结果没变就不广播（否则每个轮询周期都让渲染进程回拉一次） */
  private trackedSig = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private lastRemindAt = 0;
  private readonly home: string;
  private readonly now: () => number;
  private readonly pollMs: number;
  /** 会话 / 标签这一轮开始跑的时间（算「本次花费」的起点） */
  private readonly runStart = new Map<string, number>();
  private readonly digestMs: number;
  private readonly settingsPath: string;
  /** 最近一次进程快照（异步刷新）；null = 无法判断 */
  private procs: AgentProc[] | null = null;
  private procsAt = 0;
  private procRefreshing = false;
  private readonly dshHome: string;
  private readonly grokHome: string;
  /** 本轮 tick 的 flock 快照（dsh）；null = 无法判断 */
  private dshLocks: Set<number> | null = null;
  /**
   * 会话文件解析结果（路径 → mtime + 结果）：文件没动就不再读头尾、重新解析。
   * 每 8 秒一轮，近 3 天的会话文件逐个读 128KB 再解析会占主进程几十毫秒。dsh 依赖本轮锁快照，不缓存
   * （它的会话索引解析结果由 ScanCache.readParsed 按文件 mtime / size 缓存）。
   */
  private readonly inspected = new Map<string, { mtime: number; cand: Candidate }>();
  /** 目录列表 / 文件 mtime 缓存 + 异步并发池（轮询不在主进程同步遍历会话目录） */
  private readonly scan = new ScanCache();
  private lastFullRestatAt = 0;
  /** 进行中的一轮 tick；轮询定时器到点时它还没跑完就跳过这一拍 */
  private ticking: Promise<void> | null = null;
  /** tick 进行中又被调用（手动刷新 / 首次进程快照）：跑完后再补一轮 */
  private tickAgain: { refresh: boolean } | null = null;
  private tabs: () => WatchedTab[] = () => [];
  private tabProgress: (tabId: string) => string | undefined = () => undefined;

  constructor(private readonly d: Deps) {
    this.home = d.home ?? os.homedir();
    this.dshHome =
      d.dshHome ??
      (process.env.DSH_HOME?.trim()
        ? path.resolve(process.env.DSH_HOME)
        : path.join(this.home, '.dsh'));
    this.grokHome =
      d.grokHome ??
      (process.env.GROK_HOME?.trim()
        ? path.resolve(process.env.GROK_HOME)
        : path.join(this.home, '.grok'));
    this.now = d.now ?? (() => Date.now());
    this.pollMs = d.pollMs ?? 8_000;
    this.digestMs = d.digestMs ?? DIGEST_INTERVAL_MS;
    this.settingsPath = path.join(d.root, 'settings.json');
    fs.mkdirSync(d.root, { recursive: true });
    this.load();
  }

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as unknown;
      this.settings = sanitizeAgentWatch(raw);
    } catch {
      this.settings = sanitizeAgentWatch({});
    }
  }

  private save() {
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  state(): AgentWatchState {
    const tabs = this.safeTabs();
    // 由 Nomi 标签驱动的 CLI 会话：标签的实时状态优先，隐藏对应的文件推断条目
    const owned = new Set(
      tabs.filter((t) => t.cliSessionId).map((t) => `${t.backend}:${t.cliSessionId}`),
    );
    const sessions = [...this.tracked.values()]
      .filter((v) => !owned.has(v.id))
      .map(({ lastRemindAt: _a, lastRemindStatus: _b, ...v }): AgentSessionView => ({
        ...v,
        source: 'file',
      }))
      .concat(tabs.map((t) => tabView(t)))
      .map((v) => this.withUsage(v, tabs))
      .sort((a, b) => rank(a.status) - rank(b.status) || b.mtime - a.mtime);
    return {
      settings: this.settings,
      sessions,
      detected: this.detectKinds(),
      lastRemindAt: this.lastRemindAt,
    };
  }

  /** 附上会话累计用量：文件会话按「工具:会话 id」对，Nomi 标签按它接管的 CLI 会话 id 对 */
  private withUsage(v: AgentSessionView, tabs: WatchedTab[]): AgentSessionView {
    const of = this.d.usageOf;
    if (!of) return v;
    let source: string | undefined;
    let session: string | undefined;
    if (v.source === 'tab') {
      const t = tabs.find((x) => x.id === v.tabId);
      source = t?.backend;
      session = t?.cliSessionId ?? undefined;
    } else {
      source = v.kind;
      session = v.id.startsWith(`${v.kind}:`) ? v.id.slice(v.kind.length + 1) : undefined;
    }
    if (!source || !session || !USAGE_KINDS.has(source)) return v;
    try {
      const usage = of(source, session);
      return usage ? { ...v, usage } : v;
    } catch {
      return v;
    }
  }

  setSettings(
    patch: Partial<AgentWatchSettings> & { tools?: Partial<Record<AgentKind, boolean>> },
  ) {
    this.settings = sanitizeAgentWatch({
      ...this.settings,
      ...patch,
      tools: { ...this.settings.tools, ...(patch.tools ?? {}) },
    });
    this.save();
    if (this.settings.enabled) this.start();
    else this.stop();
    this.broadcast();
    return this.settings;
  }

  detectKinds(): AgentKind[] {
    const h = this.home;
    const found: AgentKind[] = [];
    if (fs.existsSync(path.join(h, '.codex'))) found.push('codex');
    if (fs.existsSync(path.join(h, '.claude'))) found.push('claude');
    if (fs.existsSync(path.join(this.dshHome, 'sessions'))) found.push('dsh');
    if (fs.existsSync(path.join(this.grokHome, 'sessions'))) found.push('grok');
    if (fs.existsSync(path.join(h, '.gemini'))) found.push('gemini');
    return found;
  }

  /** 扫描本机已知路径，返回候选会话文件（每种工具按 mtime 倒序） */
  async scanFiles(): Promise<Array<{ kind: AgentKind; path: string; mtime: number }>> {
    const h = this.home;
    const { tools } = this.settings;
    const now = this.now();
    const full = now - this.lastFullRestatAt >= FULL_RESTAT_MS || now < this.lastFullRestatAt;
    const o = { now, hotMs: ALIVE_LOOKBACK_MS, full };
    const jobs: Array<Promise<Array<{ kind: AgentKind; path: string; mtime: number }>>> = [];
    const add = (
      kind: AgentKind,
      dir: string,
      pred: (n: string, full: string) => boolean,
      depth: number,
      limit = MAX_FILES_PER_KIND,
    ) =>
      jobs.push(
        this.scan
          .listFiles(dir, pred, depth, limit, o)
          .then((list) => list.map((f) => ({ kind, ...f }))),
      );
    this.scan.begin();
    if (tools.codex)
      add('codex', path.join(h, '.codex', 'sessions'), (n) => n.endsWith('.jsonl'), 4);
    if (tools.claude)
      add('claude', path.join(h, '.claude', 'projects'), (n) => n.endsWith('.jsonl'), 3);
    if (tools.dsh)
      // $DSH_HOME/sessions/<编码后的 cwd>/session-<uuid>/{session.lock, session.v4.jsonl.zstd}
      add(
        'dsh',
        path.join(this.dshHome, 'sessions'),
        (n) => n === 'session.lock' || /^session\.v\d+\.jsonl/.test(n),
        2,
      );
    if (tools.grok)
      // ~/.grok/sessions/<cwd>/<uuid>/updates.jsonl — 用 mtime 推断活跃；细解析见用量模块
      add('grok', path.join(this.grokHome, 'sessions'), (n) => n === 'updates.jsonl', 3);
    if (tools.gemini)
      add(
        'gemini',
        path.join(h, '.gemini', 'tmp'),
        // 0.62 起是 .jsonl；旧版 .json
        (n, fp) => /^session-.*\.jsonl?$/.test(n) && fp.includes(`${path.sep}chats${path.sep}`),
        3,
      );
    // 各工具并发扫，结果按固定顺序拼接（与同步实现一致）
    const out = (await Promise.all(jobs)).flat();
    this.scan.end();
    if (full) this.lastFullRestatAt = now;
    return out;
  }

  private async inspectCached(
    kind: AgentKind,
    filePath: string,
    mtime: number,
  ): Promise<Candidate> {
    if (kind === 'dsh') return this.inspect(kind, filePath, mtime);
    const hit = this.inspected.get(filePath);
    if (hit && hit.mtime === mtime && hit.cand.kind === kind) return hit.cand;
    const cand = await this.inspect(kind, filePath, mtime);
    this.inspected.set(filePath, { mtime, cand });
    return cand;
  }

  /** 解析一个文件 → 候选会话（含去重 key） */
  private async inspect(kind: AgentKind, filePath: string, mtime: number): Promise<Candidate> {
    const slice = (p: string, which: 'head' | 'tail', bytes: number) =>
      this.scan.readSlice(p, which, bytes);
    let info: SessionInfo;
    if (kind === 'claude') {
      info = parseClaudeSession(
        await slice(filePath, 'head', 32 * 1024),
        await slice(filePath, 'tail', 96 * 1024),
      );
      // 子代理：<project>/<sessionId>/subagents/agent-*.jsonl → 并入父会话
      const parts = filePath.split(path.sep);
      const si = parts.lastIndexOf('subagents');
      if (si > 0) info.parentId = parts[si - 1];
      info.sessionId ??= path.basename(filePath, '.jsonl');
    } else if (kind === 'codex') {
      info = parseCodexSession(
        await slice(filePath, 'head', 32 * 1024),
        await slice(filePath, 'tail', 96 * 1024),
      );
      info.sessionId ??=
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
          filePath,
        )?.[1];
    } else if (kind === 'dsh') {
      const dir = path.dirname(filePath);
      const id = path.basename(dir);
      // 会话索引（最多 256KB）按 (mtime, size) 缓存解析结果：没变就不重读；
      // 同一会话的 session.lock 与 session.v*.jsonl 在同一轮里共用一次读取
      const meta = await this.scan.readParsed(
        path.join(this.dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`),
        256 * 1024,
        parseDshProjcache,
      );
      const lock = await this.scan.stat(path.join(dir, 'session.lock'));
      const lockHeld = this.dshLocks && lock ? this.dshLocks.has(lock.ino) : undefined;
      info = {
        ...meta,
        sessionId: id,
        // 锁被持有 = 正在写；锁空闲 = 这一轮已提交；无法判断时按写入时间推断
        phase: lockHeld === false ? 'turn-done' : 'working',
        detail: lockHeld ? tr('electron.common.running') : undefined,
      };
      return { key: `dsh:${id}`, kind, path: filePath, mtime, info, lockHeld };
    } else if (kind === 'grok') {
      // 会话目录名即 uuid；不深读 ACP 内容（用量走 updates.jsonl 解析器）
      const dir = path.dirname(filePath);
      const id = path.basename(dir);
      let cwd: string | undefined;
      try {
        cwd = decodeURIComponent(path.basename(path.dirname(dir)));
      } catch {
        cwd = path.basename(path.dirname(dir));
      }
      info = { phase: 'working', sessionId: id, cwd };
      return { key: `grok:${id}`, kind, path: filePath, mtime, info };
    } else {
      // gemini：.jsonl 逐行追加：标题在开头、最新状态在末尾，各取一段拼起来（按消息 id 去重）
      info = parseGeminiSession(
        filePath.endsWith('.jsonl')
          ? `${await slice(filePath, 'head', 64 * 1024)}\n${await slice(filePath, 'tail', 512 * 1024)}`
          : await slice(filePath, 'head', 4 * 1024 * 1024),
      );
    }
    const sid = info.parentId ?? info.sessionId ?? filePath;
    return { key: `${kind}:${sid}`, kind, path: filePath, mtime, info };
  }

  /** 同一会话 id 的多个文件（主文件 + 子代理）合并成一个 */
  private dedupe(cands: Candidate[]): Candidate[] {
    const by = new Map<string, Candidate>();
    for (const c of cands) {
      const prev = by.get(c.key);
      if (!prev) {
        by.set(c.key, { ...c, info: { ...c.info } });
        continue;
      }
      const isMain = !c.info.parentId || c.info.parentId === c.info.sessionId;
      const newer = c.mtime > prev.mtime;
      const merged: Candidate = newer ? { ...c, info: { ...c.info } } : prev;
      merged.lockHeld = c.lockHeld ?? prev.lockHeld;
      // 标题 / cwd 以主会话为准
      merged.info.title = (isMain ? c.info.title : undefined) ?? prev.info.title ?? c.info.title;
      merged.info.cwd = prev.info.cwd ?? c.info.cwd;
      if (isMain) merged.path = c.path;
      else if (!newer) merged.path = prev.path;
      merged.mtime = Math.max(prev.mtime, c.mtime);
      by.set(c.key, merged);
    }
    return [...by.values()];
  }

  /**
   * 进程 → 会话：每个进程只「认领」一个会话。
   * 先按 cwd 精确匹配（取该 cwd 下最新的会话），拿不到 cwd 的进程再认领同类最新的未认领会话。
   */
  private matchAlive(
    cands: Candidate[],
    procs: AgentProc[] | null,
  ): Map<string, boolean | undefined> {
    const res = new Map<string, boolean | undefined>();
    if (!procs) {
      for (const c of cands) res.set(c.key, c.kind === 'dsh' ? c.lockHeld : undefined);
      return res;
    }
    const now = this.now();
    const sorted = [...cands].sort((a, b) => b.mtime - a.mtime);
    const claimed = new Set<string>();
    const norm = (p?: string) =>
      p
        ? path
            .resolve(p)
            .replace(/[\\/]+$/, '')
            .toLowerCase()
        : '';
    const pending: AgentProc[] = [];
    for (const p of procs) {
      const pc = norm(p.cwd);
      const hit = pc
        ? sorted.find(
            (c) =>
              c.kind === p.kind &&
              !claimed.has(c.key) &&
              now - c.mtime < ALIVE_LOOKBACK_MS &&
              norm(c.info.cwd) === pc,
          )
        : undefined;
      if (hit) claimed.add(hit.key);
      else pending.push(p);
    }
    for (const p of pending) {
      const hit = sorted.find(
        (c) =>
          c.kind === p.kind &&
          !claimed.has(c.key) &&
          now - c.mtime < ALIVE_LOOKBACK_MS &&
          // 知道进程 cwd 却对不上：只在会话没记录 cwd 时兜底认领
          (!p.cwd || !c.info.cwd),
      );
      if (hit) claimed.add(hit.key);
    }
    for (const c of cands) {
      if (c.kind === 'dsh' && c.lockHeld !== undefined) res.set(c.key, c.lockHeld);
      else res.set(c.key, claimed.has(c.key));
    }
    return res;
  }

  /** 异步刷新进程快照（Windows 的 PowerShell 可能要 1s+，不阻塞 tick） */
  private refreshProcs(): void {
    if (this.d.processes) {
      this.procs = this.d.processes();
      this.procsAt = this.now();
      return;
    }
    if (this.procRefreshing) return;
    this.procRefreshing = true;
    void listAgentProcesses(this.d.platform)
      .then((p) => {
        const first = this.procsAt === 0;
        this.procs = p;
        this.procsAt = this.now();
        if (first)
          this.tick(false).catch((e) => this.d.logger.warn('agent-progress tick', String(e)));
      })
      .finally(() => {
        this.procRefreshing = false;
      });
  }

  /**
   * 扫一轮会话文件并更新列表。异步执行、不重叠：进行中再被调用时只记下「跑完再补一轮」，
   * 返回的 Promise 在补的那轮也结束后才完成。
   */
  tick(refresh = true): Promise<void> {
    if (!this.settings.enabled) return Promise.resolve();
    if (this.ticking) {
      this.tickAgain = { refresh: refresh || !!this.tickAgain?.refresh };
      return this.ticking;
    }
    const run = async () => {
      let r = refresh;
      for (;;) {
        await this.tickOnce(r);
        const again = this.tickAgain;
        this.tickAgain = null;
        if (!again || !this.settings.enabled) return;
        r = again.refresh;
      }
    };
    this.ticking = run().finally(() => {
      this.ticking = null;
      this.tickAgain = null;
    });
    return this.ticking;
  }

  private async tickOnce(refresh: boolean): Promise<void> {
    if (!this.settings.enabled) return;
    if (refresh) this.refreshProcs();
    const now = this.now();
    const locks = this.settings.tools.dsh
      ? (this.d.lockedInodes ?? (() => readLockedInodesAsync(this.d.platform)))()
      : null;
    const [lockSet, scanned] = await Promise.all([locks, this.scanFiles()]);
    this.dshLocks = lockSet;
    const files = scanned.filter((f) => now - f.mtime < ALIVE_LOOKBACK_MS);
    const cands = this.dedupe(
      await Promise.all(files.map((f) => this.inspectCached(f.kind, f.path, f.mtime))),
    );
    // 扫描期间监听被关掉：结果作废
    if (!this.settings.enabled) return;
    if (this.inspected.size > files.length) {
      const live = new Set(files.map((f) => f.path));
      for (const p of this.inspected.keys()) if (!live.has(p)) this.inspected.delete(p);
    }
    // 首次进程快照还没回来：先不判定（避免把所有历史会话当成在跑）
    const procs = this.procsAt === 0 ? null : this.procs;
    const alive = this.matchAlive(cands, procs);
    const seen = new Set<string>();

    for (const c of cands) {
      const isAlive = alive.get(c.key);
      const lastAt = Math.max(c.mtime, c.info.lastAt && c.info.lastAt <= now ? c.info.lastAt : 0);
      const age = now - c.mtime;
      const phase: LastPhase = c.info.phase;
      const status = decideStatus({
        phase,
        alive: isAlive,
        ageMs: age,
        stallMs: this.settings.stallMs,
      });
      // 可见性：进程在跑的会话总是显示；其余只显示最近 ENDED_VISIBLE_MS 内有活动的
      const visible = isAlive === true || now - lastAt < ENDED_VISIBLE_MS;
      if (!visible) continue;
      // 进程状态未知时，太久没动的「idle」也不显示
      if (isAlive === undefined && status === 'idle' && age > this.settings.stallMs) continue;

      seen.add(c.key);
      const prev = this.tracked.get(c.key);
      const project = c.info.cwd ? path.basename(c.info.cwd) : undefined;
      const title = c.info.title || project || c.info.cwd || LABEL[c.kind];
      const next: Tracked = {
        id: c.key,
        kind: c.kind,
        label: LABEL[c.kind],
        project,
        cwd: c.info.cwd,
        title,
        status,
        summary: c.info.detail,
        alive: isAlive,
        path: c.path,
        mtime: lastAt,
        updatedAt: now,
        lastRemindStatus: prev?.lastRemindStatus,
        lastRemindAt: prev?.lastRemindAt ?? 0,
      };
      this.tracked.set(c.key, next);
      if (next.status === 'running' && !this.runStart.has(c.key))
        this.runStart.set(c.key, now - 2 * this.pollMs);
      this.maybeRemind(prev, next);
      if (next.status !== 'running') this.runStart.delete(c.key);
    }

    for (const id of [...this.tracked.keys()]) {
      if (!seen.has(id)) {
        this.tracked.delete(id);
        this.runStart.delete(id);
      }
    }
    const sig = JSON.stringify(
      [...this.tracked.values()].map(
        ({ updatedAt: _u, lastRemindAt: _a, lastRemindStatus: _b, ...v }) => v,
      ),
    );
    if (sig === this.trackedSig) return;
    this.trackedSig = sig;
    this.broadcast();
  }

  private maybeRemind(prev: Tracked | undefined, next: Tracked) {
    // 「开始 / 进行中」不主动打扰（气泡 / 语音 / 音效 / 灵动岛都不弹）：
    // 只在 CodingMonitor 面板被动展示，并由定时汇总告知还有几个在跑
    if (next.status === 'idle' || next.status === 'running') return;
    // 首次发现的历史 / 等待 / 卡住都不打扰（启动时不刷屏）
    if (!prev) return;
    // 等你回复：只在刚从 running 切过来时提醒
    if (next.status === 'waiting' && prev.status !== 'running') return;
    const changed = prev.status !== next.status;
    if (!changed && next.status !== 'stalled') return;
    if (
      next.lastRemindStatus === next.status &&
      nowGap(next.lastRemindAt, this.now()) < this.settings.cooldownMs
    )
      return;

    const who = next.project ? `${next.label}（${next.project}）` : next.label;
    const finished = next.status === 'completed' || next.status === 'failed';
    const voice = this.settings.summaryEnabled;
    const summary = voice && finished;
    const text = summary
      ? finishSummary(next.label, next.title, next.status === 'completed', next.summary)
      : REMIND[next.status](who, next.summary);
    if (!text) return;
    this.sayWithCost(
      text,
      {
        endpoint: next.kind,
        status:
          next.status === 'failed'
            ? 'failed'
            : next.status === 'stalled' || next.status === 'waiting'
              ? 'attention'
              : 'done',
        title: who,
        body: next.title,
        bubble: agentBubbleOpts(next.status, voice),
      },
      finished && USAGE_KINDS.has(next.kind) && this.runStart.has(next.id)
        ? {
            source: next.kind,
            session: next.id.slice(next.kind.length + 1),
            since: this.runStart.get(next.id)!,
          }
        : undefined,
    );
    sendMascotCommand(this.d.events, {
      type: 'motion',
      name: next.status === 'failed' || next.status === 'stalled' ? 'sorry' : 'thumbs_up',
    });
    next.lastRemindStatus = next.status;
    next.lastRemindAt = this.now();
    this.lastRemindAt = next.lastRemindAt;
    this.tracked.set(next.id, next);
    this.d.logger.info('agent-progress remind', { kind: next.kind, status: next.status });
  }

  /**
   * 接入 Nomi 对话标签：标签列表并入监视视图；任一端点一轮结束 / 出错时
   * 看板娘说话 + 动作，灵动岛按端点显示事件。
   */
  attachHarness(h: {
    tabs: () => WatchedTab[];
    onTabs: (fn: () => void) => void;
    onFinished: (fn: (e: EndpointFinished) => void) => void;
    onPermission?: (fn: (e: EndpointPermissionNeeded) => void) => void;
    /** 标签这一轮最近的输出 / 步骤（轻量进度提示，没有则不传） */
    progress?: (tabId: string) => string | undefined;
  }): void {
    this.tabs = h.tabs;
    this.tabProgress = h.progress ?? (() => undefined);
    h.onTabs(() => {
      const now = this.now();
      for (const t of this.safeTabs())
        if ((t.status === 'running' || t.status === 'queued') && !this.runStart.has(`tab:${t.id}`))
          this.runStart.set(`tab:${t.id}`, now);
      this.broadcast();
    });
    h.onFinished((e) => this.onEndpointFinished(e));
    h.onPermission?.((e) => this.onPermissionNeeded(e));
  }

  private safeTabs(): WatchedTab[] {
    try {
      return this.tabs();
    } catch {
      return [];
    }
  }

  /**
   * 工具权限待确认：看板娘在 → 气泡 + 思考动作；不在 → 灵动岛 attention（或系统通知）。
   * 前台也提醒（对话区已有卡片，这里是二次提示）。
   */
  onPermissionNeeded(e: EndpointPermissionNeeded): void {
    if (!this.settings.enabled) return;
    if (e.backend !== 'nomi' && !this.settings.tools[e.backend as AgentKind]) return;
    const label = ENDPOINT_LABEL[e.backend];
    const who = `${label}（${e.title}）`;
    const brief = (e.summary || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const text = tr(
      'electron.common.needs-tool-permission',
      who,
      brief || tr('electron.common.allow-or-deny-in-the-chat'),
    );
    this.d.desktop.notify({
      kind: 'agent',
      endpoint: e.backend,
      status: 'attention',
      title: who,
      body: brief || tr('electron.common.tool-permission-required'),
      text: text.slice(0, 140),
      bubble: { voice: this.settings.summaryEnabled ? 'full' : 'cue' },
    });
    sendMascotCommand(this.d.events, { type: 'motion', name: 'think' });
    this.lastRemindAt = this.now();
    this.d.logger.info('agent-progress permission needed', {
      backend: e.backend,
      background: e.background,
    });
    this.broadcast();
  }

  /** 端点一轮结束：前台正看着这个标签就不打扰 */
  onEndpointFinished(e: EndpointFinished): void {
    if (!e.background) return;
    if (!this.settings.enabled) return;
    if (e.backend !== 'nomi' && !this.settings.tools[e.backend]) return;
    const label = ENDPOINT_LABEL[e.backend];
    const who = `${label}（${e.title}）`;
    const brief = (e.ok ? e.text : e.error || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const voice = this.settings.summaryEnabled;
    const summary = voice;
    const text = summary
      ? finishSummary(label, e.title, e.ok, e.ok ? e.text : e.error)
      : e.ok
        ? REMIND.completed(who, brief)
        : REMIND.failed(who, brief);
    const since = this.runStart.get(`tab:${e.tabId}`);
    this.runStart.delete(`tab:${e.tabId}`);
    const tab = this.safeTabs().find((t) => t.id === e.tabId);
    this.sayWithCost(
      text,
      {
        endpoint: e.backend,
        status: e.ok ? 'done' : 'failed',
        title: who,
        body:
          brief ||
          (e.ok
            ? tr('electron.common.this-turn-is-done')
            : tr('electron.common.something-went-wrong')),
        bubble: agentBubbleOpts(e.ok ? 'completed' : 'failed', voice),
      },
      since === undefined
        ? undefined
        : e.backend === 'nomi'
          ? { source: 'nomi', since }
          : tab?.cliSessionId
            ? { source: e.backend, session: tab.cliSessionId, since }
            : undefined,
    );
    sendMascotCommand(this.d.events, { type: 'motion', name: e.ok ? 'thumbs_up' : 'sorry' });
    this.lastRemindAt = this.now();
    this.d.logger.info('agent-progress endpoint finished', { backend: e.backend, ok: e.ok });
    this.broadcast();
  }

  /**
   * 发出结束 / 状态提醒（看板娘在 → 气泡，不在 → 灵动岛或系统通知）。消息语音播报开着且能查到
   * 「本次花费」时，在气泡末尾补一句（最多等 3 秒，查不到 / 超时就照常发原文，不让提醒被用量统计拖住）。
   */
  private sayWithCost(
    text: string,
    n: Omit<DesktopNotice, 'kind' | 'text'>,
    q?: { source: string; session?: string; since: number },
  ): void {
    const send = (cost: string | null) => {
      this.d.desktop.notify({ ...n, kind: 'agent', text: withCost(text, cost) });
    };
    if (!q || !this.settings.summaryEnabled || !this.d.taskCost) return send(null);
    let done = false;
    const once = (cost: string | null) => {
      if (done) return;
      done = true;
      send(cost);
    };
    const timer = setTimeout(() => once(null), COST_WAIT_MS);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    this.d
      .taskCost(q)
      .then(
        (c) => once(c),
        () => once(null),
      )
      .finally(() => clearTimeout(timer));
  }

  private broadcast() {
    this.d.events.publish('ai:agents:changed', null);
  }

  start(): void {
    if (this.timer) return;
    const warn = (e: unknown) => this.d.logger.warn('agent-progress tick', String(e));
    // 第一轮异步跑：不在启动路径上同步遍历会话目录
    this.tick().catch(warn);
    this.timer = setInterval(() => {
      // 上一轮还没扫完（会话很多 / 磁盘慢）就跳过这一拍，不叠加
      if (this.ticking) return;
      this.tick().catch(warn);
    }, this.pollMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
    this.startDigest();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopDigest();
  }

  private startDigest(): void {
    if (this.digestTimer) return;
    this.digestTimer = setInterval(() => {
      try {
        this.digest();
      } catch (e) {
        this.d.logger.warn('agent-progress digest', String(e));
      }
    }, this.digestMs);
    if (typeof this.digestTimer === 'object' && 'unref' in this.digestTimer)
      this.digestTimer.unref();
  }

  private stopDigest(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
  }

  /**
   * 定时汇总：按最近一轮轮询的结果（最多旧一个轮询周期）与对话标签的实时状态，
   * 若有进行中的编程任务，被动告知「还有 N 个任务进行中」
   * （按工具分组）。消息语音播报开启时附带最近进度并朗读；关闭时只出气泡 / 灵动岛。
   * 0 个不提示；刚发过结束 / 权限等提示、免打扰中也跳过。返回是否发出了汇总。
   */
  digest(): boolean {
    if (!this.settings.enabled) return false;
    const running = this.runningTasks();
    if (!running.length) return false;
    if (this.d.isQuiet?.()) return false;
    if (this.lastRemindAt && nowGap(this.lastRemindAt, this.now()) < DIGEST_QUIET_AFTER_REMIND_MS)
      return false;

    const groups = new Map<string, number>();
    for (const r of running) groups.set(r.label, (groups.get(r.label) ?? 0) + 1);
    const breakdown = [...groups].map(([l, n]) => `${l} ${n}`).join(' · ');
    const head = tr('electron.common.coding-task-s-still-in-progress', running.length, breakdown);
    const summary = this.settings.summaryEnabled;
    let text = head;
    if (summary) {
      const lines = running
        .slice(0, DIGEST_MAX_DETAIL)
        .map((r) => {
          const step = brief(r.summary, 36);
          return step ? `「${brief(r.title, 16)}」${step}` : `「${brief(r.title, 16)}」`;
        })
        .join('；');
      if (lines) text = `${head}：${lines}`;
    }
    const kinds = new Set(running.map((r) => r.kind));
    this.d.desktop.notify({
      kind: 'agent',
      endpoint: kinds.size === 1 ? [...kinds][0] : undefined,
      status: 'running',
      title: tr('electron.common.coding-task-s-in-progress', running.length),
      body: summary ? text.slice(head.length + 1) || breakdown : breakdown,
      text: text.slice(0, 140),
      bubble: { kind: 'digest', voice: summary ? 'full' : 'none' },
      passive: true,
    });
    this.d.logger.info('agent-progress digest', { running: running.length, summary });
    return true;
  }

  /** 进行中的编程任务（不含 Nomi 原生对话；已被关闭监视的工具不计） */
  private runningTasks(): Array<{ kind: string; label: string; title: string; summary?: string }> {
    return this.state()
      .sessions.filter((s) => s.status === 'running' && s.kind !== 'nomi')
      .filter((s) => this.settings.tools[s.kind as AgentKind] !== false)
      .map((s) => ({
        kind: s.kind,
        label: s.kind === 'nomi' ? s.label : LABEL[s.kind as AgentKind],
        title: s.title,
        summary:
          s.source === 'tab' && s.tabId ? (this.tabProgress(s.tabId) ?? s.summary) : s.summary,
      }));
  }

  /** 立刻扫描一轮再返回状态（设置页的「刷新」） */
  async scanNow(): Promise<AgentWatchState> {
    await this.tick();
    return this.state();
  }
}

const ENDPOINT_LABEL: Record<WatchedTab['backend'], string> = {
  nomi: 'Nomi',
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
  gemini: 'Gemini',
};

/** Nomi 标签 → 监视视图条目 */
export function tabView(t: WatchedTab): AgentSessionView {
  const status: AgentStatus =
    t.status === 'running' || t.status === 'queued'
      ? 'running'
      : t.status === 'error'
        ? 'failed'
        : t.unread > 0
          ? 'completed'
          : 'waiting';
  return {
    id: `tab:${t.id}`,
    kind: t.backend,
    source: 'tab',
    tabId: t.id,
    unread: t.unread,
    label: `Nomi · ${ENDPOINT_LABEL[t.backend]}`,
    project: t.cwd ? path.basename(t.cwd) : undefined,
    cwd: t.cwd,
    title: t.title,
    status,
    summary: t.status === 'queued' ? tr('electron.common.queued') : t.lastError,
    alive: t.status === 'running' || t.status === 'queued',
    path: '',
    mtime: t.updatedAt,
    updatedAt: t.updatedAt,
  };
}

const RANK: Record<AgentStatus, number> = {
  stalled: 0,
  failed: 1,
  running: 2,
  waiting: 3,
  completed: 4,
  idle: 5,
};
function rank(s: AgentStatus) {
  return RANK[s];
}

/** 压成一行短文本：去代码围栏 / 换行，超长截断加省略号 */
function brief(text: string | undefined, max: number): string {
  const v = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v.length > max ? `${v.slice(0, Math.max(1, max - 1))}…` : v;
}

/** 任务结束的完成总结：做了什么（任务标题）+ 结果成败 + 结果摘要 */
function finishSummary(label: string, title: string, ok: boolean, detail?: string): string {
  const task = brief(title, 24);
  const d = brief(detail, 60);
  return ok
    ? tr('electron.common.finished', label, task, d || tr('electron.common.completed-successfully'))
    : tr('electron.common.task-failed', label, task, d || tr('electron.common.check-the-terminal'));
}

/** 有会话级用量日志的工具 */
const USAGE_KINDS = new Set<string>(['claude', 'codex', 'dsh', 'grok', 'gemini']);
/** 等「本次花费」最多这么久，超时就照常播报 */
const COST_WAIT_MS = 3000;
const BUBBLE_MAX = 140;

/** 气泡文字加上「本次花费」一句：总长不超过 140，超出的部分截掉原文末尾 */
export function withCost(text: string, cost: string | null): string {
  if (!cost) return text.slice(0, BUBBLE_MAX);
  const room = BUBBLE_MAX - cost.length - 1;
  if (room <= 0) return cost.slice(0, BUBBLE_MAX);
  const head = text.length > room ? `${text.slice(0, Math.max(0, room - 1)).trimEnd()}…` : text;
  return `${head} ${cost}`;
}

/** 编程助手气泡的出声方式：开 → 朗读文字；关 → 只播放提示音 */
function agentBubbleOpts(
  status: AgentStatus,
  voice: boolean,
): { kind?: 'done' | 'fail'; voice?: 'full' | 'cue' } {
  const kind =
    status === 'completed' || status === 'failed'
      ? { kind: status === 'completed' ? ('done' as const) : ('fail' as const) }
      : {};
  return { ...kind, voice: voice ? 'full' : 'cue' };
}

function nowGap(from: number, to: number) {
  return Math.max(0, to - from);
}
