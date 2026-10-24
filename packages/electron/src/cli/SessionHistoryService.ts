/**
 * 编程助手历史会话（读本机磁盘，主进程扫描）：
 *   Claude Code ~/.claude/projects/<cwd>/<id>.jsonl
 *   Codex       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)（归档的会话不列出）；
 *               元信息优先取只读打开的 state_5.sqlite（threads 表），没有索引的文件再解析 rollout
 *   dsh         $DSH_HOME/sessions/<cwd>/session-<uuid>/session.v4.jsonl(.zstd)
 *   Gemini      ~/.gemini/tmp/<项目>/chats/session-*.jsonl（工作目录取同级 .project_root）
 *
 * - 增量：目录列表 3 秒内复用；每个文件的元信息按 (mtime, size) 缓存，只重解析变化的文件。
 * - 分页：按修改时间倒序，每页 20 条，最多展示最近 500 条可见会话。
 * - 不按账号、供应商过滤（docs/design/unified-gateway.md §13.1）：每条会话带上客户端、线路、账号标签。
 * - 去重：已经在 Nomi 标签里打开的会话（backend + cliSessionId 相同）不再列出。
 * - 打开：读出可见对话（尽力而为，失败则为空并给提示），交给 CliHarnessService 新建 / 复用标签，
 *   下一条消息按各 CLI 的续接参数（claude --resume / codex exec resume / dsh --session-id /
 *   Gemini ACP session/load）继续。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  claude as claudePlugin,
  codex as codexPlugin,
  dsh as dshPlugin,
  gemini as geminiPlugin,
  grok as grokPlugin,
} from '@nomi-ai/cli-plugins/main';
import type { HistoryCapability } from '@nomi-ai/cli-sdk';

import {
  foldGeminiChat,
  parseGeminiSession,
  geminiText,
  jsonlEvents,
  cleanTitle,
  parseClaudeSession,
  parseCodexSession,
  parseGrokSession,
  parseDshSession,
  parseDshProjcache,
} from '../agents/parsers';
import { t } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { claudeConfigDir, codexHomeDir, geminiDir, grokHomeDir } from '../usage/cliHomes';
import { dbSignature } from '../usage/sqliteRead';

import { readCodexThreads, type CodexThreadRow } from './codexThreadIndex';
import { parseTranscript, titleFromMessages, type HistoryBackend } from './historyTranscript';
import { fromCliPermissionMode } from './permissionMode';
import type {
  HarnessPermissionMode,
  HarnessTabMessage,
  HarnessTabMeta,
  HarnessTabSource,
} from './types';

/** 各 CLI 的历史文件扫描（插件给出） */
const HISTORY_SCAN: Record<HistoryBackend, HistoryCapability> = {
  claude: claudePlugin.history,
  codex: codexPlugin.history,
  dsh: dshPlugin.history,
  gemini: geminiPlugin.history,
  grok: grokPlugin.history,
};

export const HISTORY_PAGE_SIZE = 20;
/** 历史会话最多展示的条数（列表与搜索索引共同的硬上限，按 mtime 取最近的 N 条） */
export const HISTORY_MAX_ITEMS = 500;
const LIST_TTL_MS = 3000;
const MAX_PARSED_CACHE = 6000;
const MAX_TRANSCRIPT_BYTES = 12 * 1024 * 1024;
/**
 * 列表阶段为读模型 / 档位而解压 dsh 会话的上限（压缩后字节）。列表会一次处理很多会话，
 * 超过的只用明文索引（标题 / 目录 / 权限），避免整份解压大会话占用 CPU 和内存。
 */
export const DSH_META_MAX_ZSTD_BYTES = 2 * 1024 * 1024;
/** 列表阶段为读元信息而解压 Codex 压缩 rollout 的上限（压缩后字节）；有 sqlite 索引的不用解压 */
export const CODEX_META_MAX_ZST_BYTES = 4 * 1024 * 1024;
const CODEX_ID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const BACKENDS: readonly HistoryBackend[] = ['claude', 'codex', 'dsh', 'gemini', 'grok'];

