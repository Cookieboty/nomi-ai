/**
 * 本地情节长期记忆：对话结束（或积累一定轮数）后由聊天模型做摘要 → 情节 + 用户事实，
 * 存在 userData/memory；新问题到来时 BM25（+ 可选向量，复用知识库的向量服务）召回，
 * 连同用户档案（persona.md）拼进 system。可在「记忆」面板里查看 / 编辑 / 删除 / 导出。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';
import { BrowserWindow, dialog, shell } from 'electron';
import { z } from 'zod';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { DesktopService } from '../desktop/DesktopService';
import { t as tr } from '../i18n';
import { b64ToVec, vecToB64 } from '../knowledge/vector';
import { guardedHandle } from '../security/guardedIpc';

import {
  DEFAULT_MEMORY_SETTINGS,
  FACT_KINDS,
  buildMemoryContext,
  episodeText,
  exportMarkdown,
  isDuplicateFact,
  parseSummary,
  recall,
  sanitizeMemorySettings,
  summaryPrompt,
  type Episode,
  type Fact,
  type FactKind,
  type MemorySettings,
  type TurnMsg,
} from './episodes';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export interface MemoryFacadeLike {
  facts: { put(f: unknown): unknown; delete(id: string): boolean };
  summaries: { put(s: unknown): unknown };
  userProfile: { get(): unknown; reset(): Promise<unknown> };
}

export interface MemoryDeps {
  root: string;
  logger: Logger;
  desktop: DesktopService;
  complete(messages: Msg[], signal?: AbortSignal): Promise<string>;
  embed(texts: string[]): Promise<Float32Array[] | null>;
  /** 主进程 AIClient.memory（MemoryFacade）：情节 / 事实同步进去，偏好从这里读 */
  facade(): MemoryFacadeLike | null;
}

interface Store {
  v: 1;
  episodes: Episode[];
  facts: Fact[];
}

export class MemError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 发给摘要模型的最近消息条数上限（只限制上下文，不参与「是否有新内容」判断） */
const SUMMARY_WINDOW = 80;
const MAX_EPISODES = 2000;
const MAX_FACTS = 500;

export class MemoryService {
  private settings: MemorySettings;
  private data: Store;
  private busy = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private ipcDone = false;
  private lastError = '';

  constructor(private readonly d: MemoryDeps) {
    this.settings = this.readJson('settings.json', sanitizeMemorySettings, {
      ...DEFAULT_MEMORY_SETTINGS,
    });
    this.data = this.readJson(
      'memory.json',
      (j) => {
        const o = j as Partial<Store>;
        return {
          v: 1,
          episodes: Array.isArray(o?.episodes) ? o.episodes : [],
          facts: Array.isArray(o?.facts) ? o.facts : [],
        };
      },
      { v: 1, episodes: [], facts: [] },
    );
    this.syncFacade();
  }

