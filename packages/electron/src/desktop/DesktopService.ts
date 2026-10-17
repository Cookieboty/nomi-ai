import * as fs from 'fs';
import * as path from 'path';

import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';
import type { DesktopBubble } from '@nomi-ai/types';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  type IpcMainInvokeEvent,
} from 'electron';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import { iconImage } from '../core/appIcon';
import { t as tr } from '../i18n';
import { AgentBrowser } from '../sandbox/AgentBrowser';
import { CodeSandbox } from '../sandbox/CodeSandbox';
import { sanitizeRepeat } from '../schedule/recurrence';

import { AppTrash } from './AppTrash';
import { AuditLog } from './AuditLog';
import { isLocalBaseURL, sanitizePolicy, type Policy } from './consent';
import { NotesStore } from './notes/NotesStore';
import { isSupported } from './parse/extract';
import { parseFile } from './parse/runParse';
import { guardPath } from './pathGuard';
import { PermissionBroker, type ConfirmRequest } from './PermissionBroker';
import { ReminderStore, resolveDue, type Reminder } from './reminders/ReminderStore';
import { createDesktopTools, summarizeText, TOOL_DANGER, type ProviderInfo } from './tools';
import { UndoJournal } from './UndoJournal';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type Role = 'chat' | 'agent-tools' | 'summary';

export interface DesktopRuntimeHooks {
  /** 非流式调用 LLM（summary 角色） */
  complete(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    role: Role,
    signal?: AbortSignal,
  ): Promise<string>;
  /** 某个角色当前路由到的 provider（id / 名字 / baseURL） */
  resolveProvider(role: Role): { id: string; name: string; baseURL?: string } | null;
}

export interface DesktopWindows {
  main(): BrowserWindow | null;
  openChat(): Promise<BrowserWindow>;
}

export const DESKTOP_CHANGED = 'ai:desktop:changed';
export const DESKTOP_SUMMARY = 'ai:desktop:summary';
export const DESKTOP_OPEN_PANEL = 'ai:desktop:open-panel';
export const DESKTOP_P2_CHANGED = 'ai:desktop:p2-changed';

/**
 * 桌面能力服务（主进程）：组装权限中枢 / 审计 / 撤销 / 回收站 / 解析子进程，
 * 为 AI 工具循环提供 ToolDefinition，并处理设置面板、确认气泡、拖文件到看板娘等 IPC。
 */