/** 会话由哪个客户端创建（目前只有 Codex 记录了这项） */
export type HistoryClient = 'cli' | 'desktop' | 'ide' | 'exec' | 'nomi';
/** 线路：官方 / Nomi 网关 / 其他自定义供应商 */
export type HistoryRoute = 'official' | 'gateway' | 'custom';

export interface HistorySession {
  /** `${backend}:${sessionId}` */
  key: string;
  backend: HistoryBackend;
  sessionId: string;
  title: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: HarnessPermissionMode;
  /** 原工作目录是否已不存在（续接需要同一目录） */
  cwdMissing: boolean;
  updatedAt: number;
  client?: HistoryClient;
  route?: HistoryRoute;
  /** 线路为 custom 时的供应商名（CLI 记录的原值） */
  provider?: string;
  /** 创建会话的官方账号（能对上保险箱里的账号时显示邮箱或名称） */
  account?: string;
}

export interface HistoryPage {
  items: HistorySession[];
  /** 下一页的可见会话 offset；没有更多时为 null */
  nextOffset: number | null;
  hasMore: boolean;
}

export interface HistoryOpenResult {
  ok: boolean;
  tab?: HarnessTabMeta;
  reused?: boolean;
  /** 非致命提示（例如转录解析失败） */
  notice?: string;
  error?: string;
}

interface FileEntry {
  path: string;
  mtime: number;
  size: number;
  /** dsh：会话目录名 */
  dirId?: string;
}

/** accountId 只在主进程内用于反查账号标签，不交给界面 */
type SessionMeta = Omit<HistorySession, 'cwdMissing' | 'updatedAt' | 'account'> & {
  accountId?: string;
};

interface Parsed {
  mtime: number;
  size: number;
  meta: SessionMeta | null;
}

export interface SessionHistoryDeps {
  home?: string;
  dshHome?: string;
  /** 放 .gemini 的主目录（默认 GEMINI_CLI_HOME 或 home） */
  geminiHome?: string;
  /** 环境变量（测试注入）：CLAUDE_CONFIG_DIR / CODEX_HOME；默认 process.env */
  env?: NodeJS.ProcessEnv;
  logger?: { warn(m: string, d?: unknown): void };
  /** 已在标签里打开的会话：`${backend}:${sessionId}` */
  openKeys?: () => Set<string>;
  /** 新建 / 复用标签（由 CliHarnessService 提供） */
  openTab?: (o: {
    backend: HistoryBackend;
    sessionId: string;
    cwd: string;
    title: string;
    messages: HarnessTabMessage[];
    modelOverride?: string | null;
    reasoningEffort?: string | null;
    permissionMode?: HarnessPermissionMode;
    permissionModeSource?: 'history-cli';
    /** 会话原本的来源（由历史线路推断）：避免用新标签默认来源续接，官方 / 第三方互相串用 */
    source?: HarnessTabSource;
    /** 会话原本所在的官方账号 */
    accountId?: string;
  }) => { tab: HarnessTabMeta; reused: boolean };
  /** 会话是否经统一网关跑过（网关会话归属表）：历史里没记线路的后端（Claude）据此推断来源（#90） */
  gatewaySession?: (backend: HistoryBackend, sessionId: string) => boolean;
  /** 会话的官方账号 id → 展示用的标签（邮箱 / 名称）；对不上返回 undefined */
  accountLabel?: (backend: HistoryBackend, accountId: string) => string | undefined;
  /**
   * Nomi 启动这个会话时用的官方账号（会话目录在各账号间共享，文件里看不出，§5.10 S9）：
   * label 只在需要区分时给（同一 CLI 有多个账号）；id 用来按原账号续接
   */
  sessionAccount?: (
    backend: HistoryBackend,
    sessionId: string,
  ) => { id: string; label?: string } | undefined;
}