  // ---------- 持久化 ----------
  private file(n: string) {
    return path.join(this.d.root, n);
  }
  private readJson<T>(n: string, parse: (j: unknown) => T, fallback: T): T {
    try {
      return parse(JSON.parse(fs.readFileSync(this.file(n), 'utf8')));
    } catch {
      return fallback;
    }
  }
  private writeJson(n: string, v: unknown) {
    fs.mkdirSync(this.d.root, { recursive: true });
    const tmp = this.file(`${n}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(tmp, this.file(n));
  }
  private persist(now = false) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const run = () => {
      this.saveTimer = null;
      try {
        this.writeJson('memory.json', this.data);
      } catch (e) {
        this.d.logger.warn('memory save failed', e);
      }
    };
    if (now) run();
    else this.saveTimer = setTimeout(run, 300);
    this.broadcast('ai:mem:changed', null);
  }
  flush() {
    if (this.saveTimer) this.persist(true);
  }

  private syncFacade() {
    const f = this.d.facade();
    if (!f) return;
    try {
      for (const x of this.data.facts)
        f.facts.put({ id: x.id, kind: x.kind, text: x.text, source: x.source, at: x.updatedAt });
      for (const e of this.data.episodes)
        f.summaries.put({
          sessionId: e.conversationId,
          summary: e.summary,
          updatedAt: e.updatedAt,
          stepCount: e.messageCount,
        });
    } catch {
      /* facade 不可用不影响本地记忆 */
    }
  }

  // ---------- 设置 / 档案 ----------
  getSettings(): MemorySettings {
    return { ...this.settings };
  }
  setSettings(patch: unknown): MemorySettings {
    this.settings = sanitizeMemorySettings({
      ...this.settings,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    this.writeJson('settings.json', this.settings);
    this.broadcast('ai:mem:changed', null);
    return this.getSettings();
  }

  get personaFile() {
    return this.file('persona.md');
  }
  persona(): string {
    try {
      return fs.readFileSync(this.personaFile, 'utf8');
    } catch {
      return '';
    }
  }
  setPersona(text: string): boolean {
    fs.mkdirSync(this.d.root, { recursive: true });
    fs.writeFileSync(this.personaFile, String(text).slice(0, 8000), { mode: 0o600 });
    this.audit('memory_persona_save', {});
    this.broadcast('ai:mem:changed', null);
    return true;
  }
  async openPersona(): Promise<boolean> {
    if (!fs.existsSync(this.personaFile)) this.setPersona('');
    return (await shell.openPath(this.personaFile)) === '';
  }

  // ---------- 摘要 ----------
  /**
   * 对一段会话做摘要。同一会话再次摘要时更新原条目（除非用户手动改过），
   * 新消息不足 2 条时跳过。返回新建 / 更新的情节，或跳过原因。
   */
  async ingest(
    conversationId: string,
    msgs: TurnMsg[],
    opts: { force?: boolean } = {},
  ): Promise<{ episode?: Episode; skipped?: string }> {
    if (!this.settings.enabled) return { skipped: 'disabled' };
    if (!opts.force && !this.settings.autoSummarize) return { skipped: 'auto-off' };
    const all = msgs.filter(
      (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim(),
    );
    // 有效消息总数用来判断「有没有新内容」并持久化；只有发给摘要模型的上下文才截成最近 80 条。
    // （旧版本把截断后的 80 当作 messageCount 存盘，超过 80 条后差值恒为 0，摘要永久停更）
    const total = all.length;
    const clean = all.slice(-SUMMARY_WINDOW);
    const prev = this.data.episodes.find((e) => e.conversationId === conversationId);
    if (total < (opts.force ? 2 : this.settings.minMessages)) return { skipped: 'too-short' };
    // 新增不足 2 条才跳过；历史比上次摘要时更短（被裁剪 / 删除 / 重新生成）说明内容变了，不跳过
    if (prev && !opts.force) {
      const added = total - prev.messageCount;
      if (added >= 0 && added < 2) return { skipped: 'no-new' };
    }
    if (prev?.edited && !opts.force) return { skipped: 'edited' };
    if (this.busy.has(conversationId)) return { skipped: 'busy' };
    this.busy.add(conversationId);
    this.broadcast('ai:mem:status', { busy: [...this.busy] });
    const t0 = Date.now();
    try {
      const raw = await this.d.complete(summaryPrompt(clean), AbortSignal.timeout(90_000));
      const p = parseSummary(raw);
      if (!p) throw new MemError('bad-summary', tr('模型没有返回可用的摘要'));
      const now = Date.now();
      const ep: Episode = prev
        ? {
            ...prev,
            ...p,
            updatedAt: now,
            messageCount: total,
            edited: false,
            vec: undefined,
          }
        : {
            id: randomUUID(),
            conversationId,
            title: p.title,
            summary: p.summary,
            keywords: p.keywords,
            createdAt: now,
            updatedAt: now,
            messageCount: total,
            pinned: false,
            edited: false,
          };
      delete (ep as Partial<ParsedLike>).facts;
      if (prev) this.data.episodes = this.data.episodes.map((e) => (e.id === prev.id ? ep : e));
      else this.data.episodes.push(ep);
      const newFacts: Fact[] = [];
      for (const f of p.facts) {
        if (this.data.facts.some((x) => isDuplicateFact(x.text, f.text))) continue;
        newFacts.push({
          id: randomUUID(),
          kind: f.kind,
          text: f.text,
          source: 'distilled',
          createdAt: now,
          updatedAt: now,
          episodeId: ep.id,
        });
      }
      this.data.facts.push(...newFacts);
      this.trim();
      await this.embedItems([ep], newFacts);
      this.persist();
      this.syncFacade();
      this.lastError = '';
      this.audit(
        'memory_summarize',
        { conversation: conversationId, facts: newFacts.length },
        'ok',
        Date.now() - t0,
      );
      broadcastMascotCommand({ type: 'motion', name: 'nod' });
      return { episode: this.view(ep) };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.audit('memory_summarize', { conversation: conversationId }, 'error');
      throw e instanceof MemError
        ? e
        : new MemError('summarize-failed', tr('摘要失败：{0}', this.lastError));
    } finally {
      this.busy.delete(conversationId);
      this.broadcast('ai:mem:status', { busy: [...this.busy] });
    }
  }

  private trim() {
    if (this.data.episodes.length > MAX_EPISODES) {
      const keep = [...this.data.episodes].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
      );
      this.data.episodes = keep.slice(0, MAX_EPISODES);
    }
    if (this.data.facts.length > MAX_FACTS) this.data.facts = this.data.facts.slice(-MAX_FACTS);
  }

  private async embedItems(eps: Episode[], facts: Fact[]) {
    const texts = [...eps.map(episodeText), ...facts.map((f) => f.text)];
    if (!texts.length) return;
    const vecs = await this.d.embed(texts);
    if (!vecs) return;
    eps.forEach((e, i) => (e.vec = vecToB64(vecs[i])));
    facts.forEach((f, i) => (f.vec = vecToB64(vecs[eps.length + i])));
  }

  /** 为缺向量的条目补向量（开启向量服务后在面板里点「补全向量」） */
  async backfillVectors(): Promise<number> {
    const eps = this.data.episodes.filter((e) => !e.vec);
    const facts = this.data.facts.filter((f) => !f.vec);
    let n = 0;
    for (let i = 0; i < eps.length; i += 32) {
      const batch = eps.slice(i, i + 32);
      await this.embedItems(batch, []);
      n += batch.filter((e) => e.vec).length;
    }
    for (let i = 0; i < facts.length; i += 32) {
      const batch = facts.slice(i, i + 32);
      await this.embedItems([], batch);
      n += batch.filter((f) => f.vec).length;
    }
    if (n) this.persist();
    return n;
  }

  // ---------- 召回 ----------
  async context(
    query: string,
  ): Promise<{ text: string; used: Array<{ id: string; kind: string; title: string }> }> {
    if (!this.settings.enabled) return { text: '', used: [] };
    const persona = this.persona();
    let facts: Fact[] = [];
    let eps: Episode[] = [];
    if (
      this.settings.recall &&
      query.trim() &&
      (this.data.episodes.length || this.data.facts.length)
    ) {
      const hasVec = this.data.episodes.some((e) => e.vec) || this.data.facts.some((f) => f.vec);
      const qvec = hasVec ? ((await this.d.embed([query.slice(0, 2000)]))?.[0] ?? null) : null;
      const hits = recall(query, this.data.episodes, this.data.facts, {
        topK: this.settings.topK + 2,
        qvec,
        vecOf: b64ToVec,
      });
      eps = hits
        .filter((h) => h.kind === 'episode')
        .map((h) => this.data.episodes.find((e) => e.id === h.id)!)
        .filter(Boolean)
        .slice(0, this.settings.topK);
      facts = hits
        .filter((h) => h.kind === 'fact')
        .map((h) => this.data.facts.find((f) => f.id === h.id)!)
        .filter(Boolean);
    }
    // 身份类事实始终带上（数量少、对称呼很重要）
    for (const f of this.data.facts)
      if (f.kind === 'identity' && !facts.includes(f) && facts.length < 8) facts.push(f);
    const text = buildMemoryContext({ persona, facts, episodes: eps });
    return {
      text,
      used: [
        ...eps.map((e) => ({ id: e.id, kind: 'episode', title: e.title })),
        ...facts.map((f) => ({ id: f.id, kind: 'fact', title: f.text })),
      ],
    };
  }

  // ---------- 浏览 / 编辑 ----------
  private view(e: Episode): Episode {
    const { vec, ...rest } = e;
    return { ...rest, vec: vec ? '1' : undefined };
  }
  list(filter = ''): { episodes: Episode[]; facts: Fact[] } {
    const q = filter.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    return {
      episodes: [...this.data.episodes]
        .filter((e) => match(episodeText(e)))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        .map((e) => this.view(e)),
      facts: [...this.data.facts]
        .filter((f) => match(f.text))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ vec, ...f }) => ({ ...f, vec: vec ? '1' : undefined })),
    };
  }

  async updateEpisode(id: string, patch: unknown): Promise<Episode> {
    const e = this.data.episodes.find((x) => x.id === id);
    if (!e) throw new MemError('not-found', tr('这条记忆已经不存在了'));
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Episode>;
    let textChanged = false;
    if (typeof p.title === 'string' && p.title.trim()) {
      textChanged ||= p.title.trim() !== e.title;
      e.title = p.title.trim().slice(0, 40);
    }
    if (typeof p.summary === 'string' && p.summary.trim()) {
      textChanged ||= p.summary.trim() !== e.summary;
      e.summary = p.summary.trim().slice(0, 1200);
    }
    if (Array.isArray(p.keywords))
      e.keywords = p.keywords
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);
    if (typeof p.pinned === 'boolean') e.pinned = p.pinned;
    if (textChanged) {
      e.edited = true;
      e.updatedAt = Date.now();
      e.vec = undefined;
      await this.embedItems([e], []);
    }
    this.persist();
    this.syncFacade();
    this.audit('memory_edit', { id });
    return this.view(e);
  }

  async upsertFact(input: unknown): Promise<Fact> {
    const o = (input && typeof input === 'object' ? input : {}) as Partial<Fact>;
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, 200) : '';
    if (!text) throw new MemError('empty', tr('内容不能为空'));
    const kind: FactKind = FACT_KINDS.includes(o.kind as FactKind) ? (o.kind as FactKind) : 'note';
    const now = Date.now();
    let f = o.id ? this.data.facts.find((x) => x.id === o.id) : undefined;
    if (f) Object.assign(f, { text, kind, source: 'user', updatedAt: now, vec: undefined });
    else {
      f = { id: randomUUID(), text, kind, source: 'user', createdAt: now, updatedAt: now };
      this.data.facts.push(f);
    }
    await this.embedItems([], [f]);
    this.persist();
    this.syncFacade();
    this.audit('memory_fact_save', { id: f.id });
    const { vec, ...rest } = f;
    return { ...rest, vec: vec ? '1' : undefined };
  }

  remove(kind: 'episode' | 'fact', id: string): boolean {
    const before = this.data.episodes.length + this.data.facts.length;
    if (kind === 'episode') this.data.episodes = this.data.episodes.filter((e) => e.id !== id);
    else {
      this.data.facts = this.data.facts.filter((f) => f.id !== id);
      try {
        this.d.facade()?.facts.delete(id);
      } catch {
        /* ignore */
      }
    }
    const ok = this.data.episodes.length + this.data.facts.length < before;
    if (ok) {
      this.persist();
      this.audit('memory_delete', { kind, id });
    }
    return ok;
  }

  clearAll(): boolean {
    for (const f of this.data.facts)
      try {
        this.d.facade()?.facts.delete(f.id);
      } catch {
        /* ignore */
      }
    this.data = { v: 1, episodes: [], facts: [] };
    this.persist(true);
    this.audit('memory_clear', {});
    return true;
  }

  profile(): unknown {
    try {
      return this.d.facade()?.userProfile.get() ?? null;
    } catch {
      return null;
    }
  }
  async resetProfile(): Promise<boolean> {
    await this.d.facade()?.userProfile.reset();
    this.audit('memory_profile_reset', {});
    this.broadcast('ai:mem:changed', null);
    return true;
  }

  exportData() {
    const strip = <T extends { vec?: string }>(x: T) => {
      const { vec: _v, ...r } = x;
      return r;
    };
    return {
      format: 'nomi-memory',
      version: 1,
      exportedAt: Date.now(),
      settings: this.settings,
      persona: this.persona(),
      facts: this.data.facts.map(strip),
      episodes: this.data.episodes.map(strip),
      profile: this.profile(),
    };
  }

  async exportToFile(format: 'json' | 'md'): Promise<{ ok: boolean; path?: string }> {
    const win = BrowserWindow.getFocusedWindow();
    const stamp = new Date().toISOString().slice(0, 10);
    const opts = {
      title: tr('导出记忆'),
      defaultPath: `nomi-memory-${stamp}.${format}`,
      filters: [
        format === 'md'
          ? { name: 'Markdown', extensions: ['md'] }
          : { name: 'JSON', extensions: ['json'] },
      ],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false };
    const data = this.exportData();
    const body =
      format === 'md'
        ? exportMarkdown({
            persona: data.persona,
            facts: this.data.facts,
            episodes: this.data.episodes,
            exportedAt: data.exportedAt,
          })
        : JSON.stringify(data, null, 2);
    fs.writeFileSync(r.filePath, body, { mode: 0o600 });
    this.audit('memory_export', {
      format,
      sha: createHash('sha1').update(r.filePath).digest('hex').slice(0, 8),
    });
    return { ok: true, path: r.filePath };
  }

  state() {
    return {
      settings: this.getSettings(),
      stats: {
        episodes: this.data.episodes.length,
        facts: this.data.facts.length,
        vectors:
          this.data.episodes.filter((e) => e.vec).length +
          this.data.facts.filter((f) => f.vec).length,
      },
      busy: [...this.busy],
      lastError: this.lastError,
      personaChars: this.persona().length,
    };
  }

  start(): void {
    this.syncFacade();
  }

  /** 代理工具：memory_search（查过往对话 / 事实）、memory_remember（用户明确要求记住时） */
  tools(): ToolDefinition[] {
    const search = z
      .object({ query: z.string().min(1).max(300).describe(tr('要回忆的话题或关键词')) })
      .strict();
    const remember = z
      .object({
        text: z.string().min(1).max(200).describe(tr('用户要求记住的、关于用户的一句话事实')),
        kind: z
          .enum(['identity', 'preference', 'goal', 'dislike', 'habit', 'note'])
          .default('note'),
      })
      .strict();
    return [
      {
        name: 'memory_search',
        description: tr(
          '在本地长期记忆（过往对话摘要与关于用户的事实）里查找。用户问“我们之前聊过…/你还记得…”时使用。',
        ),
        input: search,
        execute: async (raw: unknown) => {
          if (!this.settings.enabled)
            return { ok: false, error: { code: 'disabled', message: tr('用户关闭了长期记忆') } };
          const { query } = search.parse(raw);
          const r = await this.context(query);
          this.audit('memory_search', { query: query.slice(0, 80) }, 'ok');
          return { ok: true, data: { memory: r.text || tr('（没有相关记忆）') } };
        },
      } as unknown as ToolDefinition,
      {
        name: 'memory_remember',
        description: tr(
          '仅当用户明确要求“记住…”时，把一条关于用户的事实写入本地长期记忆。不要记录密码、密钥等敏感信息。',
        ),
        input: remember,
        execute: async (raw: unknown) => {
          if (!this.settings.enabled)
            return { ok: false, error: { code: 'disabled', message: tr('用户关闭了长期记忆') } };
          const i = remember.parse(raw);
          if (this.data.facts.some((f) => isDuplicateFact(f.text, i.text)))
            return { ok: true, data: { saved: false, reason: tr('已经记住了') } };
          const f = await this.upsertFact(i);
          broadcastMascotCommand({ type: 'motion', name: 'nod' });
          return { ok: true, data: { saved: true, id: f.id } };
        },
      } as unknown as ToolDefinition,
    ];
  }

  // ---------- IPC ----------
  private audit(tool: string, args: Record<string, unknown>, result = 'ok', ms?: number) {
    try {
      this.d.desktop.audit.append({ tool, args, decision: 'user', result, ms, source: 'memory' });
    } catch {
      /* ignore */
    }
  }
  private broadcast(ch: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }

  registerIpc(): void {
    if (this.ipcDone) return;
    this.ipcDone = true;
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) =>
      guardedHandle(
        ch,
        async (...a: unknown[]) => {
          try {
            return await fn(...a);
          } catch (err) {
            if (err instanceof MemError)
              return { __error: { code: err.code, message: err.message } };
            throw err;
          }
        },
        { owner: 'MemoryService', wrapErrors: false },
      );
    const toMsgs = (h: unknown): TurnMsg[] =>
      Array.isArray(h)
        ? (h as Array<{ role: unknown; content: unknown }>)
            .filter(
              (m) =>
                (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string',
            )
            .map((m) => ({
              role: m.role as TurnMsg['role'],
              content: (m.content as string).slice(0, 6000),
            }))
        : [];
    handle('ai:mem:state', () => this.state());
    handle('ai:mem:list', (f) => this.list(typeof f === 'string' ? f : ''));
    handle('ai:mem:set-settings', (p) => this.setSettings(p));
    handle('ai:mem:persona', () => this.persona());
    handle('ai:mem:set-persona', (t) => this.setPersona(String(t ?? '')));
    handle('ai:mem:open-persona', () => this.openPersona());
    handle('ai:mem:ingest', (id, h, force) =>
      this.ingest(String(id ?? ''), toMsgs(h), { force: force === true }),
    );
    handle('ai:mem:context', (q) => this.context(String(q ?? '').slice(0, 4000)));
    handle('ai:mem:update-episode', (id, p) => this.updateEpisode(String(id), p));
    handle('ai:mem:upsert-fact', (p) => this.upsertFact(p));
    handle('ai:mem:remove', (k, id) => this.remove(k === 'fact' ? 'fact' : 'episode', String(id)));
    handle('ai:mem:clear', () => this.clearAll());
    handle('ai:mem:backfill', () => this.backfillVectors());
    handle('ai:mem:profile', () => this.profile());
    handle('ai:mem:reset-profile', () => this.resetProfile());
    handle('ai:mem:export', (fmt) => this.exportToFile(fmt === 'md' ? 'md' : 'json'));
  }
}

type ParsedLike = { facts: unknown };

let instance: MemoryService | null = null;
export function initMemoryService(d: MemoryDeps): MemoryService {
  instance ??= new MemoryService(d);
  return instance;
}
export function getMemoryService(): MemoryService | null {
  return instance;
}