export class DesktopService {
  readonly broker: PermissionBroker;
  readonly audit: AuditLog;
  readonly trash: AppTrash;
  readonly journal: UndoJournal;
  readonly notes: NotesStore;
  readonly reminders: ReminderStore;
  private remindersStarted = false;
  /** 免打扰 / 系统通知策略（由 SchedulerService 注入；未注入时始终提醒 + 系统通知） */
  notifyPolicy: { quiet(): boolean; quietEndsAt(): number; osNotify(): boolean } | null = null;
  private deferred: Reminder[] = [];
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private runtime: DesktopRuntimeHooks | null = null;
  private windows: DesktopWindows | null = null;
  private toolDefs: ToolDefinition[] | null = null;
  private ipcRegistered = false;

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    opts: { denyRoots?: string[] } = {},
  ) {
    this.broker = new PermissionBroker(path.join(root, 'settings.json'), {
      home: app.getPath('home'),
      platform: process.platform,
      realpath: (p) => fs.promises.realpath(p),
      denyRoots: opts.denyRoots ?? [],
    });
    this.audit = new AuditLog(path.join(root, 'audit'));
    this.trash = new AppTrash(path.join(root, 'trash'));
    this.journal = new UndoJournal(path.join(root, 'journal.jsonl'), this.trash);
    this.notes = new NotesStore(path.join(root, 'notes'));
    this.reminders = new ReminderStore(path.join(root, 'reminders.json'));
    this.reminders.onFire = (r) => this.fireReminder(r);
    this.reminders.onChange(() => this.broadcast(DESKTOP_P2_CHANGED, { kind: 'reminders' }));
    try {
      this.trash.purge(30);
      this.audit.rotate();
    } catch (e) {
      logger.warn('桌面能力：清理回收站 / 审计日志失败', { error: String(e) });
    }
    this.broker.ui = {
      request: (req) => this.sendConfirm(req),
      cancel: (id) => this.main()?.webContents.send('desktop:confirm-cancel', id),
    };
    this.broker.onChange(() => this.broadcast(DESKTOP_CHANGED, this.state()));
  }

  attachRuntime(h: DesktopRuntimeHooks): void {
    this.runtime = h;
  }

  attachWindows(w: DesktopWindows): void {
    this.windows = w;
  }

  private main(): BrowserWindow | null {
    const w = this.windows?.main();
    return w && !w.isDestroyed() ? w : null;
  }

  private broadcast(ch: string, payload: unknown): void {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }

  private sendConfirm(req: ConfirmRequest): void {
    const w = this.main();
    this.logger.info('桌面工具确认请求', { tool: req.tool, danger: req.danger, hasWindow: !!w });
    if (!w) return;
    if (!w.isVisible()) w.showInactive();
    w.webContents.send('desktop:confirm-request', req);
    broadcastMascotCommand({ type: 'motion', name: 'think' });
    broadcastMascotCommand({
      type: 'expression',
      name: req.danger === 'destructive' ? 'surprised' : 'relaxed',
    });
  }

  say(text: string, opts: Omit<DesktopBubble, 'text'> = {}): void {
    this.main()?.webContents.send('desktop:bubble', { text, ...opts });
  }

  /** 到点：看板娘挥手 + 提醒卡片（气泡）+ 系统通知 */
  private fireReminder(r: Reminder): void {
    const pol = this.notifyPolicy;
    if (pol?.quiet()) {
      // 免打扰：先攒着，结束时一起播报
      this.deferred.push(r);
      if (!this.deferTimer) {
        const wait = Math.max(1000, pol.quietEndsAt() - Date.now());
        this.deferTimer = setTimeout(() => this.flushDeferred(), Math.min(wait, 2 ** 31 - 1));
      }
      this.audit.append({
        tool: 'reminder_deferred',
        args: { id: r.id, text: r.text },
        decision: 'auto',
        result: 'ok',
        source: 'scheduler',
      });
      return;
    }
    this.deliverReminder(r, pol?.osNotify() ?? true);
  }

  /** 免打扰结束：一次性补报 */
  flushDeferred(): void {
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    const items = this.deferred;
    this.deferred = [];
    if (!items.length) return;
    if (items.length > 1) this.say(tr('免打扰期间有 {0} 条提醒，我一条条告诉你～', items.length));
    for (const r of items) this.deliverReminder(r, this.notifyPolicy?.osNotify() ?? true);
  }

  deferredCount(): number {
    return this.deferred.length;
  }

  private deliverReminder(r: Reminder, osNotify: boolean): void {
    const w = this.main();
    this.logger.info('提醒触发', { id: r.id, hasWindow: !!w });
    if (w) {
      if (!w.isVisible()) w.showInactive();
      w.webContents.send('desktop:reminder', {
        id: r.id,
        text: r.text,
        dueAt: r.dueAt,
        missed: false,
      });
    }
    broadcastMascotCommand({ type: 'motion', name: 'wave' });
    broadcastMascotCommand({ type: 'expression', name: 'happy' });
    try {
      if (osNotify && Notification.isSupported()) {
        const n = new Notification({
          title: tr('提醒'),
          body: r.text,
          silent: false,
          icon: iconImage(),
        });
        n.on('click', () => {
          const mw = this.main();
          if (mw && !mw.isVisible()) mw.showInactive();
        });
        n.show();
      }
    } catch (e) {
      this.logger.warn('系统通知失败', { error: String(e) });
    }
    this.audit.append({
      tool: 'reminder_fire',
      args: { id: r.id, text: r.text },
      decision: 'auto',
      result: 'ok',
      source: 'scheduler',
    });
  }

  private missedQueue: Reminder[] = [];

  /** 开始调度；关闭期间错过的提醒由看板娘窗口挂载后拉取并播报一次 */
  startReminders(): void {
    if (this.remindersStarted) return;
    this.remindersStarted = true;
    this.missedQueue = this.reminders.start();
  }

  /** 看板娘窗口拉取错过的提醒（拉取即视为已播报） */
  takeMissed(): Array<{ id: string; text: string; dueAt: number }> {
    this.startReminders(); // 窗口可能比 startReminders 先就绪
    const items = this.missedQueue;
    this.missedQueue = [];
    if (items.length) {
      this.reminders.markAnnounced(items.map((r) => r.id));
      broadcastMascotCommand({ type: 'motion', name: 'wave' });
    }
    return items.map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt }));
  }

  providerFor(role: Role): ProviderInfo | null {
    const p = this.runtime?.resolveProvider(role);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      local: isLocalBaseURL(p.baseURL),
      model:
        (p as { defaultModel?: string; model?: string }).defaultModel ??
        (p as { model?: string }).model,
    };
  }

  private async summarize(
    text: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.runtime) throw new Error(tr('AI runtime 未就绪'));
    return this.runtime.complete(
      [
        { role: 'system', content: instruction },
        { role: 'user', content: `<file_content trust="untrusted">\n${text}\n</file_content>` },
      ],
      'summary',
      signal,
    );
  }

  async pickFolder(suggested?: string): Promise<string | null> {
    const parent = this.windows ? BrowserWindow.getFocusedWindow() : null;
    const opts: Electron.OpenDialogOptions = {
      title: tr('授权 Nomi 访问这个文件夹'),
      buttonLabel: tr('授权'),
      properties: ['openDirectory', 'createDirectory'],
      ...(suggested
        ? { defaultPath: suggested.replace(/^~(?=$|[\\/])/, app.getPath('home')) }
        : {}),
    };
    const r = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  }

  tools(): ToolDefinition[] {
    this.toolDefs ??= createDesktopTools({
      broker: this.broker,
      audit: this.audit,
      journal: this.journal,
      trash: this.trash,
      parse: (p) => parseFile(p),
      summarize: (t, i, s) => this.summarize(t, i, s),
      providerFor: (r) => this.providerFor(r),
      pickFolder: (s) => this.pickFolder(s),
      p2: {
        notes: this.notes,
        reminders: this.reminders,
        trashNote: (f) => this.trash.trash(f),
        clipboard: {
          readText: () => clipboard.readText(),
          writeText: (t) => clipboard.writeText(t),
        },
        say: (t) => this.say(t),
      },
      p3: { browser: new AgentBrowser(), code: new CodeSandbox() },
    });
    return this.toolDefs;
  }

  state() {
    return {
      ...this.broker.view(),
      tools: Object.entries(TOOL_DANGER)
        .filter(([n]) => n !== 'desktop_permissions')
        .map(([name, danger]) => ({
          name,
          danger,
          policy: this.broker.policy(name, danger),
          // 系统选择框本身就是同意；撤销 / 破坏性操作永远询问
          locked:
            name === 'undo_last' || name === 'desktop_request_scope' || danger === 'destructive',
        })),
      pending: this.broker.pendingRequests(),
    };
  }

  /** 把文件拖到看板娘身上：临时授权该文件（只读、仅本次运行）→ 总结 → 气泡 + 对话窗口 */
  async summarizeDropped(raw: string): Promise<{ ok: boolean; code?: string }> {
    const t0 = Date.now();
    const say = (text: string) => this.main()?.webContents.send('desktop:bubble', { text });
    const fail = (code: string, text: string) => {
      say(text);
      broadcastMascotCommand({ type: 'expression', name: 'sad' });
      this.audit.append({
        tool: 'drop_summarize',
        args: { path: raw },
        decision: 'user',
        result: code,
        ms: Date.now() - t0,
        source: 'drop',
      });
      return { ok: false, code };
    };
    // 先按“只授权这一个文件”的范围过一遍守卫（黑名单 / UNC / 设备路径等）
    const probe = await guardPath(
      raw,
      {
        scopes: [{ id: 'probe', path: raw, mode: 'read', kind: 'file', grantedAt: Date.now() }],
        home: app.getPath('home'),
        platform: process.platform,
        realpath: (p) => fs.promises.realpath(p),
      },
      { need: 'read' },
    );
    if (!probe.ok)
      return fail(
        probe.code,
        probe.code === 'denied' ? tr('这个文件受保护，我不能读哦。') : tr('这个文件我打不开…'),
      );
    if (!isSupported(probe.real))
      return fail('unsupported', tr('这种文件我还读不懂（支持 txt / md / pdf / docx 等）。'));
    this.broker.grant(probe.real, 'read', 'file', true);
    const name = path.basename(probe.real);
    say(tr('读一下「{0}」…', name));
    broadcastMascotCommand({ type: 'motion', name: 'think' });
    const parsed = await parseFile(probe.real);
    if (!parsed.ok) return fail(parsed.code, tr('读取失败：{0}', parsed.message));
    if (!parsed.text.trim()) return fail('empty', tr('没读到文字（可能是扫描版 PDF）。'));
    const send = await this.broker.checkSend(this.providerFor('summary'));
    if (send === 'local_only')
      return fail('local_only', tr('已开启「仅本地模型可读文件」，当前模型在云端。'));
    if (send === 'user_denied') return fail('user_denied', tr('好的，不发送。'));
    let summary: string;
    try {
      summary = await summarizeText(
        { summarize: (t, i, s) => this.summarize(t, i, s) },
        parsed.text,
        { style: 'bullets', language: 'auto', maxWords: 250 },
        name,
      );
    } catch (e) {
      return fail('llm_error', tr('总结失败：{0}', e instanceof Error ? e.message : String(e)));
    }
    this.audit.append({
      tool: 'drop_summarize',
      args: { path: probe.real },
      decision: 'user',
      result: 'ok',
      ms: Date.now() - t0,
      source: 'drop',
      provider: this.providerFor('summary')?.id,
    });
    const short = summary.replace(/\s+/g, ' ').trim();
    say(short.length > 90 ? tr('{0}…（完整内容在对话窗口）', short.slice(0, 90)) : short);
    broadcastMascotCommand({ type: 'motion', name: 'nod' });
    broadcastMascotCommand({ type: 'expression', name: 'happy' });
    if (this.windows) {
      const existed = BrowserWindow.getAllWindows().length > 1;
      const chat = await this.windows.openChat();
      const payload = { name, path: probe.real, summary, at: Date.now() };
      const deliver = () => !chat.isDestroyed() && chat.webContents.send(DESKTOP_SUMMARY, payload);
      if (chat.webContents.isLoading())
        chat.webContents.once('did-finish-load', () => setTimeout(deliver, 600));
      else setTimeout(deliver, existed ? 0 : 600);
    }
    return { ok: true };
  }

  registerIpc(): void {
    if (this.ipcRegistered) return;
    this.ipcRegistered = true;
    const handle = (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, fn);
    };
    handle('ai:desktop:state', () => this.state());
    handle('ai:desktop:grant', async (_e, mode) => {
      const picked = await this.pickFolder();
      if (!picked) return null;
      const s = this.broker.grant(picked, mode === 'read-write' ? 'read-write' : 'read');
      this.audit.append({
        tool: 'grant_scope',
        args: { path: s.path, mode: s.mode },
        decision: 'user',
        result: 'ok',
        source: 'settings',
      });
      return s;
    });
    handle('ai:desktop:revoke', (_e, id) => {
      const ok = typeof id === 'string' && this.broker.revoke(id);
      if (ok)
        this.audit.append({
          tool: 'revoke_scope',
          args: { id: id as string },
          decision: 'user',
          result: 'ok',
          source: 'settings',
        });
      return ok;
    });
    handle('ai:desktop:set-policy', (_e, tool, policy) => {
      if (typeof tool !== 'string' || !(tool in TOOL_DANGER)) return false;
      this.broker.setPolicy(
        tool,
        TOOL_DANGER[tool],
        sanitizePolicy(TOOL_DANGER[tool], policy as Policy),
      );
      return true;
    });
    handle('ai:desktop:set-local-only', (_e, v) => {
      this.broker.setLocalOnly(v === true);
      return true;
    });
    handle('ai:desktop:reset-cloud-acks', () => {
      this.broker.resetCloudAcks();
      return true;
    });
    handle('ai:desktop:audit', (_e, limit) =>
      this.audit.list(typeof limit === 'number' ? Math.min(1000, limit) : 200),
    );
    handle('ai:desktop:audit-clear', () => {
      this.audit.clear();
      this.broadcast(DESKTOP_CHANGED, this.state());
      return true;
    });
    handle('ai:desktop:journal', () => this.journal.list(50));
    handle('ai:desktop:undo-last', async () => {
      const e = this.journal.last();
      if (!e) return { ok: false, error: tr('没有可撤销的操作') };
      try {
        await this.journal.undo(e);
        this.audit.append({
          tool: 'undo_last',
          args: { id: e.id },
          decision: 'user',
          result: 'ok',
          source: 'settings',
        });
        this.broadcast(DESKTOP_CHANGED, this.state());
        return { ok: true, undone: e.summary };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    handle('ai:desktop:reset-all', () => {
      this.broker.resetAll();
      this.audit.clear();
      return true;
    });

    // ---- 笔记 / 提醒面板（用户在设置面板里直接操作：不需要再确认，但记审计、可撤销）----
    const userAudit = (tool: string, args: Record<string, unknown>, result = 'ok') =>
      this.audit.append({ tool, args, decision: 'user', result, source: 'settings' });
    const notesChanged = () => this.broadcast(DESKTOP_P2_CHANGED, { kind: 'notes' });
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    handle('ai:desktop:notes-list', (_e, q) =>
      typeof q === 'string' && q.trim()
        ? this.notes.search(q, 50)
        : this.notes.list({ limit: 200 }),
    );
    handle('ai:desktop:notes-read', (_e, id) =>
      typeof id === 'string' ? this.notes.get(id) : null,
    );
    handle('ai:desktop:notes-save', (_e, raw) => {
      const o = (raw ?? {}) as { id?: string; title?: unknown; body?: unknown; tags?: unknown };
      const title = str(o.title, 200).trim() || tr('无标题');
      const body = str(o.body, 200_000);
      const tags = Array.isArray(o.tags) ? (o.tags as string[]) : undefined;
      if (o.id) {
        const { before, after } = this.notes.update(o.id, { title, body, tags });
        this.journal.record('note_update', tr('修改笔记「{0}」', after.title), [
          { op: 'custom', kind: 'note-restore', payload: before },
        ]);
        userAudit('note_update', { id: after.id, title: after.title });
        notesChanged();
        return after;
      }
      const n = this.notes.create({ title, body, tags });
      this.journal.record('note_create', tr('新建笔记「{0}」', n.title), [
        { op: 'trash', path: this.notes.fileOf(n.id) },
        { op: 'custom', kind: 'note-forget', payload: n.id },
      ]);
      userAudit('note_create', { id: n.id, title: n.title });
      notesChanged();
      return n;
    });
    handle('ai:desktop:notes-trash', async (_e, id) => {
      const n = typeof id === 'string' ? this.notes.get(id) : null;
      if (!n) return false;
      const rec = await this.trash.trash(this.notes.fileOf(n.id));
      this.notes.forget(n.id);
      this.journal.record('note_trash', tr('删除笔记「{0}」', n.title), [
        { op: 'restore', stored: rec.stored, original: rec.original },
        { op: 'custom', kind: 'note-forget', payload: n.id },
      ]);
      userAudit('note_trash', { id: n.id, title: n.title });
      notesChanged();
      return true;
    });
    handle('ai:desktop:reminders-list', (_e, all) =>
      this.reminders.list({ includeEnded: all === true, limit: 200 }),
    );
    handle('ai:desktop:reminders-create', (_e, raw) => {
      const o = (raw ?? {}) as {
        text?: unknown;
        at?: unknown;
        inMinutes?: unknown;
        repeat?: unknown;
      };
      const text = str(o.text, 500).trim();
      const due = resolveDue(
        {
          at: typeof o.at === 'string' ? o.at : undefined,
          inMinutes: typeof o.inMinutes === 'number' ? o.inMinutes : undefined,
        },
        Date.now(),
      );
      if (!text || due === null || due < Date.now() - 1000) return null;
      const r = this.reminders.create(text, due, sanitizeRepeat(o.repeat));
      userAudit('reminder_create', { id: r.id, text: r.text, repeat: r.repeat?.kind });
      return r;
    });
    handle('ai:desktop:reminders-update', (_e, id, raw) => {
      const o = (raw ?? {}) as { text?: unknown; at?: unknown; repeat?: unknown };
      const due = typeof o.at === 'string' ? Date.parse(o.at) : undefined;
      try {
        const { after } = this.reminders.update(String(id), {
          text: typeof o.text === 'string' ? str(o.text, 500) : undefined,
          dueAt: Number.isFinite(due) ? due : undefined,
          repeat: o.repeat === null ? null : sanitizeRepeat(o.repeat),
        });
        userAudit('reminder_update', { id: after.id });
        return after;
      } catch {
        return null;
      }
    });
    handle('ai:desktop:reminders-cancel', (_e, id) => {
      try {
        const { before } = this.reminders.cancel(String(id));
        this.journal.record('reminder_cancel', tr('取消提醒「{0}」', before.text), [
          { op: 'custom', kind: 'reminder-restore', payload: before },
        ]);
        userAudit('reminder_cancel', { id: before.id });
        return true;
      } catch {
        return false;
      }
    });
    handle('ai:desktop:reminders-snooze', (_e, id, minutes) => {
      try {
        this.reminders.snooze(String(id), typeof minutes === 'number' ? minutes : 10);
        userAudit('reminder_snooze', { id: String(id) });
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.removeHandler('desktop:reminders-missed');
    ipcMain.handle('desktop:reminders-missed', (e) =>
      e.sender === this.main()?.webContents ? this.takeMissed() : [],
    );
    // 提醒卡片（看板娘窗口）：好的 / 稍后
    ipcMain.on('desktop:reminder-action', (e, id, action, minutes) => {
      if (e.sender !== this.main()?.webContents || typeof id !== 'string') return;
      try {
        if (action === 'snooze')
          this.reminders.snooze(
            id,
            typeof minutes === 'number' ? Math.min(1440, Math.max(1, minutes)) : 10,
          );
        else this.reminders.dismiss(id);
      } catch {
        /* 已不存在 */
      }
    });

    // 确认答复：只接受看板娘窗口（确认气泡 / 对话框所在处）；不走 ai:* 通道，模型与对话窗口都无法伪造
    ipcMain.on('desktop:confirm-answer', (e, id, allow, remember) => {
      if (e.sender !== this.main()?.webContents) {
        this.logger.warn('忽略来自非 Nomi 窗口的确认答复');
        return;
      }
      if (typeof id === 'string') this.broker.answer(id, allow === true, remember === true);
    });
    ipcMain.on('desktop:drop-file', (e, p) => {
      if (e.sender !== this.main()?.webContents || typeof p !== 'string' || !p) return;
      void this.summarizeDropped(p);
    });
  }
}

let instance: DesktopService | null = null;

export function getDesktopService(logger?: Logger): DesktopService {
  if (!instance) {
    const userData = app.getPath('userData');
    instance = new DesktopService(path.join(userData, 'desktop'), logger ?? console, {
      // 应用自己的数据目录（provider key、对话记录、模型…）永远不对工具开放
      denyRoots: [userData],
    });
  }
  return instance;
}
