/**
 * 编程助手进度监视：只读本机 Codex / Claude Code / dsh / Aider / Cline / Continue / Cursor
 * 已暴露的日志与会话文件，状态变化时通过看板娘气泡提醒。绝不刮取远端账号。
 * 同时汇总 Nomi 自己的对话标签（实时状态优先于文件推断），在一个列表里展示所有端点。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, Notification } from 'electron';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import { iconImage } from '../core/appIcon';
import type { DesktopService } from '../desktop/DesktopService';
import { t as tr } from '../i18n';
import { notifyIsland } from '../island/IslandService';
import { guardedHandle } from '../security/guardedIpc';

import {
  type AgentKind,
  type AgentStatus,
  type LastPhase,
  type SessionInfo,
  decideStatus,
  parseAiderAnalytics,
  parseAiderHistory,
  parseClaudeSession,
  parseClineJob,
  parseCodexSession,
  parseContinueSession,
  parseDshProjcache,
  parseGeminiSession,
  phaseOf,
} from './parsers';
import { type AgentProc, listAgentProcesses, readLockedInodes } from './processes';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

export interface AgentWatchSettings {
  enabled: boolean;
  /** 多久无写入视为卡住 */
  stallMs: number;
  /** 同工具同状态最短提醒间隔 */
  cooldownMs: number;
  osNotify: boolean;
  /** 总结播报：定时汇总附带进度摘要、任务结束时播报完成总结（语音走 TTS，默认关） */
  summaryEnabled: boolean;
  tools: Record<AgentKind, boolean>;
}

export const DEFAULT_AGENT_WATCH: AgentWatchSettings = {
  enabled: true,
  stallMs: 5 * 60_000,
  cooldownMs: 90_000,
  osNotify: false,
  summaryEnabled: false,
  tools: {
    codex: true,
    claude: true,
    dsh: true,
    grok: true,
    aider: true,
    cline: true,
    continue: true,
    cursor: true,
    gemini: true,
  },
};

/** 监听开启后，每隔多久汇总一次「还有几个任务进行中」 */
export const DIGEST_INTERVAL_MS = 10 * 60_000;
/** 刚发过结束 / 权限 / 卡住等提示后的这段时间内跳过汇总，避免刷屏 */
export const DIGEST_QUIET_AFTER_REMIND_MS = 60_000;
/** 汇总里最多逐条列出几个任务的进度（总结播报开启时） */
const DIGEST_MAX_DETAIL = 2;

/** 已结束的会话在列表里保留多久 */
export const ENDED_VISIBLE_MS = 30 * 60_000;
/** 进程存活匹配时考虑多久内写过的会话文件（等你回复的会话可能挂很久） */
const ALIVE_LOOKBACK_MS = 3 * 24 * 60 * 60_000;
const MAX_FILES_PER_KIND = 60;

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
  lockedInodes?: () => Set<number> | null;
  /** 免打扰中：定时汇总不弹（结束 / 权限提示不受影响） */
  isQuiet?: () => boolean;
  /** 汇总间隔（默认 DIGEST_INTERVAL_MS），测试可调 */
  digestMs?: number;
  /** 会话累计用量（CodingMonitor 显示）；source = claude / codex / dsh */
  usageOf?: (source: string, session: string) => SessionUsageView | null;
  /** 任务结束播报附带的「本次花费」一句话；总结播报开着时才会调用 */
  taskCost?: (q: { source: string; session?: string; since: number }) => Promise<string | null>;
};

/** Nomi 对话标签（来自 CliHarnessService），避免 agents 依赖 cli 模块 */
export interface WatchedTab {
  id: string;
  title: string;
  backend: 'nomi' | 'claude' | 'codex' | 'dsh' | 'grok';
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
  aider: 'Aider',
  cline: 'Cline',
  continue: 'Continue',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
};

