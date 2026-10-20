/**
 * 编程助手历史会话（读本机磁盘，主进程扫描）：
 *   Claude Code ~/.claude/projects/<cwd>/<id>.jsonl
 *   Codex       ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   dsh         $DSH_HOME/sessions/<cwd>/session-<uuid>/session.v4.jsonl(.zstd)
 *   Gemini      ~/.gemini/tmp/<项目>/chats/session-*.jsonl（工作目录取同级 .project_root）
 *
 * - 增量：目录列表 3 秒内复用；每个文件的元信息按 (mtime, size) 缓存，只重解析变化的文件。
 * - 分页：按修改时间倒序，每页 20 条，最多展示最近 100 条可见会话。
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

import { parseTranscript, titleFromMessages, type HistoryBackend } from './historyTranscript';
import { fromCliPermissionMode } from './permissionMode';
import type { HarnessPermissionMode, HarnessTabMessage, HarnessTabMeta } from './types';

export const HISTORY_PAGE_SIZE = 20;
/** 历史会话最多展示的条数（列表与搜索索引共同的硬上限，按 mtime 取最近的 N 条） */
export const HISTORY_MAX_ITEMS = 100;
const LIST_TTL_MS = 3000;
const MAX_PARSED_CACHE = 6000;
const MAX_TRANSCRIPT_BYTES = 12 * 1024 * 1024;
const BACKENDS: readonly HistoryBackend[] = ['claude', 'codex', 'dsh', 'gemini', 'grok'];

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

interface Parsed {
  mtime: number;
  size: number;
  meta: Omit<HistorySession, 'cwdMissing' | 'updatedAt'> | null;
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
  }) => { tab: HarnessTabMeta; reused: boolean };
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

async function readdir(d: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(d, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statAll(paths: Array<{ path: string; dirId?: string }>): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (let i = 0; i < paths.length; i += 128) {
    const chunk = paths.slice(i, i + 128);
    const res = await Promise.all(
      chunk.map(async (c) => {
        try {
          const st = await fs.promises.stat(c.path);
          return { ...c, mtime: st.mtimeMs, size: st.size } as FileEntry;
        } catch {
          return null;
        }
      }),
    );
    for (const r of res) if (r) out.push(r);
  }
  return out;
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

  /** 候选文件（mtime 倒序） */
  private async candidates(backend: HistoryBackend, force: boolean): Promise<FileEntry[]> {
    const hit = this.listCache.get(backend);
    if (!force && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.entries;
    let entries: FileEntry[];
    if (backend === 'claude') {
      // 尊重 CLAUDE_CONFIG_DIR（与 claude 本身、用量统计一致）
      const root = path.join(claudeConfigDir(this.home, this.d.env ?? process.env), 'projects');
      const files: Array<{ path: string }> = [];
      for (const dir of await readdir(root)) {
        if (!dir.isDirectory()) continue;
        for (const f of await readdir(path.join(root, dir.name))) {
          if (f.isFile() && f.name.endsWith('.jsonl'))
            files.push({ path: path.join(root, dir.name, f.name) });
        }
      }
      entries = await statAll(files);
    } else if (backend === 'codex') {
      const files: Array<{ path: string }> = [];
      const walk = async (d: string, depth: number): Promise<void> => {
        if (depth < 0) return;
        for (const e of await readdir(d)) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p, depth - 1);
          else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) files.push({ path: p });
        }
      };
      // 尊重 CODEX_HOME（与 codex 本身、用量统计一致）
      await walk(path.join(codexHomeDir(this.home, this.d.env ?? process.env), 'sessions'), 4);
      entries = await statAll(files);
    } else if (backend === 'gemini') {
      // 只列主会话：子代理在 chats/<父会话 id>/ 下，文件名也不带 session- 前缀
      const root = path.join(this.geminiRoot(), 'tmp');
      const files: Array<{ path: string }> = [];
      for (const proj of await readdir(root)) {
        if (!proj.isDirectory()) continue;
        const chats = path.join(root, proj.name, 'chats');
        for (const f of await readdir(chats)) {
          if (f.isFile() && /^session-.*\.jsonl?$/.test(f.name))
            files.push({ path: path.join(chats, f.name) });
        }
      }
      entries = await statAll(files);
    } else if (backend === 'grok') {
      const root = path.join(grokHomeDir(this.home, this.d.env ?? process.env), 'sessions');
      const files: Array<{ path: string; dirId?: string }> = [];
      const walk = async (d: string, depth: number): Promise<void> => {
        if (depth < 0) return;
        for (const e of await readdir(d)) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) await walk(p, depth - 1);
          else if (e.isFile() && e.name === 'updates.jsonl')
            files.push({ path: p, dirId: path.basename(path.dirname(p)) });
        }
      };
      await walk(root, 4);
      entries = await statAll(files);
    } else {
      const root = path.join(this.dshHome, 'sessions');
      const files: Array<{ path: string; dirId: string }> = [];
      for (const proj of await readdir(root)) {
        if (!proj.isDirectory()) continue;
        for (const s of await readdir(path.join(root, proj.name))) {
          if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
          const dir = path.join(root, proj.name, s.name);
          const f = (await readdir(dir)).find(
            (x) => x.isFile() && /^session\.v\d+\.jsonl/.test(x.name),
          );
          if (f) files.push({ path: path.join(dir, f.name), dirId: s.name });
        }
      }
      entries = await statAll(files);
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
      const head = await readHead(f.path, 512 * 1024);
      const info = parseCodexSession(head, '');
      const sessionId =
        info.sessionId ??
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(f.path)?.[1];
      if (!sessionId || !info.title) return null;
      return {
        key: `codex:${sessionId}`,
        backend,
        sessionId,
        title: info.title,
        cwd: info.cwd,
        ...(info.model ? { model: info.model } : {}),
        ...(info.reasoningEffort ? { reasoningEffort: info.reasoningEffort } : {}),
        ...(info.permissionMode
          ? { permissionMode: normalizePermissionMode('codex', info.permissionMode) }
          : {}),
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
        visible.push({
          ...m,
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
      if (f.path.endsWith('.zstd')) {
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
      });
      const notice = r.reused
        ? undefined
        : (tr.note ?? (tr.truncated ? t('历史较长，只显示了最近的部分消息') : undefined));
      return { ok: true, tab: r.tab, reused: r.reused, notice };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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

/** 将 CLI 日志里的原生安全模式映射成 Nomi 的统一档位；未知值降到最安全的 plan。 */
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