async function readHead(p: string, bytes: number): Promise<string> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function readTailText(
  p: string,
  bytes: number,
): Promise<{ text: string; truncated: boolean }> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let text = buf.toString('utf8');
    const truncated = size > len;
    // 从尾部读时第一行多半是半行，丢弃
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export function zstdDecode(buf: Buffer): Promise<string> {
  const native = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer })
    .zstdDecompressSync;
  if (native) {
    try {
      return Promise.resolve(native(buf).toString('utf8'));
    } catch {
      /* 落到外部 zstd */
    }
  }
  return new Promise((resolve, reject) => {
    const cp = execFile(
      'zstd',
      ['-dc'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.toString('utf8'))),
    );
    cp.stdin?.on('error', () => undefined);
    cp.stdin?.end(buf);
  });
}

export class SessionHistoryService {
  private readonly home: string;
  private readonly dshHome: string;
  private readonly listCache = new Map<HistoryBackend, { at: number; entries: FileEntry[] }>();
  private readonly parsed = new Map<string, Parsed>();
  /** key → 文件，供 transcript / open 反查 */
  private readonly byKey = new Map<string, FileEntry & { meta: Parsed['meta'] }>();
  /** Codex sqlite 索引：库文件指纹没变就复用 */
  private codexIndex: { sig: string | null; rows: Map<string, CodexThreadRow> } = {
    sig: null,
    rows: new Map(),
  };

  private geminiRoot(): string {
    return this.d.geminiHome ? path.join(this.d.geminiHome, '.gemini') : geminiDir(this.home);
  }

  constructor(private readonly d: SessionHistoryDeps = {}) {
    this.home = d.home ?? os.homedir();
    this.dshHome =
      d.dshHome ??
      (process.env.DSH_HOME?.trim()
        ? path.resolve(process.env.DSH_HOME)
        : path.join(this.home, '.dsh'));
  }

  /** 各后端会话文件的根目录（尊重各 CLI 的目录变量；Gemini / dsh 可由构造参数覆盖） */
  private historyRoot(backend: HistoryBackend): string {
    const env = this.d.env ?? process.env;
    switch (backend) {
      case 'claude':
        return path.join(claudeConfigDir(this.home, env), 'projects');
      case 'codex':
        return path.join(codexHomeDir(this.home, env), 'sessions');
      case 'gemini':
        return path.join(this.geminiRoot(), 'tmp');
      case 'grok':
        return path.join(grokHomeDir(this.home, env), 'sessions');
      default:
        return path.join(this.dshHome, 'sessions');
    }
  }