const REMIND: Record<AgentStatus, (label: string, summary?: string) => string> = {
  running: (l, s) => tr('{0} 还在忙：{1}', l, s || tr('处理中…')),
  completed: (l, s) => tr('{0} 做完啦～{1}', l, s ? ` ${s}` : ''),
  failed: (l, s) => tr('{0} 出错了：{1}', l, s || tr('请看看终端')),
  stalled: (l) => tr('{0} 好像卡住了，要不要去看看？', l),
  waiting: (l) => tr('{0} 这一轮做完了，在等你回复', l),
  idle: () => '',
};

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** 递归列出匹配文件，按 mtime 倒序取前 limit 个（不能按目录遍历顺序截断，否则会漏掉最新的） */
function listFiles(
  dir: string,
  pred: (n: string, full: string) => boolean,
  depth = 3,
  limit = MAX_FILES_PER_KIND,
): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  let visited = 0;
  const walk = (d: string, dep: number) => {
    if (dep < 0 || visited > 20_000) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      visited++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, dep - 1);
      else if (e.isFile() && pred(e.name, p)) {
        const st = safeStat(p);
        if (st) out.push({ path: p, mtime: st.mtimeMs });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, depth);
  return out.sort((x, y) => y.mtime - x.mtime).slice(0, limit);
}

