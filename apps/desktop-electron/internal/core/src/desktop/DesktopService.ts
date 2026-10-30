import * as fs from 'fs';
import * as path from 'path';

import type { ToolCallProvider, ToolDefinition } from '@nomi-ai/bundle-ig-base';
import type { HostPorts } from '@nomi-ai/host-ports';
import type { DesktopBubble } from '@nomi-ai/types';
// （显示 / 隐藏 / 按 sender 校验）与窗口数量。

import { avatarEmotion, avatarGesture } from '../ai/mascotCommand';
import { cliChildEnv } from '../cli/harness/spawn';
import type { AppEventName, AppEvents } from '../core/appEvents';
import { t as tr } from '../i18n';
import { CodeSandbox } from '../sandbox/CodeSandbox';
import { sanitizeRepeat } from '../schedule/recurrence';

import { AppTrash } from './AppTrash';
import { AuditLog, type AuditEntry } from './AuditLog';
import { isLocalBaseURL, sanitizePolicy, type Policy } from './consent';
import type { IslandKind, IslandNotice } from './islandNotice';
import { unavailableBrowser, type AgentBrowserApi } from './p3tools';
import { isSupported } from './parse/extract';
import { parseFile } from './parse/runParse';
import { guardPath, type Scope } from './pathGuard';
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

/** 看板娘窗口用到的部分（BrowserWindow 结构上满足；确认框要临时显示 / 再藏起，答复要核对发送方） */
export interface DesktopMascotWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  showInactive(): void;
  readonly webContents: { readonly id: number };
}

/** 对话窗口用到的部分（BrowserWindow 结构上满足） */
export interface DesktopChatWindow {
  isDestroyed(): boolean;
}

export interface DesktopWindows {
  main(): DesktopMascotWindow | null;
  openChat(): Promise<DesktopChatWindow>;
  /** 看板娘已关闭（窗口隐藏且静音）：提醒不再把她叫出来（系统通知 / 灵动岛照常）；确认框临时显示，答完再藏起 */
  mascotHidden?(): boolean;
  /** 看板娘已关闭（窗口已释放）时为确认框临时建出窗口；窗口加载后自己补拉待答复的请求 */
  summonMascot?(): void;
  /** 临时召回结束（确认框都答完了）：看板娘仍是关闭状态就再次释放窗口 */
  releaseMascot?(): void;
  /** 对话窗口开着（可见）：确认请求只发给它，不打扰看板娘 */
  chatOpen?(): boolean;
  /** 灵动岛提醒（宿主的灵动岛窗口）：显示了返回 true；关闭 / 不支持 / 不接这一类时返回 false */
  island?(n: IslandNotice): boolean;
}

/** 平台能力：home / userData 路径、文件夹选择器、剪贴板、系统通知、解析子进程 */
export type DesktopPorts = Pick<
  HostPorts,
  'paths' | 'dialogs' | 'clipboard' | 'notifications' | 'processes'
>;

