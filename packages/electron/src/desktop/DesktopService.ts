import * as fs from 'fs';
import * as path from 'path';

import type { ToolCallProvider, ToolDefinition } from '@nomi-ai/bundle-ig-base';
import type { HostPorts } from '@nomi-ai/host-ports';
import type { DesktopBubble } from '@nomi-ai/types';
// 仍需 electron 的部分：旧 IPC 注册层（ipcMain，P1 由契约传输层取代）、系统通知（host-ports 还没有
// notifications 端口）、看板娘窗口对象（显示 / 隐藏 / 按 sender 校验）与窗口数量。
import { BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { AppEvents } from '../core/appEvents';
import { iconImage } from '../core/appIcon';
import { t as tr } from '../i18n';
import { notifyIsland, type IslandKind, type IslandNotice } from '../island/IslandService';
import { AgentBrowser } from '../sandbox/AgentBrowser';
import { CodeSandbox } from '../sandbox/CodeSandbox';
import { sanitizeRepeat } from '../schedule/recurrence';
import { guardedHandle } from '../security/guardedIpc';

import { AppTrash } from './AppTrash';
import { AuditLog } from './AuditLog';
import { isLocalBaseURL, sanitizePolicy, type Policy } from './consent';
import { isSupported } from './parse/extract';
import { parseFile } from './parse/runParse';
import { guardPath } from './pathGuard';
import { PermissionBroker, type ConfirmRequest } from './PermissionBroker';
import { ReminderStore, resolveDue, type Reminder } from './reminders/ReminderStore';
import { createDesktopTools, summarizeText, TOOL_DANGER, type ProviderInfo } from './tools';
import { UndoJournal } from './UndoJournal';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type Role = 'chat' | 'agent-tools' | 'summary';

/** 一条要告诉用户的消息：气泡用 text；灵动岛 / 系统通知用 title + body（缺省 body = text） */
export interface DesktopNotice {
  kind: IslandKind;
  title: string;
  text: string;
  body?: string;
  status?: IslandNotice['status'];
  endpoint?: string;
  bubble?: Omit<DesktopBubble, 'text'>;
  /** 被动消息（如定时汇总）：看板娘不在且灵动岛显示不了时就不弹系统通知 */
  passive?: boolean;
}
export type NoticeChannel = 'bubble' | 'island' | 'notification' | 'none';

export interface DesktopRuntimeHooks {
  /** 非流式调用 LLM（summary 角色） */
  complete(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    role: Role,
    signal?: AbortSignal,
  ): Promise<string>;
  /** 某个角色当前路由到的 provider（id / 名字 / baseURL） */
  resolveProvider(role: Role): { id: string; name: string; baseURL?: string } | null;
  /** 按 id 查 provider（工具调用实际用的 provider 要显示名字用）；查不到返回 null */
  lookupProvider?(id: string): { id: string; name: string; baseURL?: string } | null;
}

export interface DesktopWindows {
  main(): BrowserWindow | null;
  openChat(): Promise<BrowserWindow>;
  /** 看板娘已关闭（窗口隐藏且静音）：提醒不再把她叫出来（系统通知 / 灵动岛照常）；确认框临时显示，答完再藏起 */
  mascotHidden?(): boolean;
}

/** 平台能力：home / userData 路径、文件夹选择器、剪贴板 */
export type DesktopPorts = Pick<HostPorts, 'paths' | 'dialogs' | 'clipboard'>;

export interface DesktopServiceOptions {
  ports: DesktopPorts;
  /** 状态变化广播给所有窗口 */
  events: AppEvents;
  denyRoots?: string[];
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
  readonly reminders: ReminderStore;
  private remindersStarted = false;
  /** 免打扰 / 系统通知策略（由 SchedulerService 注入；未注入时始终提醒 + 系统通知） */
  notifyPolicy: { quiet(): boolean; quietEndsAt(): number } | null = null;
  private deferred: Reminder[] = [];
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private runtime: DesktopRuntimeHooks | null = null;
  private windows: DesktopWindows | null = null;
  private toolDefs: ToolDefinition[] | null = null;
  private ipcRegistered = false;
  private readonly ports: DesktopPorts;
  private readonly events: AppEvents;

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    opts: DesktopServiceOptions,
  ) {
    this.ports = opts.ports;
    this.events = opts.events;
    this.broker = new PermissionBroker(path.join(root, 'settings.json'), {
      home: this.ports.paths.home(),
      platform: process.platform,
      realpath: (p) => fs.promises.realpath(p),
      denyRoots: opts.denyRoots ?? [],
    });
    this.audit = new AuditLog(path.join(root, 'audit'));
    this.trash = new AppTrash(path.join(root, 'trash'));
    this.journal = new UndoJournal(path.join(root, 'journal.jsonl'), this.trash);
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
      cancel: (id) => {
        this.main()?.webContents.send('desktop:confirm-cancel', id);
        this.rehideMascotIfIdle();
      },
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

  private mascotHidden(): boolean {
    return this.windows?.mascotHidden?.() ?? false;
  }

  /** 看板娘已关闭时，确认框全部处理完就把临时显示的窗口再藏起来 */
  private rehideMascotIfIdle(): void {
    if (!this.mascotHidden() || this.broker.pendingRequests().length > 0) return;
    const w = this.main();
    if (w?.isVisible()) w.hide();
  }

  private broadcast(ch: string, payload: unknown): void {
    this.events.publish(ch, payload);
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

  /**
   * 统一的提醒出口，一条消息只走一个渠道：
   * - 看板娘在桌面上 → 只用她的气泡；
   * - 看板娘已关闭 → 灵动岛；灵动岛关闭 / 不支持 / 不接这一类时退回系统通知（免打扰中不弹）。
   * 点系统通知打开对话窗口。返回实际用到的渠道。
   */
  notify(n: DesktopNotice): NoticeChannel {
    if (!this.mascotHidden() && this.main()) {
      this.say(n.text, n.bubble);
      return 'bubble';
    }
    try {
      if (
        notifyIsland({
          kind: n.kind,
          title: n.title,
          body: n.body ?? n.text,
          status: n.status,
          endpoint: n.endpoint,
        })
      )
        return 'island';
    } catch (e) {
      this.logger.warn('灵动岛通知失败', { error: String(e) });
    }
    if (n.passive || this.notifyPolicy?.quiet()) return 'none';
    try {
      if (!Notification.isSupported()) return 'none';
      const note = new Notification({
        title: n.title,
        body: n.body ?? n.text,
        silent: false,
        icon: iconImage(),
      });
      note.on('click', () => void this.windows?.openChat().catch(() => undefined));
      note.show();
      return 'notification';
    } catch (e) {
      this.logger.warn('系统通知失败', { error: String(e) });
      return 'none';
    }
  }

  /** 到点：看板娘在 → 挥手 + 提醒卡片；看板娘已关闭 → 灵动岛或系统通知 */
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
    this.deliverReminders([r]);
  }

  /** 免打扰结束：一次性补报（看板娘在时多条逐张出卡片并先说一句；不在时合成一条通知） */
  flushDeferred(): void {
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    const items = this.deferred;
    this.deferred = [];
    if (!items.length) return;
    if (items.length > 1 && !this.mascotHidden())
      this.say(tr('electron.common.reminders-came-in-during-do-not-disturb-here', items.length));
    this.deliverReminders(items);
  }

  deferredCount(): number {
    return this.deferred.length;
  }

  private deliverReminders(items: Reminder[]): void {
    const w = this.main();
    this.logger.info('提醒触发', {
      count: items.length,
      hasWindow: !!w,
      mascotHidden: this.mascotHidden(),
    });
    // 看板娘已关闭 / 没有窗口：提醒卡片不发给隐藏的看板娘（否则看不见，下次打开她时还会冒出过期卡片）
    if (!w || this.mascotHidden()) {
      this.deliverReminderElsewhere(items);
      return;
    }
    if (!w.isVisible()) w.showInactive();
    for (const r of items) {
      w.webContents.send('desktop:reminder', {
        id: r.id,
        text: r.text,
        dueAt: r.dueAt,
        missed: false,
      });
      this.audit.append({
        tool: 'reminder_fire',
        args: { id: r.id, text: r.text, via: 'bubble' },
        decision: 'auto',
        result: 'ok',
        source: 'scheduler',
      });
    }
    broadcastMascotCommand({ type: 'motion', name: 'wave' });
    broadcastMascotCommand({ type: 'expression', name: 'happy' });
  }

  /** 看板娘不在时的提醒：多条合成一条，走灵动岛或系统通知；都显示不了时只记 via=none 的审计 */
  private deliverReminderElsewhere(items: Reminder[]): void {
    if (!items.length) return;
    const title = tr('electron.common.reminder');
    const body =
      items.length === 1
        ? items[0]!.text
        : tr('electron.common.reminders', items.length, items.map((r) => r.text).join('；'));
    const via = this.notify({ kind: 'reminder', status: 'attention', title, text: body });
    if (via === 'none')
      this.logger.info('提醒没有可用的展示方式（看板娘已隐藏、灵动岛与系统通知都不可用）', {
        count: items.length,
      });
    for (const r of items) {
      this.audit.append({
        tool: 'reminder_fire',
        args: { id: r.id, text: r.text, via },
        decision: 'auto',
        result: via === 'none' ? 'not_shown' : 'ok',
        source: 'scheduler',
      });
    }
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
      // 看板娘已关闭：错过的提醒同样改走灵动岛 / 系统通知，不在隐藏的窗口里攒卡片
      if (this.mascotHidden()) {
        this.deliverReminderElsewhere(items);
        return [];
      }
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

  /** 本轮工具循环实际使用的 provider（ctx.provider）→ 名字 / 本地标记 */
  receiverOf(p: ToolCallProvider): ProviderInfo {
    const known = this.runtime?.lookupProvider?.(p.id);
    return {
      id: p.id,
      name: known?.name ?? p.id,
      local: isLocalBaseURL(p.baseURL ?? known?.baseURL),
    };
  }

  /**
   * 工具结果的接收者：有 ctx.provider 用它；没有就取候选角色里的全部 provider（逐个校验，失败关闭）。
   */
  receiversFor(provider: ToolCallProvider | undefined, roles: Role[]): ProviderInfo[] {
    if (provider) return [this.receiverOf(provider)];
    const out: ProviderInfo[] = [];
    for (const r of roles) {
      const p = this.providerFor(r);
      if (p && !out.some((x) => x.id === p.id)) out.push(p);
    }
    return out;
  }

  /** 对一组接收者逐个做 localOnly / 云端同意校验；返回第一个失败码，全通过返回 null */
  async checkSendAll(
    receivers: ProviderInfo[],
    signal?: AbortSignal,
    what?: string,
  ): Promise<null | 'local_only' | 'user_denied'> {
    for (const r of receivers) {
      const res = await this.broker.checkSend(r, signal, what);
      if (res) return res;
    }
    return null;
  }

  private async summarize(
    text: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.runtime) throw new Error(tr('electron.common.ai-runtime-not-ready'));
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
    return this.ports.dialogs.pickDirectory({
      title: tr('electron.common.grant-nomi-access-to-this-folder'),
      buttonLabel: tr('electron.common.grant'),
      createDirectory: true,
      // 挂到当前焦点窗口（窗口还没接上时独立弹出）
      parent: this.windows ? 'focused' : 'none',
      ...(suggested
        ? { defaultPath: suggested.replace(/^~(?=$|[\\/])/, this.ports.paths.home()) }
        : {}),
    });
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
      describeProvider: (p) => this.receiverOf(p),
      pickFolder: (s) => this.pickFolder(s),
      p2: {
        reminders: this.reminders,
        clipboard: {
          readText: () => this.ports.clipboard.readText(),
          writeText: (t) => void this.ports.clipboard.writeText(t),
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
        home: this.ports.paths.home(),
        platform: process.platform,
        realpath: (p) => fs.promises.realpath(p),
      },
      { need: 'read' },
    );
    if (!probe.ok)
      return fail(
        probe.code,
        probe.code === 'denied'
          ? tr('electron.common.this-file-is-protected-i-can-t-read')
          : tr('electron.common.i-can-t-open-this-file'),
      );
    if (!isSupported(probe.real))
      return fail('unsupported', tr('electron.common.i-can-t-read-this-kind-of-file'));
    this.broker.grant(probe.real, 'read', 'file', true);
    const name = path.basename(probe.real);
    say(tr('electron.common.reading', name));
    broadcastMascotCommand({ type: 'motion', name: 'think' });
    const parsed = await parseFile(probe.real);
    if (!parsed.ok) return fail(parsed.code, tr('electron.common.read-failed', parsed.message));
    if (!parsed.text.trim())
      return fail('empty', tr('electron.common.no-text-found-it-may-be-a-scanned'));
    const send = await this.broker.checkSend(this.providerFor('summary'));
    if (send === 'local_only')
      return fail('local_only', tr('electron.common.only-local-models-can-read-files-is-on'));
    if (send === 'user_denied') return fail('user_denied', tr('electron.common.ok-not-sending'));
    let summary: string;
    try {
      summary = await summarizeText(
        { summarize: (t, i, s) => this.summarize(t, i, s) },
        parsed.text,
        { style: 'bullets', language: 'auto', maxWords: 250 },
        name,
      );
    } catch (e) {
      return fail(
        'llm_error',
        tr('electron.common.summary-failed', e instanceof Error ? e.message : String(e)),
      );
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
    say(
      short.length > 90
        ? tr('electron.common.full-text-in-the-chat-window', short.slice(0, 90))
        : short,
    );
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
    const handle = (ch: string, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown) =>
      guardedHandle(ch, fn, { owner: 'DesktopService', wrapErrors: false, passEvent: true });
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
      if (!e) return { ok: false, error: tr('electron.common.nothing-to-undo') };
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

    // ---- 提醒面板（用户在设置面板里直接操作：不需要再确认，但记审计、可撤销）----
    const userAudit = (tool: string, args: Record<string, unknown>, result = 'ok') =>
      this.audit.append({ tool, args, decision: 'user', result, source: 'settings' });
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
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
        this.journal.record('reminder_cancel', tr('electron.common.cancel-reminder', before.text), [
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
      this.rehideMascotIfIdle();
    });
    ipcMain.on('desktop:drop-file', (e, p) => {
      if (e.sender !== this.main()?.webContents || typeof p !== 'string' || !p) return;
      void this.summarizeDropped(p);
    });
  }
}

let instance: DesktopService | null = null;

/** 第一次调用（组合根）要传 ports / events；之后的调用直接拿单例 */
export function getDesktopService(
  logger?: Logger,
  deps?: Pick<DesktopServiceOptions, 'ports' | 'events'>,
): DesktopService {
  if (!instance) {
    if (!deps) throw new Error('DesktopService requires host ports on first call');
    const userData = deps.ports.paths.userData();
    instance = new DesktopService(path.join(userData, 'desktop'), logger ?? console, {
      ...deps,
      // 应用自己的数据目录（provider key、对话记录、模型…）永远不对工具开放
      denyRoots: [userData],
    });
  }
  return instance;
}