/** 读文件开头 / 结尾若干字节，不把几十 MB 的 JSONL 整个读进内存 */
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
    osNotify: b(o.osNotify, base.osNotify),
    summaryEnabled: b(o.summaryEnabled, base.summaryEnabled),
    tools: {
      codex: b(tools.codex, true),
      claude: b(tools.claude, true),
      dsh: b(tools.dsh, true),
      grok: b(tools.grok, true),
      aider: b(tools.aider, true),
      cline: b(tools.cline, true),
      continue: b(tools.continue, true),
      cursor: b(tools.cursor, true),
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
    if (
      fs.existsSync(path.join(h, '.aider')) ||
      fs.existsSync(path.join(h, '.aider.chat.history.md'))
    )
      found.push('aider');
    if (fs.existsSync(path.join(h, '.cline'))) found.push('cline');
    if (fs.existsSync(path.join(h, '.continue'))) found.push('continue');
    if (fs.existsSync(path.join(h, '.cursor'))) found.push('cursor');
    if (fs.existsSync(path.join(h, '.gemini'))) found.push('gemini');
    return found;
  }

  /** 扫描本机已知路径，返回候选会话文件（每种工具按 mtime 倒序） */
  scanFiles(): Array<{ kind: AgentKind; path: string; mtime: number }> {
    const h = this.home;
    const out: Array<{ kind: AgentKind; path: string; mtime: number }> = [];
    const { tools } = this.settings;
    const add = (kind: AgentKind, list: Array<{ path: string; mtime: number }>) => {
      for (const f of list) out.push({ kind, ...f });
    };
    if (tools.codex)
      add(
        'codex',
        listFiles(path.join(h, '.codex', 'sessions'), (n) => n.endsWith('.jsonl'), 4),
      );
    if (tools.claude)
      add(
        'claude',
        listFiles(path.join(h, '.claude', 'projects'), (n) => n.endsWith('.jsonl'), 3),
      );
    if (tools.dsh) {
      // $DSH_HOME/sessions/<编码后的 cwd>/session-<uuid>/{session.lock, session.v4.jsonl.zstd}
      add(
        'dsh',
        listFiles(
          path.join(this.dshHome, 'sessions'),
          (n) => n === 'session.lock' || /^session\.v\d+\.jsonl/.test(n),
          2,
        ),
      );
    }
    if (tools.grok) {
      // ~/.grok/sessions/<cwd>/<uuid>/updates.jsonl — 用 mtime 推断活跃；细解析见用量模块
      add(
        'grok',
        listFiles(path.join(this.grokHome, 'sessions'), (n) => n === 'updates.jsonl', 3),
      );
    }
    if (tools.gemini)
      add(
        'gemini',
        listFiles(
          path.join(h, '.gemini', 'tmp'),
          (n, full) => /^session-.*\.json$/.test(n) && full.includes(`${path.sep}chats${path.sep}`),
          3,
        ),
      );
    if (tools.aider) {
      for (const p of [
        path.join(h, '.aider', 'analytics.jsonl'),
        path.join(h, '.aider.chat.history.md'),
      ]) {
        const st = safeStat(p);
        if (st) out.push({ kind: 'aider', path: p, mtime: st.mtimeMs });
      }
    }
    if (tools.cline)
      add(
        'cline',
        listFiles(path.join(h, '.cline'), (n) => n === 'job.json' || n.endsWith('.jsonl'), 5),
      );
    if (tools.continue)
      add(
        'continue',
        listFiles(
          path.join(h, '.continue', 'sessions'),
          (n) => n.endsWith('.json') && n !== 'sessions.json',
          1,
        ),
      );
    if (tools.cursor)
      // cursor-agent CLI：~/.cursor/chats/<hash>/<chatId>/store.db(+-wal)，内容为私有 SQLite
      add(
        'cursor',
        listFiles(path.join(h, '.cursor', 'chats'), (n) => /^store\.db(-wal)?$/.test(n), 3, 30),
      );
    return out;
  }

  /** 解析一个文件 → 候选会话（含去重 key） */
  private inspect(kind: AgentKind, filePath: string, mtime: number): Candidate {
    let info: SessionInfo;
    if (kind === 'claude') {
      info = parseClaudeSession(
        readSlice(filePath, 'head', 32 * 1024),
        readSlice(filePath, 'tail', 96 * 1024),
      );
      // 子代理：<project>/<sessionId>/subagents/agent-*.jsonl → 并入父会话
      const parts = filePath.split(path.sep);
      const si = parts.lastIndexOf('subagents');
      if (si > 0) info.parentId = parts[si - 1];
      info.sessionId ??= path.basename(filePath, '.jsonl');
    } else if (kind === 'codex') {
      info = parseCodexSession(
        readSlice(filePath, 'head', 32 * 1024),
        readSlice(filePath, 'tail', 96 * 1024),
      );
      info.sessionId ??=
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
          filePath,
        )?.[1];
    } else if (kind === 'dsh') {
      const dir = path.dirname(filePath);
      const id = path.basename(dir);
      const meta = parseDshProjcache(
        readSlice(
          path.join(this.dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`),
          'head',
          256 * 1024,
        ),
      );
      const lock = safeStat(path.join(dir, 'session.lock'));
      const lockHeld = this.dshLocks && lock ? this.dshLocks.has(lock.ino) : undefined;
      info = {
        ...meta,
        sessionId: id,
        // 锁被持有 = 正在写；锁空闲 = 这一轮已提交；无法判断时按写入时间推断
        phase: lockHeld === false ? 'turn-done' : 'working',
        detail: lockHeld ? tr('运行中') : undefined,
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
    } else if (kind === 'gemini') {
      info = parseGeminiSession(readSlice(filePath, 'head', 4 * 1024 * 1024));
    } else if (kind === 'cursor') {
      // 会话 = chatId 目录
      info = { phase: 'unknown', sessionId: path.basename(path.dirname(filePath)) };
    } else {
      const raw = readSlice(filePath, 'tail', 64 * 1024);
      const r =
        kind === 'aider'
          ? filePath.endsWith('.jsonl')
            ? parseAiderAnalytics(raw)
            : parseAiderHistory(raw)
          : kind === 'cline'
            ? parseClineJob(raw)
            : parseContinueSession(readSlice(filePath, 'head', 4 * 1024 * 1024));
      info = { phase: phaseOf(r), detail: r.summary };
      if (kind === 'continue') info.title = r.summary;
    }
    const sid = info.parentId ?? info.sessionId ?? filePath;
    return { key: `${kind}:${sid}`, kind, path: filePath, mtime, info };
  }

  /** 同一会话 id 的多个文件（主文件 + 子代理 / Cursor 的 db + wal）合并成一个 */
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
    // aider / cline / continue 的会话文件是全局的，进程匹配不可靠：只看是否有该类进程
    const kindsAlive = new Set(procs.map((p) => p.kind));
    for (const c of cands) {
      if (c.kind === 'dsh' && c.lockHeld !== undefined) res.set(c.key, c.lockHeld);
      else if (c.kind === 'aider' || c.kind === 'cline' || c.kind === 'continue')
        res.set(c.key, kindsAlive.has(c.kind) ? undefined : false);
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
        if (first) this.tick(false);
      })
      .finally(() => {
        this.procRefreshing = false;
      });
  }

  tick(refresh = true): void {
    if (!this.settings.enabled) return;
    if (refresh) this.refreshProcs();
    const now = this.now();
    this.dshLocks = this.settings.tools.dsh
      ? (this.d.lockedInodes ?? (() => readLockedInodes(this.d.platform)))()
      : null;
    const files = this.scanFiles().filter((f) => now - f.mtime < ALIVE_LOOKBACK_MS);
    const cands = this.dedupe(files.map((f) => this.inspect(f.kind, f.path, f.mtime)));
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
    const summary = this.settings.summaryEnabled && finished;
    const text = summary
      ? finishSummary(next.label, next.title, next.status === 'completed', next.summary)
      : REMIND[next.status](who, next.summary);
    if (!text) return;
    this.sayWithCost(
      text,
      finishedBubbleOpts(next.status, summary),
      finished && USAGE_KINDS.has(next.kind) && this.runStart.has(next.id)
        ? {
            source: next.kind,
            session: next.id.slice(next.kind.length + 1),
            since: this.runStart.get(next.id)!,
          }
        : undefined,
    );
    notifyIsland({
      kind: 'agent',
      endpoint: next.kind,
      status:
        next.status === 'failed'
          ? 'failed'
          : next.status === 'stalled' || next.status === 'waiting'
            ? 'attention'
            : 'done',
      title: who,
      body: next.title,
    });
    broadcastMascotCommand({
      type: 'motion',
      name: next.status === 'failed' || next.status === 'stalled' ? 'sorry' : 'thumbs_up',
    });
    if (this.settings.osNotify) this.notify(next.label, text);
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
   * Claude 工具权限待确认：看板娘说话 + 思考动作 + 灵动岛 attention。
   * 前台也提醒（对话区已有卡片，气泡/岛作二次提示）；后台额外可走系统通知。
   */
  onPermissionNeeded(e: EndpointPermissionNeeded): void {
    if (!this.settings.enabled) return;
    if (e.backend !== 'nomi' && !this.settings.tools[e.backend as AgentKind]) return;
    const label = ENDPOINT_LABEL[e.backend];
    const who = `${label}（${e.title}）`;
    const brief = (e.summary || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const text = tr('{0} 需要确认工具权限：{1}', who, brief || tr('请到对话里允许或拒绝'));
    this.d.desktop.say(text.slice(0, 140));
    notifyIsland({
      kind: 'agent',
      endpoint: e.backend,
      status: 'attention',
      title: who,
      body: brief || tr('需要确认工具权限'),
    });
    broadcastMascotCommand({ type: 'motion', name: 'think' });
    if (e.background && this.settings.osNotify) this.notify(label, text);
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
    const summary = this.settings.summaryEnabled;
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
      finishedBubbleOpts(e.ok ? 'completed' : 'failed', summary),
      since === undefined
        ? undefined
        : e.backend === 'nomi'
          ? { source: 'nomi', since }
          : tab?.cliSessionId
            ? { source: e.backend, session: tab.cliSessionId, since }
            : undefined,
    );
    notifyIsland({
      kind: 'agent',
      endpoint: e.backend,
      status: e.ok ? 'done' : 'failed',
      title: who,
      body: brief || (e.ok ? tr('这一轮做完了') : tr('出错了')),
    });
    broadcastMascotCommand({ type: 'motion', name: e.ok ? 'thumbs_up' : 'sorry' });
    if (this.settings.osNotify) this.notify(label, text);
    this.lastRemindAt = this.now();
    this.d.logger.info('agent-progress endpoint finished', { backend: e.backend, ok: e.ok });
    this.broadcast();
  }

  /**
   * 说出结束播报。总结播报开着且能查到「本次花费」时，在末尾补一句（最多等 3 秒，
   * 查不到 / 超时就照常播原文，不让播报被用量统计拖住）。
   */
  private sayWithCost(
    text: string,
    opts: ReturnType<typeof finishedBubbleOpts>,
    q?: { source: string; session?: string; since: number },
  ): void {
    const send = (cost: string | null) => this.d.desktop.say(withCost(text, cost), opts);
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

  private notify(title: string, body: string) {
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body: body.slice(0, 180), icon: iconImage() }).show();
    } catch (e) {
      this.d.logger.warn('agent notify failed', String(e));
    }
  }

  private broadcast() {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.webContents.send('ai:agents:changed', null);
    }
  }

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.d.logger.warn('agent-progress tick', String(e));
      }
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
   * 定时汇总：重新扫描一次，若有进行中的编程任务，被动告知「还有 N 个任务进行中」
   * （按工具分组）。总结播报开启时附带最近进度并朗读；关闭时只出气泡 / 灵动岛，不出声。
   * 0 个不提示；刚发过结束 / 权限等提示、免打扰中也跳过。返回是否发出了汇总。
   */
  digest(): boolean {
    if (!this.settings.enabled) return false;
    try {
      this.tick(false);
    } catch (e) {
      this.d.logger.warn('agent-progress digest scan', String(e));
    }
    const running = this.runningTasks();
    if (!running.length) return false;
    if (this.d.isQuiet?.()) return false;
    if (this.lastRemindAt && nowGap(this.lastRemindAt, this.now()) < DIGEST_QUIET_AFTER_REMIND_MS)
      return false;

    const groups = new Map<string, number>();
    for (const r of running) groups.set(r.label, (groups.get(r.label) ?? 0) + 1);
    const breakdown = [...groups].map(([l, n]) => `${l} ${n}`).join(' · ');
    const head = tr('还有 {0} 个编程任务进行中（{1}）', running.length, breakdown);
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
    this.d.desktop.say(text.slice(0, 140), {
      kind: 'digest',
      voice: summary ? 'full' : 'none',
    });
    const kinds = new Set(running.map((r) => r.kind));
    notifyIsland({
      kind: 'agent',
      endpoint: kinds.size === 1 ? [...kinds][0] : undefined,
      status: 'running',
      title: tr('{0} 个编程任务进行中', running.length),
      body: summary ? text.slice(head.length + 1) || breakdown : breakdown,
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

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'AgentProgressService' });
    handle('ai:agents:state', () => this.state());
    handle('ai:agents:set-settings', (p) =>
      this.setSettings((p ?? {}) as Partial<AgentWatchSettings>),
    );
    handle('ai:agents:scan', () => {
      this.tick();
      return this.state();
    });
  }
}

const ENDPOINT_LABEL: Record<WatchedTab['backend'], string> = {
  nomi: 'Nomi',
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
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
    summary: t.status === 'queued' ? tr('排队中') : t.lastError,
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
    ? tr('{0} 完成了任务「{1}」，结果：{2}', label, task, d || tr('顺利完成'))
    : tr('{0} 的任务「{1}」失败了：{2}', label, task, d || tr('请看看终端'));
}

/** 有会话级用量日志的工具 */
const USAGE_KINDS = new Set<string>(['claude', 'codex', 'dsh', 'grok']);
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

/** 结束气泡的出声方式：总结播报开 → 朗读总结；关 → 只播一句简短固定台词 + 音效 */
function finishedBubbleOpts(
  status: AgentStatus,
  summary: boolean,
): { kind?: 'done' | 'fail'; voice?: 'full' | 'cue' } {
  if (status !== 'completed' && status !== 'failed') return {};
  return { kind: status === 'completed' ? 'done' : 'fail', voice: summary ? 'full' : 'cue' };
}

function nowGap(from: number, to: number) {
  return Math.max(0, to - from);
}

let inst: AgentProgressService | null = null;
export function initAgentProgressService(d: Deps): AgentProgressService {
  inst = new AgentProgressService(d);
  return inst;
}
export function getAgentProgressService(): AgentProgressService | null {
  return inst;
}
