/**
 * 主动日程（主进程）：
 * - 免打扰时段 + 系统通知开关（注入给 DesktopService 的提醒投递）
 * - 定时代理任务（如「每日简报」）：到点用对话模型生成内容 → 看板娘气泡 + 系统通知 + 写入对话窗口；
 *   应用关闭期间错过的任务，在 12 小时内的会在启动后补跑一次
 * - 主动聊天（默认关闭）：按频率档位、活跃时段、免打扰、用户在场与否决定是否搭话
 * 全部本地持久化在 userData/schedule；每次运行写审计日志。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import { iconImage } from '../core/appIcon';
import type { DesktopService } from '../desktop/DesktopService';
import { t as tr } from '../i18n';
import { notifyIsland } from '../island/IslandService';

import {
  describeRepeat,
  firstRun,
  inQuiet,
  nextOccurrence,
  quietEndsAt,
  sanitizeRepeat,
  validHHMM,
  type QuietHours,
  type Repeat,
} from './recurrence';

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export type Frequency = 'low' | 'medium' | 'high';
export const FREQ: Record<Frequency, { perDay: number; gapMin: number; label: string }> = {
  low: { perDay: 1, gapMin: 360, label: '偶尔（每天最多 1 次）' },
  medium: { perDay: 3, gapMin: 180, label: '适中（每天最多 3 次）' },
  high: { perDay: 6, gapMin: 90, label: '常常（每天最多 6 次）' },
};

export interface SchedSettings {
  quiet: QuietHours;
  osNotify: boolean;
  proactive: {
    enabled: boolean;
    frequency: Frequency;
    /** 只在这个时段内搭话 */
    activeStart: string;
    activeEnd: string;
    /** 用户最近这么多分钟内聊过天就不打扰 */
    skipIfChattedMin: number;
  };
}

export const DEFAULT_SCHED: SchedSettings = {
  quiet: { enabled: false, start: '22:30', end: '08:00' },
  osNotify: true,
  proactive: {
    enabled: false,
    frequency: 'low',
    activeStart: '09:00',
    activeEnd: '21:00',
    skipIfChattedMin: 30,
  },
};

export function sanitizeSched(raw: unknown, base: SchedSettings = DEFAULT_SCHED): SchedSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SchedSettings>;
  const q = (o.quiet ?? {}) as Partial<QuietHours>;
  const p = (o.proactive ?? {}) as Partial<SchedSettings['proactive']>;
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const t = (v: unknown, d: string) => (validHHMM(v) ? v : d);
  return {
    quiet: {
      enabled: b(q.enabled, base.quiet.enabled),
      start: t(q.start, base.quiet.start),
      end: t(q.end, base.quiet.end),
    },
    osNotify: b(o.osNotify, base.osNotify),
    proactive: {
      enabled: b(p.enabled, base.proactive.enabled),
      frequency: p.frequency && p.frequency in FREQ ? p.frequency : base.proactive.frequency,
      activeStart: t(p.activeStart, base.proactive.activeStart),
      activeEnd: t(p.activeEnd, base.proactive.activeEnd),
      skipIfChattedMin:
        typeof p.skipIfChattedMin === 'number' && p.skipIfChattedMin >= 0
          ? Math.min(600, Math.round(p.skipIfChattedMin))
          : base.proactive.skipIfChattedMin,
    },
  };
}

export interface SchedTask {
  id: string;
  name: string;
  prompt: string;
  time: string;
  repeat: Repeat;
  enabled: boolean;
  template?: 'briefing';
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
}

export interface TaskResult {
  id: string;
  taskId: string;
  name: string;
  at: number;
  ok: boolean;
  text: string;
  catchUp?: boolean;
}

export const BRIEFING_PROMPT =
  '请为我写一份今天的简报：先一句问候，然后列出今天的提醒和安排，' +
  '再根据你对我的了解给一两条贴心的小建议。简洁，不超过 150 字，用中文。';

const CATCH_UP_MS = 12 * 3600_000;
const TICK_MS = 30_000;
const MAX_RESULTS = 50;