export interface DesktopServiceOptions {
  ports: DesktopPorts;
  /** 状态变化广播给所有窗口 */
  events: AppEvents;
  denyRoots?: string[];
  /**
   * 受控浏览器（browser_* 工具）。宿主提供（Electron：host/AgentBrowser，独立内存分区的可见窗口）；
   * 缺省时这些工具报「不可用」。每次组装工具时调用一次。
   */
  browser?: () => AgentBrowserApi;
}

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
  private readonly ports: DesktopPorts;
  private readonly events: AppEvents;
  private readonly browser: () => AgentBrowserApi;

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
    opts: DesktopServiceOptions,
  ) {
    this.ports = opts.ports;
    this.events = opts.events;
    this.browser = opts.browser ?? unavailableBrowser;
    this.broker = new PermissionBroker(path.join(root, 'settings.json'), {
      home: this.ports.paths.home(),
      platform: process.platform,
      realpath: (p) =>
        process.platform === 'win32' && fs.realpathSync.native
          ? Promise.resolve(fs.realpathSync.native(p))
          : fs.promises.realpath(p),
      denyRoots: opts.denyRoots ?? [],
    });
    this.audit = new AuditLog(path.join(root, 'audit'));
    this.trash = new AppTrash(path.join(root, 'trash'));
    this.journal = new UndoJournal(path.join(root, 'journal.jsonl'), this.trash);
    this.reminders = new ReminderStore(path.join(root, 'reminders.json'));
    this.reminders.onFire = (r) => this.fireReminder(r);
    this.reminders.onChange(() => this.broadcast('desktop.p2Changed', { kind: 'reminders' }));
    try {
      this.trash.purge(30);
      this.audit.rotate();
    } catch (e) {
      logger.warn('桌面能力：清理回收站 / 审计日志失败', { error: String(e) });
    }
    this.broker.ui = {
      request: (req) => this.sendConfirm(req),
      cancel: (id) => {
        this.cancelConfirm(id);
        this.rehideMascotIfIdle();
      },
    };
    this.broker.onChange(() => this.broadcast('desktop.changed', this.state()));
  }

  attachRuntime(h: DesktopRuntimeHooks): void {
    this.runtime = h;
  }

  attachWindows(w: DesktopWindows): void {
    this.windows = w;
  }

  private main(): DesktopMascotWindow | null {
    const w = this.windows?.main();
    return w && !w.isDestroyed() ? w : null;
  }

  private mascotHidden(): boolean {
    return this.windows?.mascotHidden?.() ?? false;
  }

  /** 看板娘已关闭时，确认框全部处理完就把临时召回的窗口再释放掉 */
  private rehideMascotIfIdle(): void {
    if (!this.mascotHidden() || this.broker.pendingRequests().length > 0) return;
    this.windows?.releaseMascot?.();
  }

  private broadcast(ch: AppEventName, payload: unknown): void {
    this.events.publish(ch, payload);
  }

  /** 只发给看板娘窗口（确认请求 / 气泡 / 提醒）；看板娘窗口不存在时不发 */
  private toMascot(ch: AppEventName, payload: unknown): void {
    if (this.main()) this.events.publish(ch, payload, { surface: 'mascot' });
  }

  /** 调用方是不是看板娘窗口（确认答复、提醒卡片、拖文件只接受它） */
  isMascotSender(webContentsId: number | undefined): boolean {
    const w = this.main();
    return !!w && webContentsId !== undefined && w.webContents.id === webContentsId;
  }

  private chatOpen(): boolean {
    return this.windows?.chatOpen?.() ?? false;
  }

  /** 确认请求收起（答复 / 超时 / 取消）：两边都发，没订阅的界面收不到 */
  private cancelConfirm(id: string): void {
    this.events.publish('desktop.confirmCancel', id, { surface: 'chat' });
    this.toMascot('desktop.confirmCancel', id);
  }

  /**
   * 确认请求发到哪：对话窗口开着 → 只发给对话窗口（授权卡片）；看板娘被关掉了 → 打开对话窗口
   * （窗口挂载后经 desktop.state 补拉）；否则发给看板娘。请求文件夹只走对话窗口（见 requestFolder）。
   */
  private sendConfirm(req: ConfirmRequest): void {
    if (this.chatOpen() || req.kind === 'scope') {
      this.logger.info('桌面工具确认请求', { tool: req.tool, danger: req.danger, to: 'chat' });
      this.events.publish('desktop.confirmRequest', req, { surface: 'chat' });
      return;
    }
    if (this.mascotHidden() && this.windows) {
      this.logger.info('桌面工具确认请求', { tool: req.tool, danger: req.danger, to: 'chat-open' });
      void this.windows.openChat().then(
        () => this.events.publish('desktop.confirmRequest', req, { surface: 'chat' }),
        (e: unknown) => this.logger.warn('打开对话窗口失败', { error: String(e) }),
      );
      return;
    }
    const w = this.main();
    this.logger.info('桌面工具确认请求', { tool: req.tool, danger: req.danger, hasWindow: !!w });
    if (!w) {
      // 看板娘已关闭、窗口已释放：临时建出来，页面加载后经 desktop.state 补拉这条请求
      if (this.mascotHidden()) this.windows?.summonMascot?.();
      return;
    }
    if (!w.isVisible()) w.showInactive();
    this.events.publish('desktop.confirmRequest', req, { surface: 'mascot' });
    avatarGesture(this.events, 'think');
    avatarEmotion(this.events, req.danger === 'destructive' ? 'surprised' : 'relaxed');
  }

  say(text: string, opts: Omit<DesktopBubble, 'text'> = {}): void {
    this.toMascot('desktop.bubble', { text, ...opts });
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
        this.windows?.island?.({
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
      if (!this.ports.notifications.supported()) return 'none';
      this.ports.notifications.show(
        { title: n.title, body: n.body ?? n.text, silent: false },
        () => void this.windows?.openChat().catch(() => undefined),
      );
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
      this.events.publish(
        'desktop.reminder',
        { id: r.id, text: r.text, dueAt: r.dueAt, missed: false },
        { surface: 'mascot' },
      );
      this.audit.append({
        tool: 'reminder_fire',
        args: { id: r.id, text: r.text, via: 'bubble' },
        decision: 'auto',
        result: 'ok',
        source: 'scheduler',
      });
    }
    avatarGesture(this.events, 'wave');
    avatarEmotion(this.events, 'happy');
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
      avatarGesture(this.events, 'wave');
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

  /**
   * 工具请求授权文件夹：对话窗口开着时在对话里问（授权建议的文件夹 / 另选 / 拒绝），只有用户要另选、
   * 或模型没给建议的文件夹时才打开系统的选择框；对话窗口没开时照旧直接打开选择框。
   */
  async requestFolder(
    suggested: string | undefined,
    mode: 'read' | 'read-write',
    reason?: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!this.chatOpen()) return this.pickFolder(suggested);
    const home = this.ports.paths.home();
    const abs = suggested?.replace(/^~(?=$|[\\/])/, home);
    const d = await this.broker.requestScope({ suggestedPath: abs, mode, reason, signal });
    if (d.decision === 'allowed' && d.path) return d.path;
    if (d.decision === 'pick') return this.pickFolder(suggested);
    return null;
  }

  tools(): ToolDefinition[] {
    this.toolDefs ??= createDesktopTools({
      broker: this.broker,
      audit: this.audit,
      journal: this.journal,
      trash: this.trash,
      parse: (p) => parseFile(p, { processes: this.ports.processes }),
      summarize: (t, i, s) => this.summarize(t, i, s),
      providerFor: (r) => this.providerFor(r),
      describeProvider: (p) => this.receiverOf(p),
      pickFolder: (s) => this.pickFolder(s),
      requestFolder: (s, mode, reason, signal) => this.requestFolder(s, mode, reason, signal),
      p2: {
        reminders: this.reminders,
        clipboard: {
          readText: () => this.ports.clipboard.readText(),
          writeText: (t) => this.ports.clipboard.writeText(t),
        },
        say: (t) => this.say(t),
      },
      p3: { browser: this.browser(), code: new CodeSandbox() },
      // 工作区命令与编程助手标签同一套环境：补全后的 PATH，剔除 Nomi 内部变量
      shell: { env: () => cliChildEnv(false) },
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
    const say = (text: string) => this.toMascot('desktop.bubble', { text });
    const fail = (code: string, text: string) => {
      say(text);
      avatarEmotion(this.events, 'sad');
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
        realpath: (p) =>
          process.platform === 'win32' && fs.realpathSync.native
            ? Promise.resolve(fs.realpathSync.native(p))
            : fs.promises.realpath(p),
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
    avatarGesture(this.events, 'think');
    const parsed = await parseFile(probe.real, { processes: this.ports.processes });
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
    avatarGesture(this.events, 'nod');
    avatarEmotion(this.events, 'happy');
    if (this.windows) {
      await this.windows.openChat();
      // 对话窗口已经开着并订阅了：直接收到；刚打开、还没订阅：内核留着这次总结，窗口挂载时拉取
      // （`desktop.takePendingSummary`，见 core/pendingEvents.ts）
      this.events.publish(
        'desktop.summary',
        { name, path: probe.real, summary, at: Date.now() },
        { surface: 'chat' },
      );
    }
    return { ok: true };
  }

  // ---- 设置面板 / 看板娘窗口的操作（契约 host/contract/media.ts）----

  /** 弹出系统选择框授权文件夹；用户取消返回 null */
  async grantFolder(mode: unknown): Promise<Scope | null> {
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
  }

  revokeScope(id: unknown): boolean {
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
  }

  setToolPolicy(tool: unknown, policy: unknown): boolean {
    if (typeof tool !== 'string' || !(tool in TOOL_DANGER)) return false;
    this.broker.setPolicy(
      tool,
      TOOL_DANGER[tool],
      sanitizePolicy(TOOL_DANGER[tool], policy as Policy),
    );
    return true;
  }

  setLocalOnly(v: unknown): boolean {
    this.broker.setLocalOnly(v === true);
    return true;
  }

  resetCloudAcks(): boolean {
    this.broker.resetCloudAcks();
    return true;
  }

  auditList(limit: unknown): AuditEntry[] {
    return this.audit.list(typeof limit === 'number' ? Math.min(1000, limit) : 200);
  }

  clearAudit(): boolean {
    this.audit.clear();
    this.broadcast('desktop.changed', this.state());
    return true;
  }

  journalList() {
    return this.journal.list(50);
  }

  async undoLast(): Promise<{ ok: boolean; undone?: string; error?: string }> {
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
      this.broadcast('desktop.changed', this.state());
      return { ok: true, undone: e.summary };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  resetAll(): boolean {
    this.broker.resetAll();
    this.audit.clear();
    return true;
  }

  // ---- 提醒面板（用户在设置面板里直接操作：不需要再确认，但记审计、可撤销）----
  private userAudit(tool: string, args: Record<string, unknown>, result = 'ok'): void {
    this.audit.append({ tool, args, decision: 'user', result, source: 'settings' });
  }

  remindersList(all: unknown): Reminder[] {
    return this.reminders.list({ includeEnded: all === true, limit: 200 });
  }

  /** 文字为空、时间无效或已过去时返回 null */
  createReminder(raw: unknown): Reminder | null {
    const o = (raw ?? {}) as {
      text?: unknown;
      at?: unknown;
      inMinutes?: unknown;
      repeat?: unknown;
    };
    const text = clip(o.text, 500).trim();
    const due = resolveDue(
      {
        at: typeof o.at === 'string' ? o.at : undefined,
        inMinutes: typeof o.inMinutes === 'number' ? o.inMinutes : undefined,
      },
      Date.now(),
    );
    if (!text || due === null || due < Date.now() - 1000) return null;
    const r = this.reminders.create(text, due, sanitizeRepeat(o.repeat));
    this.userAudit('reminder_create', { id: r.id, text: r.text, repeat: r.repeat?.kind });
    return r;
  }

  updateReminder(id: unknown, raw: unknown): Reminder | null {
    const o = (raw ?? {}) as { text?: unknown; at?: unknown; repeat?: unknown };
    const due = typeof o.at === 'string' ? Date.parse(o.at) : undefined;
    try {
      const { after } = this.reminders.update(String(id), {
        text: typeof o.text === 'string' ? clip(o.text, 500) : undefined,
        dueAt: Number.isFinite(due) ? due : undefined,
        repeat: o.repeat === null ? null : sanitizeRepeat(o.repeat),
      });
      this.userAudit('reminder_update', { id: after.id });
      return after;
    } catch {
      return null;
    }
  }

  cancelReminder(id: unknown): boolean {
    try {
      const { before } = this.reminders.cancel(String(id));
      this.journal.record('reminder_cancel', tr('electron.common.cancel-reminder', before.text), [
        { op: 'custom', kind: 'reminder-restore', payload: before },
      ]);
      this.userAudit('reminder_cancel', { id: before.id });
      return true;
    } catch {
      return false;
    }
  }

  snoozeReminder(id: unknown, minutes: unknown): boolean {
    try {
      this.reminders.snooze(String(id), typeof minutes === 'number' ? minutes : 10);
      this.userAudit('reminder_snooze', { id: String(id) });
      return true;
    } catch {
      return false;
    }
  }

  // ---- 只接受看板娘窗口的操作：senderId 是调用方 webContents 的 id ----

  /** 拉取错过的提醒；不是看板娘窗口时返回空 */
  takeMissedFor(senderId: number | undefined): Array<{ id: string; text: string; dueAt: number }> {
    return this.isMascotSender(senderId) ? this.takeMissed() : [];
  }

  /** 提醒卡片：好的 / 稍后 */
  reminderAction(
    senderId: number | undefined,
    id: unknown,
    action: unknown,
    minutes: unknown,
  ): void {
    if (!this.isMascotSender(senderId) || typeof id !== 'string') return;
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
  }

  /** 确认答复：只接受看板娘窗口（确认气泡 / 对话框所在处），模型与对话窗口都无法伪造 */
  /** 确认答复：对话窗口（契约按界面放行）或看板娘窗口（再核对调用方就是看板娘） */
  answerConfirm(
    senderId: number | undefined,
    id: unknown,
    allow: unknown,
    remember: unknown,
    pick?: unknown,
    surface?: string,
  ): void {
    if (surface !== 'chat' && !this.isMascotSender(senderId)) {
      this.logger.warn('忽略来自非 Nomi 窗口的确认答复');
      return;
    }
    if (
      typeof id === 'string' &&
      this.broker.answer(id, allow === true, remember === true, pick === true)
    )
      this.cancelConfirm(id);
    this.rehideMascotIfIdle();
  }

  /**
   * 拖到看板娘身上的文件。路径由看板娘窗口的 preload 从真实 File 取得并经专用通道提交
   * （nomiHost.dropFile → host/nomiHostIpc.ts）；视图代码选不了路径，所以这里不是契约过程。
   */
  dropFile(senderId: number | undefined, p: unknown): void {
    if (!this.isMascotSender(senderId) || typeof p !== 'string' || !p) return;
    void this.summarizeDropped(p);
  }
}

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** 组合根创建桌面服务：数据在 `<userData>/desktop`；应用自己的数据目录永远不对工具开放 */
export function createDesktopService(
  logger: Logger,
  deps: Pick<DesktopServiceOptions, 'ports' | 'events' | 'browser'>,
): DesktopService {
  const userData = deps.ports.paths.userData();
  return new DesktopService(path.join(userData, 'desktop'), logger, {
    ...deps,
    // 应用自己的数据目录（provider key、对话记录、模型…）永远不对工具开放
    denyRoots: [userData],
  });
}