  /** 候选文件（mtime 倒序） */
  private async candidates(backend: HistoryBackend, force: boolean): Promise<FileEntry[]> {
    const hit = this.listCache.get(backend);
    if (!force && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.entries;
    // 文件扫描在插件里（@nomi-ai/cli-plugins 的 history.scan，只读目录与 stat）；
    // 根目录在这里算，测试与旧配置可以单独覆盖 Gemini / dsh 的主目录
    const entries: FileEntry[] = [];
    for await (const f of HISTORY_SCAN[backend].scan(this.historyRoot(backend))) entries.push(f);
    if (backend === 'codex') {
      this.refreshCodexIndex(
        path.join(codexHomeDir(this.home, this.d.env ?? process.env), 'state_5.sqlite'),
      );
      // 归档 / 删除 / 续接可能让最新 rollout 消失；重扫时不能保留失效的反查路径。
      for (const key of this.byKey.keys()) if (key.startsWith('codex:')) this.byKey.delete(key);
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    this.listCache.set(backend, { at: Date.now(), entries });
    return entries;
  }

  private async inspect(backend: HistoryBackend, f: FileEntry): Promise<Parsed['meta']> {
    if (backend === 'claude') {
      const head = await readHead(f.path, 128 * 1024);
      const info = parseClaudeSession(head, '');
      // 子代理：文件里第一条对话事件就是 sidechain（主会话里偶尔夹带的 sidechain 行不算）
      const firstTurn = jsonlEvents(head, 200).find(
        (e) => e.type === 'user' || e.type === 'assistant',
      );
      if (firstTurn?.isSidechain === true) return null;
      const sessionId = info.sessionId ?? path.basename(f.path, '.jsonl');
      const hasUser = /"type"\s*:\s*"user"/.test(head);
      const title = info.title ?? (hasUser ? t('（无标题会话）') : undefined);
      if (!title) return null;
      return {
        key: `claude:${sessionId}`,
        backend,
        sessionId,
        title,
        cwd: info.cwd,
        ...(info.model ? { model: info.model } : {}),
        ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
        ...(info.permissionMode
          ? { permissionMode: normalizePermissionMode('claude', info.permissionMode) }
          : {}),
      };
    }
    if (backend === 'codex') {
      const idFromName = CODEX_ID_RE.exec(path.basename(f.path))?.[1];
      const row = idFromName ? this.codexIndex.rows.get(idFromName) : undefined;
      if (row?.archived) return null;
      let head = '';
      if (!f.path.endsWith('.zst')) head = await readHead(f.path, 512 * 1024);
      else if (!row && f.size <= CODEX_META_MAX_ZST_BYTES) {
        // 没有索引的压缩会话：整份解压一次（结果按 mtime 缓存），只取开头
        head = await zstdDecode(await fs.promises.readFile(f.path))
          .then((x) => x.slice(0, 512 * 1024))
          .catch(() => '');
      }
      const info = parseCodexSession(head, '');
      const sm = codexSessionMeta(head);
      const sessionId = info.sessionId ?? row?.id ?? idFromName;
      // 子代理（guardian 审查、thread_spawn 派生）不单列；其他来源一律列出
      if (isCodexSubagentSource(row?.source ?? sm.source)) return null;
      const client = codexClient(
        sm.originator ?? row?.originator ?? undefined,
        sm.source ?? row?.source ?? undefined,
      );
      const title =
        cleanTitle(row?.name ?? undefined) ??
        cleanTitle(row?.title ?? undefined) ??
        info.title ??
        cleanTitle(row?.first_user_message ?? undefined) ??
        (client === 'desktop' ? t('（无标题会话）') : undefined);
      if (!sessionId || !title) return null;
      const model = info.model ?? row?.model ?? undefined;
      const effort = info.reasoningEffort ?? row?.reasoning_effort ?? undefined;
      // 线路以索引为准：Codex 续接时会把 model_provider 改成本次的供应商
      const provider = row?.model_provider ?? sm.modelProvider;
      const route = codexRoute(provider);
      return {
        key: `codex:${sessionId}`,
        backend,
        sessionId,
        title,
        cwd: info.cwd ?? row?.cwd ?? undefined,
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(info.permissionMode
          ? { permissionMode: normalizePermissionMode('codex', info.permissionMode) }
          : {}),
        ...(client ? { client } : {}),
        route,
        ...(route === 'custom' && provider ? { provider } : {}),
        ...(row?.creator_account_id ? { accountId: row.creator_account_id } : {}),
      };
    }
    if (backend === 'gemini') {
      const head = await readHead(f.path, 256 * 1024);
      const chat = foldGeminiChat(head);
      if (!chat.sessionId || chat.kind === 'subagent') return null;
      const info = parseGeminiSession(head);
      const firstUser = chat.messages.find((m) => m.type === 'user');
      const title = cleanTitle(chat.summary) ?? cleanTitle(geminiText(firstUser?.content));
      if (!title) return null;
      // 0.62 的项目目录名是 slug，同级 .project_root 记着真正的工作目录；旧版是哈希目录，没有
      const marker = await readHead(
        path.join(path.dirname(path.dirname(f.path)), '.project_root'),
        4096,
      );
      const cwd = marker.trim() || undefined;
      return {
        key: `gemini:${chat.sessionId}`,
        backend,
        sessionId: chat.sessionId,
        title,
        cwd,
        ...(info.model ? { model: info.model } : {}),
        ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
        ...(info.permissionMode
          ? { permissionMode: normalizePermissionMode('gemini', info.permissionMode) }
          : {}),
      };
    }
    if (backend === 'grok') {
      const text = await readHead(f.path, 512 * 1024);
      const sessionId = f.dirId ?? path.basename(path.dirname(f.path));
      const info = parseGrokSession(text, sessionId);
      let encodedCwd = path.basename(path.dirname(path.dirname(f.path)));
      try {
        encodedCwd = decodeURIComponent(encodedCwd);
      } catch {
        /* malformed directory names are still valid session keys */
      }
      const cwd = info.cwd ?? encodedCwd;
      const messages = parseTranscript('grok', text);
      const title = info.title ?? titleFromMessages(messages);
      if (!title) return null;
      return {
        key: `grok:${sessionId}`,
        backend,
        sessionId,
        title,
        cwd,
        ...(info.model ? { model: info.model } : {}),
        ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
        ...(info.permissionMode
          ? { permissionMode: normalizePermissionMode('grok', info.permissionMode) }
          : {}),
      };
    }
    const id = f.dirId ?? path.basename(path.dirname(f.path));
    const meta = parseDshProjcache(
      await readHead(
        path.join(this.dshHome, 'storages', 'session_projcache', 'sessions', `${id}.json`),
        256 * 1024,
      ),
    );
    if (!meta.title) return null;
    // dsh keeps the effective model / permission in the session event stream;
    // compressed sessions are decoded best-effort so older/plain fixtures keep
    // working when zstd is unavailable.
    let sessionInfo = parseDshSession('', id);
    try {
      if (f.path.endsWith('.zstd') && f.size > DSH_META_MAX_ZSTD_BYTES)
        throw new Error('dsh session too large for list metadata');
      const raw = f.path.endsWith('.zstd')
        ? (await zstdDecode(await fs.promises.readFile(f.path))).slice(0, 512 * 1024)
        : await readHead(f.path, 512 * 1024);
      sessionInfo = parseDshSession(raw, id);
    } catch {
      /* 明文索引仍可提供标题、目录和权限 */
    }
    return {
      key: `dsh:${id}`,
      backend,
      sessionId: id,
      title: meta.title,
      // The plaintext project index is the authoritative workspace binding;
      // the session header can contain the original seed cwd after a move.
      cwd: meta.cwd ?? sessionInfo.cwd,
      ...(sessionInfo.model ? { model: sessionInfo.model } : {}),
      ...(sessionInfo.reasoningEffort ? { reasoningEffort: sessionInfo.reasoningEffort } : {}),
      ...((sessionInfo.permissionMode ?? meta.permissionMode)
        ? {
            permissionMode: normalizePermissionMode(
              'dsh',
              sessionInfo.permissionMode ?? meta.permissionMode!,
            ),
          }
        : {}),
    };
  }

  private async parsedOf(backend: HistoryBackend, f: FileEntry): Promise<Parsed['meta']> {
    const hit = this.parsed.get(f.path);
    let meta: Parsed['meta'];
    if (hit && hit.mtime === f.mtime && hit.size === f.size) meta = hit.meta;
    else {
      meta = await this.inspect(backend, f);
      if (this.parsed.size > MAX_PARSED_CACHE) this.parsed.clear();
      this.parsed.set(f.path, { mtime: f.mtime, size: f.size, meta });
    }
    if (meta) {
      // 同一会话 id 可能对应多个文件（Codex 续接会新写一个 rollout）：反查表只保留最新的一个，
      // 平手时按路径取小，保证并行解析时结果稳定
      const cur = this.byKey.get(meta.key);
      if (
        !cur ||
        cur.path === f.path ||
        f.mtime > cur.mtime ||
        (f.mtime === cur.mtime && f.path < cur.path)
      )
        this.byKey.set(meta.key, { ...f, meta });
    }
    return meta;
  }

  async list(
    backend: HistoryBackend,
    o: { offset?: number; limit?: number; force?: boolean } = {},
  ): Promise<HistoryPage> {
    return this.page(backend, o, false);
  }

  /**
   * 搜索用的紧凑索引：与 list 同一套去重 / 增量解析（只重读变化的文件），同样按页取，
   * 且不为每条检查工作目录是否存在。匹配在界面里做（防抖后过滤），这里只负责
   * 「分页地把标题 / 路径交出去」。列表与索引都只覆盖最近 {@link HISTORY_MAX_ITEMS} 条可见会话。
   */
  async index(
    backend: HistoryBackend,
    o: { offset?: number; limit?: number; force?: boolean } = {},
  ): Promise<HistoryPage> {
    return this.page(backend, o, true);
  }

  private async page(
    backend: HistoryBackend,
    o: { offset?: number; limit?: number; force?: boolean },
    cheap: boolean,
  ): Promise<HistoryPage> {
    if (!BACKENDS.includes(backend)) throw new Error(t('未知后端'));
    const limit = Math.min(
      HISTORY_PAGE_SIZE,
      Math.max(1, Math.round(o.limit ?? HISTORY_PAGE_SIZE)),
    );
    // The cursor is the number of visible sessions already returned. Keeping it
    // independent from the raw file index means empty / sidechain files do not
    // consume the 100-session window or leave the caller with short pages.
    const offset = Math.max(0, Math.round(o.offset ?? 0));
    const entries = await this.candidates(backend, Boolean(o.force));
    if (offset >= HISTORY_MAX_ITEMS) return { items: [], nextOffset: null, hasMore: false };
    const open = this.d.openKeys?.() ?? new Set<string>();
    // Read one extra visible item so hasMore is accurate even when the tail is
    // made up of empty, sidechain, duplicate, or currently open files.
    const target = Math.min(HISTORY_MAX_ITEMS, offset + limit + 1);
    const visible: HistorySession[] = [];
    let scan = 0;
    // 分批并行解析，避免一个个串行读文件
    while (scan < entries.length && visible.length < target) {
      const batch = entries.slice(scan, scan + Math.max(8, target - visible.length));
      const metas = await Promise.all(batch.map((f) => this.parsedOf(backend, f)));
      for (let k = 0; k < batch.length; k++) {
        const m = metas[k];
        const f = batch[k]!;
        scan++;
        if (!m || open.has(m.key)) continue;
        // 同一会话的旧文件不再单列（只有「最新的那个文件」才是这条会话）
        if (this.byKey.get(m.key)?.path !== f.path) continue;
        const { accountId, ...rest } = m;
        const account =
          (accountId ? this.d.accountLabel?.(backend, accountId) : undefined) ??
          this.d.sessionAccount?.(backend, m.sessionId)?.label;
        visible.push({
          ...rest,
          ...(account ? { account } : {}),
          cwdMissing: !cheap && m.cwd ? !isDir(m.cwd) : false,
          updatedAt: f.mtime,
        });
        if (visible.length >= target) break;
      }
    }
    const items = visible.slice(offset, offset + limit);
    const pageEnd = offset + items.length;
    const hasMore = visible.length > pageEnd && pageEnd < HISTORY_MAX_ITEMS;
    return { items, nextOffset: hasMore ? pageEnd : null, hasMore };
  }

  /** 读出可见对话；失败时返回空数组与提示 */
  async transcript(
    backend: HistoryBackend,
    sessionId: string,
  ): Promise<{ messages: HarnessTabMessage[]; truncated: boolean; note?: string }> {
    const f = await this.locate(backend, sessionId);
    if (!f) return { messages: [], truncated: false, note: t('找不到该会话的记录文件') };
    try {
      let text: string;
      let truncated = false;
      if (/\.zstd?$/.test(f.path)) {
        text = await zstdDecode(await fs.promises.readFile(f.path));
      } else {
        ({ text, truncated } = await readTailText(f.path, MAX_TRANSCRIPT_BYTES));
      }
      const messages = parseTranscript(backend, text, f.mtime);
      if (!messages.length) return { messages, truncated, note: t('没有解析到可显示的历史消息') };
      return { messages, truncated };
    } catch (e) {
      this.d.logger?.warn('history transcript failed', e);
      return { messages: [], truncated: false, note: t('读取历史消息失败，仍可继续该会话') };
    }
  }

  private async locate(
    backend: HistoryBackend,
    sessionId: string,
  ): Promise<(FileEntry & { meta: Parsed['meta'] }) | null> {
    const key = `${backend}:${sessionId}`;
    const cached = this.byKey.get(key);
    if (cached && fs.existsSync(cached.path)) return cached;
    // 缓存里没有（例如没翻到那一页）：整体扫一遍
    const entries = await this.candidates(backend, true);
    for (let i = 0; i < entries.length; i += 16) {
      const batch = entries.slice(i, i + 16);
      await Promise.all(batch.map((f) => this.parsedOf(backend, f)));
      const hit = this.byKey.get(key);
      if (hit) return hit;
    }
    return null;
  }

  async open(backend: HistoryBackend, sessionId: string): Promise<HistoryOpenResult> {
    try {
      if (!this.d.openTab) throw new Error(t('当前环境不支持打开历史会话'));
      const f = await this.locate(backend, sessionId);
      if (!f?.meta) return { ok: false, error: t('找不到该会话，可能已被删除') };
      const cwd = f.meta.cwd;
      if (!cwd || !isDir(cwd)) {
        return {
          ok: false,
          error: t('原工作目录已不存在：{0}。续接需要同一目录，请先恢复该目录。', cwd ?? '?'),
        };
      }
      const tr = await this.transcript(backend, sessionId);
      const title = f.meta.title || titleFromMessages(tr.messages) || sessionId;
      // 历史没记线路（非 Codex）时看网关的会话归属表：经网关跑过 → 第三方
      const route =
        f.meta.route ?? (this.d.gatewaySession?.(backend, sessionId) ? 'gateway' : undefined);
      const r = this.d.openTab({
        backend,
        sessionId,
        cwd,
        title,
        messages: tr.messages,
        ...(f.meta.model ? { modelOverride: f.meta.model } : {}),
        ...(f.meta.reasoningEffort ? { reasoningEffort: f.meta.reasoningEffort } : {}),
        ...(f.meta.permissionMode ? { permissionMode: f.meta.permissionMode } : {}),
        ...(!f.meta.permissionMode ? { permissionModeSource: 'history-cli' as const } : {}),
        ...(() => {
          const acct = this.d.sessionAccount?.(backend, sessionId);
          return acct ? { accountId: acct.id } : {};
        })(),
        // 按历史记录的线路续接，不用新标签默认来源（#90）：网关 → 第三方；官方与用户自己在
        // config.toml 配的 custom 供应商都是 CLI 原生配置 → 官方。推断不出的沿用默认。
        ...(route
          ? { source: route === 'gateway' ? ('thirdParty' as const) : ('official' as const) }
          : {}),
      });
      const notice = r.reused
        ? undefined
        : (tr.note ?? (tr.truncated ? t('历史较长，只显示了最近的部分消息') : undefined));
      return { ok: true, tab: r.tab, reused: r.reused, notice };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private refreshCodexIndex(file: string): void {
    const sig = dbSignature(file);
    if (sig === this.codexIndex.sig) return;
    // 标题、归档与续接供应商都可能只改 sqlite，不改 rollout 的 mtime。
    this.parsed.clear();
    const rows = new Map<string, CodexThreadRow>();
    if (sig) for (const r of readCodexThreads(file)) if (r.id) rows.set(r.id, r);
    this.codexIndex = { sig, rows };
  }

  registerIpc(): void {
    const handle = (ch: string, fn: (...a: unknown[]) => Promise<unknown>) =>
      guardedHandle(ch, fn, { owner: 'SessionHistoryService' });
    handle('ai:history:list', (b, o) =>
      this.list(
        b as HistoryBackend,
        (o ?? {}) as { offset?: number; limit?: number; force?: boolean },
      ),
    );
    handle('ai:history:index', (b, o) =>
      this.index(
        b as HistoryBackend,
        (o ?? {}) as { offset?: number; limit?: number; force?: boolean },
      ),
    );
    handle('ai:history:open', (b, id) => this.open(b as HistoryBackend, String(id)));
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** rollout 第一条 session_meta 里的来源字段（source 可能是字符串，也可能是 {subagent:…} 对象） */
export function codexSessionMeta(head: string): {
  source?: unknown;
  originator?: string;
  modelProvider?: string;
} {
  const e = jsonlEvents(head, 20).find((x) => x.type === 'session_meta');
  const p = (e?.payload ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  return {
    ...(p.source !== undefined && p.source !== null ? { source: p.source } : {}),
    ...(s(p.originator) ? { originator: s(p.originator) } : {}),
    ...(s(p.model_provider) ? { modelProvider: s(p.model_provider) } : {}),
  };
}

/** 只认明确的子代理来源；其他取值（vscode / cli / exec / 不认识的）一律当作主会话 */
export function isCodexSubagentSource(source: unknown): boolean {
  let v = source;
  if (typeof v === 'string') {
    if (!v.trimStart().startsWith('{')) return false;
    try {
      v = JSON.parse(v);
    } catch {
      return false;
    }
  }
  return !!v && typeof v === 'object' && 'subagent' in v;
}

/** model_provider → 线路。老版本没有这个字段（只能是 OpenAI 官方） */
export function codexRoute(provider: string | null | undefined): HistoryRoute {
  if (!provider || provider === 'openai') return 'official';
  if (provider === 'nomi_gateway') return 'gateway';
  return 'custom';
}

/** originator / source → 客户端 */
export function codexClient(originator?: string, source?: unknown): HistoryClient | undefined {
  const o = originator?.trim().toLowerCase() ?? '';
  if (o === 'nomi' || o.startsWith('nomi-')) return 'nomi';
  if (o === 'codex desktop' || o === 'codex_work_desktop') return 'desktop';
  if (o === 'codex_vscode') return 'ide';
  if (o === 'codex_exec' || source === 'exec') return 'exec';
  if (o === 'codex_cli_rs' || source === 'cli') return 'cli';
  if (source === 'vscode') return 'ide';
  return undefined;
}

/** 将 CLI 日志里的原生安全模式映射成 Nomi 的统一档位；未知值返回 undefined（按「历史未记录」处理）。 */
function normalizePermissionMode(
  backend: HistoryBackend,
  raw: string,
): HarnessPermissionMode | undefined {
  // 未知原生值不能伪装成某个默认档位；open() 会把它当作“历史未记录”并在 ACP
  // 握手时读取 currentModeId。对于没有 ACP 握手的后端，调用方仍会采用安全默认值。
  return fromCliPermissionMode(backend, raw) ?? undefined;
}

let inst: SessionHistoryService | null = null;
export function initSessionHistoryService(d: SessionHistoryDeps): SessionHistoryService {
  inst = new SessionHistoryService(d);
  return inst;
}
export function getSessionHistoryService(): SessionHistoryService | null {
  return inst;
}