export interface SchedDeps {
  root: string;
  logger: Logger;
  desktop: DesktopService;
  complete(messages: Msg[], signal?: AbortSignal): Promise<string>;
  /** 长期记忆背景（persona + 事实），没有时返回空串 */
  memory(query: string): Promise<string>;
  openChat(): void;
  now?: () => number;
  /** 测试注入：用户空闲秒数 */
  idleSeconds?: () => number;
}

interface Persist {
  v: 1;
  settings: SchedSettings;
  tasks: SchedTask[];
  results: TaskResult[];
  proactive: { day: string; count: number; lastAt: number };
}

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export class SchedulerService {
  private data: Persist;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private lastChatAt = 0;
  private ipcDone = false;
  private proactiveBusy = false;
  private readonly now: () => number;

  constructor(private readonly d: SchedDeps) {
    this.now = d.now ?? Date.now;
    this.data = this.load();
    d.desktop.notifyPolicy = {
      quiet: () => this.isQuiet(),
      quietEndsAt: () => quietEndsAt(this.data.settings.quiet, this.now()),
      osNotify: () => this.data.settings.osNotify,
    };
  }

  private get file() {
    return path.join(this.d.root, 'schedule.json');
  }
  private load(): Persist {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Persist>;
      return {
        v: 1,
        settings: sanitizeSched(j.settings),
        tasks: (Array.isArray(j.tasks) ? j.tasks : []).filter(
          (t): t is SchedTask => !!t && typeof t.id === 'string' && !!sanitizeRepeat(t.repeat),
        ),
        results: Array.isArray(j.results) ? j.results.slice(0, MAX_RESULTS) : [],
        proactive: j.proactive ?? { day: '', count: 0, lastAt: 0 },
      };
    } catch {
      return {
        v: 1,
        settings: sanitizeSched({}),
        tasks: [],
        results: [],
        proactive: { day: '', count: 0, lastAt: 0 },
      };
    }
  }
  private save() {
    fs.mkdirSync(this.d.root, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.broadcast('ai:sched:changed', null);
  }

  isQuiet(): boolean {
    return inQuiet(this.data.settings.quiet, this.now());
  }

  // ---------- 设置 ----------
  settings(): SchedSettings {
    return JSON.parse(JSON.stringify(this.data.settings)) as SchedSettings;
  }
  setSettings(patch: unknown): SchedSettings {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<SchedSettings>;
    const cur = this.data.settings;
    const wasQuiet = this.isQuiet();
    this.data.settings = sanitizeSched(
      {
        ...cur,
        ...p,
        quiet: { ...cur.quiet, ...(p.quiet ?? {}) },
        proactive: { ...cur.proactive, ...(p.proactive ?? {}) },
      },
      cur,
    );
    this.save();
    if (wasQuiet && !this.isQuiet()) this.d.desktop.flushDeferred();
    this.audit('schedule_settings', {
      quiet: this.data.settings.quiet.enabled,
      proactive: this.data.settings.proactive.enabled,
    });
    return this.settings();
  }

  // ---------- 任务 ----------
  tasks(): SchedTask[] {
    return [...this.data.tasks].sort((a, b) => a.nextRunAt - b.nextRunAt).map((t) => ({ ...t }));
  }

  upsertTask(raw: unknown): SchedTask {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<SchedTask>;
    const repeat = sanitizeRepeat(o.repeat) ?? { kind: 'daily' };
    const time = validHHMM(o.time) ? o.time : '08:00';
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : '';
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim().slice(0, 2000) : '';
    if (!name) throw new SchedError('invalid', tr('请填写任务名称'));
    if (!prompt) throw new SchedError('invalid', tr('请填写要让助手做什么'));
    const now = this.now();
    let t = o.id ? this.data.tasks.find((x) => x.id === o.id) : undefined;
    if (t) {
      const timingChanged = t.time !== time || JSON.stringify(t.repeat) !== JSON.stringify(repeat);
      Object.assign(t, { name, prompt, time, repeat });
      if (typeof o.enabled === 'boolean') t.enabled = o.enabled;
      if (timingChanged) t.nextRunAt = firstRun(time, repeat, now);
    } else {
      t = {
        id: randomUUID(),
        name,
        prompt,
        time,
        repeat,
        enabled: o.enabled ?? true,
        template: o.template === 'briefing' ? 'briefing' : undefined,
        createdAt: now,
        nextRunAt: firstRun(time, repeat, now),
      };
      this.data.tasks.push(t);
    }
    this.save();
    this.audit('schedule_task_save', { id: t.id, name: t.name, repeat: describeRepeat(repeat) });
    return { ...t };
  }

  setTaskEnabled(id: string, enabled: boolean): boolean {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) return false;
    t.enabled = enabled;
    if (enabled && t.nextRunAt <= this.now()) t.nextRunAt = firstRun(t.time, t.repeat, this.now());
    this.save();
    return true;
  }

  removeTask(id: string): boolean {
    const n = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
    if (this.data.tasks.length === n) return false;
    this.save();
    this.audit('schedule_task_delete', { id });
    return true;
  }

  results(): TaskResult[] {
    return this.data.results.map((r) => ({ ...r }));
  }
  clearResults(): boolean {
    this.data.results = [];
    this.save();
    return true;
  }

  private async contextBlock(task?: SchedTask): Promise<string> {
    const now = this.now();
    const d = new Date(now);
    // i18n-ignore
    const week = '日一二三四五六'[d.getDay()];
    const today = this.d.desktop.reminders.today();
    const upcoming = this.data.tasks.filter(
      (t) => t.enabled && t.id !== task?.id && dayKey(t.nextRunAt) === dayKey(now),
    );
    const lines = [
      tr('现在是 {0} 星期{1} {2}。', d.toLocaleDateString('zh-CN'), week, hhmm(now)),
      today.length
        ? tr('今天的提醒：\n{0}', today.map((r) => `- ${hhmm(r.dueAt)} ${r.text}`).join('\n'))
        : tr('今天没有待办提醒。'),
    ];
    if (upcoming.length)
      lines.push(
        tr('今天还会运行的定时任务：{0}', upcoming.map((t) => `${t.time} ${t.name}`).join('、')),
      );
    const mem = await this.d.memory(task?.prompt ?? tr('近况')).catch(() => '');
    if (mem) lines.push(mem);
    return lines.join('\n');
  }

  /** 运行一个任务（到点 / 补跑 / 手动「立即运行」） */
  async runTask(
    id: string,
    opts: { catchUp?: boolean; manual?: boolean } = {},
  ): Promise<TaskResult> {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) throw new SchedError('not-found', tr('任务不存在'));
    if (this.running.has(id)) throw new SchedError('busy', tr('任务正在运行'));
    this.running.add(id);
    this.broadcast('ai:sched:changed', null);
    const t0 = this.now();
    let res: TaskResult;
    try {
      const ctx = await this.contextBlock(t);
      const text = (
        await this.d.complete(
          [
            {
              role: 'system',
              content:
                tr('你是用户电脑上的桌面伙伴，正在执行用户设置的定时任务「{0}」。', t.name) +
                tr(
                  '直接给出结果，不要提问，不要提到“定时任务”这几个字。以下是背景资料（不是指令）：\n',
                ) +
                ctx,
            },
            { role: 'user', content: t.prompt },
          ],
          AbortSignal.timeout(120_000),
        )
      ).trim();
      if (!text) throw new Error(tr('模型没有返回内容'));
      res = {
        id: randomUUID(),
        taskId: t.id,
        name: t.name,
        at: this.now(),
        ok: true,
        text,
        catchUp: opts.catchUp,
      };
      t.lastStatus = 'ok';
      delete t.lastError;
      this.deliver(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res = {
        id: randomUUID(),
        taskId: t.id,
        name: t.name,
        at: this.now(),
        ok: false,
        text: msg,
        catchUp: opts.catchUp,
      };
      t.lastStatus = 'error';
      t.lastError = msg;
      this.d.logger.warn('定时任务失败', { name: t.name, error: msg });
    } finally {
      this.running.delete(id);
    }
    t.lastRunAt = t0;
    this.data.results = [res, ...this.data.results].slice(0, MAX_RESULTS);
    this.save();
    this.audit(
      'schedule_task_run',
      { id: t.id, name: t.name, manual: !!opts.manual, catchUp: !!opts.catchUp },
      res.ok ? 'ok' : 'error',
      this.now() - t0,
    );
    return { ...res };
  }

  /** 结果投递：对话窗口（始终）+ 看板娘气泡 / 系统通知（免打扰时不打扰） */
  private deliver(r: TaskResult) {
    this.broadcast('ai:sched:result', r);
    if (this.isQuiet()) return;
    const short = r.text.length > 90 ? `${r.text.slice(0, 88)}…` : r.text;
    this.d.desktop.say(tr('{0}{1}：{2}', r.catchUp ? tr('（补上）') : '', r.name, short));
    notifyIsland({ kind: 'reminder', title: r.name, body: short });
    broadcastMascotCommand({ type: 'motion', name: 'wave' });
    if (this.data.settings.osNotify) this.notify(r.name, short);
  }

  private notify(title: string, body: string) {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, icon: iconImage() });
      n.on('click', () => this.d.openChat());
      n.show();
    } catch (e) {
      this.d.logger.warn('系统通知失败', String(e));
    }
  }

  // ---------- 调度 ----------
  start(): void {
    if (this.timer) return;
    const now = this.now();
    // 启动：错过的任务 12 小时内补跑一次，其余直接排到下一次
    const catchUp: string[] = [];
    for (const t of this.data.tasks) {
      if (!t.enabled || t.nextRunAt > now) continue;
      if (now - t.nextRunAt <= CATCH_UP_MS) catchUp.push(t.id);
      else t.lastStatus = 'skipped';
      t.nextRunAt = nextOccurrence(t.repeat, t.nextRunAt, now);
    }
    if (this.data.tasks.length) this.save();
    for (const id of catchUp)
      setTimeout(() => void this.runTask(id, { catchUp: true }).catch(() => undefined), 8000);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const now = this.now();
    const due = this.data.tasks.filter(
      (t) => t.enabled && t.nextRunAt <= now && !this.running.has(t.id),
    );
    for (const t of due) {
      t.nextRunAt = nextOccurrence(t.repeat, t.nextRunAt, now);
      this.save();
      await this.runTask(t.id).catch(() => undefined);
    }
    await this.maybeProactive().catch((e) => this.d.logger.warn('主动聊天失败', String(e)));
  }

  /** 用户在对话窗口发了消息（渲染层上报） */
  noteActivity(): void {
    this.lastChatAt = this.now();
  }

  /** 判断现在是否应该主动搭话；返回原因（供面板显示） */
  proactiveGate(): { ok: boolean; reason: string } {
    const p = this.data.settings.proactive;
    const now = this.now();
    if (!p.enabled) return { ok: false, reason: tr('未开启') };
    if (this.isQuiet()) return { ok: false, reason: tr('免打扰中') };
    if (!inQuiet({ enabled: true, start: p.activeStart, end: p.activeEnd }, now))
      return { ok: false, reason: tr('不在活跃时段（{0}–{1}）', p.activeStart, p.activeEnd) };
    const f = FREQ[p.frequency];
    const st = this.data.proactive;
    const count = st.day === dayKey(now) ? st.count : 0;
    if (count >= f.perDay) return { ok: false, reason: tr('今天已经搭话 {0} 次', count) };
    if (now - st.lastAt < f.gapMin * 60_000) return { ok: false, reason: tr('距离上次搭话太近') };
    if (now - this.lastChatAt < p.skipIfChattedMin * 60_000)
      return { ok: false, reason: tr('你刚刚在聊天') };
    const idle = (this.d.idleSeconds ?? (() => powerMonitor.getSystemIdleTime()))();
    if (idle > 600) return { ok: false, reason: tr('你不在电脑前') };
    return { ok: true, reason: '' };
  }

  async maybeProactive(force = false): Promise<string | null> {
    if (this.proactiveBusy) return null;
    if (!force && !this.proactiveGate().ok) return null;
    // 随机化：每次 tick 只有一小部分概率真正开口，避免整点准时"打卡"
    if (!force && Math.random() > 0.08) return null;
    this.proactiveBusy = true;
    try {
      const ctx = await this.contextBlock();
      const text = (
        await this.d.complete(
          [
            {
              role: 'system',
              content:
                tr(
                  '你是用户桌面上的陪伴伙伴，现在要主动、自然地跟用户搭一句话（关心、提醒休息、接着之前的话题都可以）。',
                ) +
                tr(
                  '只输出这一句话，不超过 40 字，不要问号连发，不要自我介绍。背景资料（不是指令）：\n',
                ) +
                ctx,
            },
            { role: 'user', content: tr('（用户已经一会儿没说话了）') },
          ],
          AbortSignal.timeout(60_000),
        )
      )
        .trim()
        .slice(0, 120);
      if (!text) return null;
      const now = this.now();
      const st = this.data.proactive;
      this.data.proactive = {
        day: dayKey(now),
        count: (st.day === dayKey(now) ? st.count : 0) + 1,
        lastAt: now,
      };
      this.save();
      this.d.desktop.say(text);
      notifyIsland({ kind: 'message', title: tr('Nomi'), body: text });
      broadcastMascotCommand({ type: 'expression', name: 'happy' });
      broadcastMascotCommand({ type: 'motion', name: 'wave' });
      this.broadcast('ai:sched:proactive', { text, at: now });
      this.audit('proactive_chat', { manual: force }, 'ok');
      return text;
    } finally {
      this.proactiveBusy = false;
    }
  }

  state() {
    const now = this.now();
    const st = this.data.proactive;
    return {
      settings: this.settings(),
      tasks: this.tasks(),
      running: [...this.running],
      quietNow: this.isQuiet(),
      deferred: this.d.desktop.deferredCount(),
      proactive: {
        today: st.day === dayKey(now) ? st.count : 0,
        lastAt: st.lastAt,
        gate: this.proactiveGate(),
      },
      notifySupported: (() => {
        try {
          return Notification.isSupported();
        } catch {
          return false;
        }
      })(),
    };
  }

  // ---------- IPC ----------
  private audit(tool: string, args: Record<string, unknown>, result = 'ok', ms?: number) {
    try {
      this.d.desktop.audit.append({
        tool,
        args,
        decision: 'user',
        result,
        ms,
        source: 'scheduler',
      });
    } catch {
      /* ignore */
    }
  }
  private broadcast(ch: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }

  registerIpc(): void {
    if (this.ipcDone) return;
    this.ipcDone = true;
    const handle = (ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (_e, ...a) => {
        try {
          return await fn(...a);
        } catch (err) {
          if (err instanceof SchedError)
            return { __error: { code: err.code, message: err.message } };
          throw err;
        }
      });
    };
    handle('ai:sched:state', () => this.state());
    handle('ai:sched:set-settings', (p) => this.setSettings(p));
    handle('ai:sched:upsert-task', (p) => this.upsertTask(p));
    handle('ai:sched:toggle-task', (id, v) => this.setTaskEnabled(String(id), v === true));
    handle('ai:sched:remove-task', (id) => this.removeTask(String(id)));
    handle('ai:sched:run-task', (id) => this.runTask(String(id), { manual: true }));
    handle('ai:sched:results', () => this.results());
    handle('ai:sched:clear-results', () => this.clearResults());
    handle('ai:sched:proactive-now', async () => {
      const t = await this.maybeProactive(true);
      if (!t) throw new SchedError('empty', tr('这次没想好说什么，再试一次'));
      return t;
    });
    handle('ai:sched:activity', () => {
      this.noteActivity();
      return true;
    });
  }
}

export class SchedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let instance: SchedulerService | null = null;
export function initSchedulerService(d: SchedDeps): SchedulerService {
  instance ??= new SchedulerService(d);
  return instance;
}
export function getSchedulerService(): SchedulerService | null {
  return instance;
}
