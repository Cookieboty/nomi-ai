/**
 * 本地中心：日历（本地事件 / 导入 .ics / 订阅 ICS 链接 / CalDAV）、剪贴板历史（默认关闭，含图片）、
 * 一键导出全部本地数据（zip）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';
import { BrowserWindow, ClipboardItem, clipboard, dialog, nativeImage } from 'electron';
import { zipSync, strToU8 } from 'fflate';
import { z } from 'zod';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { DesktopService } from '../desktop/DesktopService';
import { redactServerForExport } from '../extensions/mcpConfig';
import { t as tr } from '../i18n';
import { guardedHandle } from '../security/guardedIpc';
import { decryptSecret, encryptSecret } from '../security/secretStorage';
import { writePrivateFileAtomic } from '../utils/privateFile';

import { caldavQuery, expand, extractCalendarData, parseIcs, toIcs, type CalEvent } from './ics';
import { createSystemEvent, readSystemCalendar, systemCalendarInfo } from './systemCalendar';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

export interface HubDeps {
  root: string;
  userData: string;
  logger: Logger;
  desktop: DesktopService;
  fetchImpl?: typeof fetch;
}

export type CalKind = 'local' | 'file' | 'ics-url' | 'caldav' | 'system';
export interface CalSource {
  id: string;
  name: string;
  kind: CalKind;
  color: string;
  url?: string;
  username?: string;
  /** 加密后的密码（CalDAV） */
  secret?: string;
  enabled: boolean;
  lastSync?: number;
  lastError?: string;
  count?: number;
}

export interface ClipEntry {
  id: string;
  at: number;
  kind: 'text' | 'image';
  text?: string;
  /** 图片：文件名（userData/local/clips） */
  file?: string;
  w?: number;
  h?: number;
  pinned?: boolean;
}

interface ClipSettings {
  enabled: boolean;
  max: number;
  images: boolean;
}

const COLORS = ['#6c8cff', '#36b37e', '#ff8b3d', '#e5484d', '#a78bfa', '#14b8a6'];
const SECRETISH =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/;

/** 看起来像密钥 / 一次性密码的剪贴板内容不记录 */
export function looksSecret(s: string): boolean {
  const t = s.trim();
  if (SECRETISH.test(t)) return true;
  // 无空格、长度 8~64、同时含大小写 / 数字 / 符号 → 像密码
  if (/^\S{8,64}$/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && /[^\w]/.test(t))
    return true;
  return false;
}

/** 把系统日历的常见错误翻成人话 */
export function systemCalendarError(msg: string): string {
  if (/-1743|not authori[sz]ed|Not allowed to send Apple events/i.test(msg))
    return tr(
      '没有「日历」的自动化权限：请到 系统设置 → 隐私与安全性 → 自动化 中允许 Nomi 控制「日历」',
    );
  if (/-600|isn.t running|Application can.t be found/i.test(msg)) return tr('无法启动「日历」App');
  if (/80040154|ComObject|Outlook\.Application|class not registered/i.test(msg))
    return tr('没有找到经典版 Outlook（新版 Outlook 不支持本地接口）。请改用 ICS 订阅或 CalDAV。');
  if (/evolution: no local calendar/.test(msg))
    return tr('没有找到 Evolution / GNOME 本地日历文件。在线账户请用 CalDAV 订阅。');
  return msg.slice(0, 200);
}

export class LocalHubService {
  private sources: CalSource[] = [];
  private events: CalEvent[] = [];
  private clips: ClipEntry[] = [];
  private clipSettings: ClipSettings = { enabled: false, max: 50, images: true };
  private clipTimer: NodeJS.Timeout | null = null;
  private lastClip = '';
  private syncTimer: NodeJS.Timeout | null = null;
  private ipcDone = false;

  constructor(private readonly d: HubDeps) {
    fs.mkdirSync(this.clipDir, { recursive: true });
    const cal = this.read('calendar.json') as { sources?: CalSource[]; events?: CalEvent[] } | null;
    this.sources = cal?.sources ?? [];
    this.events = cal?.events ?? [];
    if (!this.sources.some((s) => s.kind === 'local'))
      this.sources.unshift({
        id: 'local',
        name: tr('我的日历'),
        kind: 'local',
        color: COLORS[0],
        enabled: true,
      });
    const cl = this.read('clipboard.json') as {
      settings?: Partial<ClipSettings>;
      items?: ClipEntry[];
    } | null;
    this.clipSettings = {
      ...this.clipSettings,
      ...(cl?.settings ?? {}),
      enabled: cl?.settings?.enabled === true,
    };
    this.clips = cl?.items ?? [];
  }

  private get clipDir() {
    return path.join(this.d.root, 'clips');
  }
  private read(f: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.d.root, f), 'utf8'));
    } catch {
      return null;
    }
  }
  private write(f: string, v: unknown) {
    // calendar.json 含 CalDAV 账号与（加密的）密码，clipboard.json 含剪贴板历史：0600 原子写
    writePrivateFileAtomic(path.join(this.d.root, f), JSON.stringify(v));
  }
  private saveCal() {
    this.write('calendar.json', { sources: this.sources, events: this.events });
  }
  private saveClips() {
    this.write('clipboard.json', { settings: this.clipSettings, items: this.clips });
  }
  private broadcast(ch: string, p: unknown = null) {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, p);
  }
  private audit(tool: string, args: Record<string, unknown>, result = 'ok', source = 'settings') {
    this.d.desktop.audit.append({ tool, args, decision: 'user', result, ms: 0, source } as never);
  }

  start() {
    this.applyClipWatch();
    this.syncTimer = setInterval(() => void this.syncAll(), 30 * 60_000);
    setTimeout(() => void this.syncAll(), 5000);
  }
  stop() {
    if (this.clipTimer) clearInterval(this.clipTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
  }

  // ───────────── 日历 ─────────────
  calState() {
    const view = this.sources.map(({ secret, ...s }) => ({ ...s, hasPassword: !!secret }));
    return { sources: view };
  }
  occurrences(from: number, to: number) {
    const enabled = new Set(this.sources.filter((s) => s.enabled).map((s) => s.id));
    return expand(
      this.events.filter((e) => enabled.has(e.cal)),
      from,
      to,
    );
  }
  today() {
    const s = new Date();
    s.setHours(0, 0, 0, 0);
    return this.occurrences(s.getTime(), s.getTime() + 86_400_000);
  }
  upsertEvent(p: Partial<CalEvent>) {
    const summary = String(p.summary ?? '').trim();
    if (!summary) throw new Error(tr('请填写事件标题'));
    const start = Number(p.start);
    const end = Number(p.end ?? start + 3_600_000);
    if (!Number.isFinite(start) || !(end > start)) throw new Error(tr('结束时间要晚于开始时间'));
    const prev = p.uid ? this.events.find((e) => e.uid === p.uid && e.cal === 'local') : undefined;
    const e: CalEvent = {
      uid: prev?.uid ?? `${randomUUID()}@nomi`,
      summary: summary.slice(0, 300),
      start,
      end,
      allDay: !!p.allDay,
      location: p.location?.trim() || undefined,
      description: p.description?.trim() || undefined,
      rrule: p.rrule && /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.test(p.rrule) ? p.rrule : undefined,
      cal: 'local',
    };
    this.events = prev ? this.events.map((x) => (x === prev ? e : x)) : [...this.events, e];
    this.saveCal();
    this.broadcast('ai:hub:changed');
    return e;
  }
  removeEvent(uid: string) {
    const n = this.events.length;
    this.events = this.events.filter((e) => !(e.uid === uid && e.cal === 'local'));
    this.saveCal();
    this.broadcast('ai:hub:changed');
    return this.events.length < n;
  }
  private replaceEvents(cal: string, list: CalEvent[]) {
    this.events = [...this.events.filter((e) => e.cal !== cal), ...list];
    const s = this.sources.find((x) => x.id === cal);
    if (s) {
      s.count = list.length;
      s.lastSync = Date.now();
      s.lastError = undefined;
    }
    this.saveCal();
    this.broadcast('ai:hub:changed');
  }
  async importIcsDialog() {
    const r = await dialog.showOpenDialog({
      title: tr('导入日历（.ics）'),
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return this.importIcsText(
      fs.readFileSync(r.filePaths[0], 'utf8'),
      path.basename(r.filePaths[0], '.ics'),
    );
  }
  importIcsText(text: string, name: string) {
    const id = `file-${randomUUID().slice(0, 8)}`;
    const list = parseIcs(text, id);
    if (!list.length) throw new Error(tr('文件里没有找到日程（VEVENT）'));
    this.sources.push({
      id,
      name: name.slice(0, 60) || tr('导入的日历'),
      kind: 'file',
      color: COLORS[this.sources.length % COLORS.length],
      enabled: true,
    });
    this.replaceEvents(id, list);
    this.audit('calendar_import', { n: list.length });
    return { id, count: list.length };
  }
  async addSource(p: {
    name: string;
    kind: 'ics-url' | 'caldav';
    url: string;
    username?: string;
    password?: string;
  }) {
    let u: URL;
    try {
      u = new URL(String(p.url).replace(/^webcal:/i, 'https:'));
    } catch {
      throw new Error(tr('请填写有效的地址'));
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error(tr('只支持 http / https / webcal 地址'));
    // 安全存储不可用 / 加密失败时失败关闭：拒绝保存密码，不降级成明文
    const secret = p.password ? this.enc(p.password) : undefined;
    const s: CalSource = {
      id: `${p.kind}-${randomUUID().slice(0, 8)}`,
      name: String(p.name || u.hostname).slice(0, 60),
      kind: p.kind,
      color: COLORS[this.sources.length % COLORS.length],
      url: u.toString(),
      username: p.username?.trim() || undefined,
      secret,
      enabled: true,
    };
    this.sources.push(s);
    this.saveCal();
    try {
      await this.sync(s.id);
    } catch {
      /* 错误记在 source 上 */
    }
    this.audit('calendar_subscribe', { kind: s.kind, host: u.hostname });
    return this.calState().sources.find((x) => x.id === s.id);
  }
  private enc(v: string) {
    return encryptSecret(
      v,
      tr('系统安全存储不可用，无法安全保存 CalDAV 密码；请在系统钥匙串可用后重试'),
    );
  }
  private dec(v?: string) {
    return decryptSecret(v);
  }
  /** 连接系统日历（macOS 日历 / 经典 Outlook / Evolution）；首次同步会触发系统授权 */
  async addSystemSource() {
    const info = systemCalendarInfo();
    if (!info.provider) throw new Error(tr('当前系统不支持读取系统日历'));
    let s = this.sources.find((x) => x.kind === 'system');
    if (!s) {
      s = {
        id: 'system',
        name:
          info.provider === 'macos-calendar'
            ? tr('macOS 日历')
            : info.provider === 'outlook-com'
              ? tr('Outlook（经典版）')
              : tr('Evolution / GNOME 日历'),
        kind: 'system',
        color: COLORS[this.sources.length % COLORS.length],
        enabled: true,
      };
      this.sources.push(s);
      this.saveCal();
    }
    try {
      await this.sync(s.id);
    } catch {
      /* 错误记在 source 上 */
    }
    this.audit('calendar_system_connect', { provider: info.provider });
    return this.calState().sources.find((x) => x.id === 'system');
  }

  /** 经同意后在系统日历里创建事件（macOS 日历 / 经典 Outlook） */
  async createSystemEvent(p: { summary?: unknown; start?: unknown; end?: unknown }) {
    const info = systemCalendarInfo();
    if (!info.canCreate) throw new Error(tr('当前系统日历不支持由 Nomi 创建事件'));
    const summary = String(p.summary ?? '').trim();
    const start = Number(p.start);
    const end = Number(p.end ?? start + 3_600_000);
    if (!summary || !Number.isFinite(start) || !Number.isFinite(end))
      throw new Error(tr('事件信息不完整'));
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: [tr('创建'), tr('取消')],
      defaultId: 0,
      cancelId: 1,
      message: tr('在系统日历中创建事件？'),
      detail: `${summary}\n${new Date(start).toLocaleString()} – ${new Date(end).toLocaleTimeString()}`,
    });
    if (r.response !== 0) return { ok: false, reason: 'user_denied' };
    const res = await createSystemEvent({ summary, start, end });
    this.audit('calendar_system_create', { ok: res.ok });
    await this.sync('system').catch(() => undefined);
    return res;
  }

  async sync(id: string) {
    const s = this.sources.find((x) => x.id === id);
    if (s?.kind === 'system') return this.syncSystem(s);
    if (!s || !s.url) return 0;
    const f = this.d.fetchImpl ?? fetch;
    const headers: Record<string, string> = {};
    if (s.username)
      headers.Authorization = `Basic ${Buffer.from(`${s.username}:${this.dec(s.secret)}`).toString('base64')}`;
    try {
      let texts: string[];
      if (s.kind === 'caldav') {
        const now = Date.now();
        const r = await f(s.url, {
          method: 'REPORT',
          headers: { ...headers, Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
          body: caldavQuery(now - 30 * 86_400_000, now + 180 * 86_400_000),
        });
        if (r.status === 401) throw new Error(tr('用户名或密码不对'));
        if (!r.ok) throw new Error(tr('服务器返回 HTTP {0}', r.status));
        texts = extractCalendarData(await r.text());
      } else {
        const r = await f(s.url, { headers });
        if (!r.ok) throw new Error(tr('服务器返回 HTTP {0}', r.status));
        texts = [await r.text()];
      }
      const list = texts.flatMap((t) => parseIcs(t, s.id));
      this.replaceEvents(s.id, list);
      return list.length;
    } catch (e) {
      s.lastError = (e as Error).message.replace(/fetch failed/, '连不上服务器');
      s.lastSync = Date.now();
      this.saveCal();
      this.broadcast('ai:hub:changed');
      throw new Error(s.lastError, { cause: e });
    }
  }
  private async syncSystem(s: CalSource) {
    const now = Date.now();
    try {
      const list = await readSystemCalendar({
        from: now - 86_400_000,
        to: now + 30 * 86_400_000,
        cal: s.id,
      });
      this.replaceEvents(s.id, list);
      return list.length;
    } catch (e) {
      s.lastError = systemCalendarError(String((e as Error).message));
      s.lastSync = Date.now();
      this.saveCal();
      this.broadcast('ai:hub:changed');
      throw new Error(s.lastError, { cause: e });
    }
  }

  async syncAll() {
    for (const s of this.sources.filter((x) => x.enabled && (x.url || x.kind === 'system')))
      await this.sync(s.id).catch(() => undefined);
  }
  toggleSource(id: string, on: boolean) {
    const s = this.sources.find((x) => x.id === id);
    if (!s) return false;
    s.enabled = on;
    this.saveCal();
    this.broadcast('ai:hub:changed');
    return true;
  }
  removeSource(id: string) {
    if (id === 'local') throw new Error(tr('本地日历不能删除'));
    this.sources = this.sources.filter((s) => s.id !== id);
    this.events = this.events.filter((e) => e.cal !== id);
    this.saveCal();
    this.broadcast('ai:hub:changed');
    return true;
  }
  async exportIcs() {
    const r = await dialog.showSaveDialog({
      title: tr('导出本地日历'),
      defaultPath: 'nomi.ics',
      filters: [{ name: 'iCalendar', extensions: ['ics'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, toIcs(this.events.filter((e) => e.cal === 'local')));
    return r.filePath;
  }

  // ───────────── 剪贴板 ─────────────
  clipState() {
    return {
      settings: this.clipSettings,
      items: [...this.clips]
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at)
        .map((c) => ({ ...c, thumb: c.kind === 'image' ? this.clipThumb(c) : undefined })),
    };
  }
  private clipThumb(c: ClipEntry) {
    try {
      const img = nativeImage.createFromPath(path.join(this.clipDir, c.file!));
      return img.resize({ width: 160 }).toDataURL();
    } catch {
      return undefined;
    }
  }
  setClipSettings(p: Partial<ClipSettings>) {
    const was = this.clipSettings.enabled;
    if (typeof p.enabled === 'boolean') this.clipSettings.enabled = p.enabled;
    if (typeof p.images === 'boolean') this.clipSettings.images = p.images;
    if ([20, 50, 100, 200].includes(Number(p.max))) this.clipSettings.max = Number(p.max);
    this.saveClips();
    this.applyClipWatch();
    if (!was && this.clipSettings.enabled) {
      this.d.desktop.say(tr('好的，我会记住最近复制的内容（只在本机），像密码的内容会自动跳过～'));
      broadcastMascotCommand({ type: 'motion', name: 'nod' });
    }
    this.audit('clipboard_history_settings', { enabled: this.clipSettings.enabled });
    this.broadcast('ai:hub:clips');
    return this.clipSettings;
  }
  private applyClipWatch() {
    if (this.clipTimer) clearInterval(this.clipTimer);
    this.clipTimer = null;
    if (!this.clipSettings.enabled) return;
    void this.snapshot().then((sn) => (this.lastClip = sn?.sig ?? ''));
    this.clipTimer = setInterval(() => void this.pollClip(), 1000);
  }
  /** 读当前剪贴板（Electron 44 异步 Clipboard API）：文本优先，其次 PNG 图片 */
  private async snapshot(): Promise<{ sig: string; text?: string; png?: Buffer } | null> {
    try {
      const t = await clipboard.readText();
      if (t) return { sig: `t:${t.length}:${t.slice(0, 64)}`, text: t };
      if (!this.clipSettings.images) return null;
      const items = await clipboard.read();
      for (const it of items) {
        const type = it.types.find((x) => /^image\/(png|jpeg)$/.test(x));
        if (!type) continue;
        const blob = (await it.getType(type)) as Blob;
        const buf = Buffer.from(await blob.arrayBuffer());
        const png = type === 'image/png' ? buf : nativeImage.createFromBuffer(buf).toPNG();
        return { sig: `i:${png.length}:${png.subarray(png.length - 64).toString('hex')}`, png };
      }
    } catch {
      /* 剪贴板暂不可读 */
    }
    return null;
  }
  private polling = false;
  async pollClip(): Promise<ClipEntry | null> {
    if (this.polling) return null;
    this.polling = true;
    try {
      const sn = await this.snapshot();
      if (!sn || sn.sig === this.lastClip) return null;
      this.lastClip = sn.sig;
      return this.capture(sn);
    } finally {
      this.polling = false;
    }
  }
  capture(sn: { text?: string; png?: Buffer }): ClipEntry | null {
    let e: ClipEntry | null = null;
    const t = sn.text;
    if (t && t.trim()) {
      if (looksSecret(t)) return null;
      const dup = this.clips.find((c) => c.kind === 'text' && c.text === t);
      if (dup) {
        dup.at = Date.now();
        e = dup;
      } else e = { id: randomUUID(), at: Date.now(), kind: 'text', text: t.slice(0, 20_000) };
    } else if (sn.png) {
      const img = nativeImage.createFromBuffer(sn.png);
      if (img.isEmpty()) return null;
      const id = randomUUID();
      const file = `${id}.png`;
      fs.writeFileSync(path.join(this.clipDir, file), sn.png);
      const sz = img.getSize();
      e = { id, at: Date.now(), kind: 'image', file, w: sz.width, h: sz.height };
    }
    if (!e) return null;
    if (!this.clips.includes(e)) this.clips.push(e);
    this.trimClips();
    this.saveClips();
    this.broadcast('ai:hub:clips');
    return e;
  }
  private trimClips() {
    const unpinned = this.clips.filter((c) => !c.pinned).sort((a, b) => b.at - a.at);
    for (const c of unpinned.slice(this.clipSettings.max)) this.dropClip(c);
  }
  private dropClip(c: ClipEntry) {
    if (c.file) fs.rmSync(path.join(this.clipDir, c.file), { force: true });
    this.clips = this.clips.filter((x) => x !== c);
  }
  async copyClip(id: string) {
    const c = this.clips.find((x) => x.id === id);
    if (!c) return false;
    if (c.kind === 'text') {
      await clipboard.writeText(c.text ?? '');
      this.lastClip = `t:${(c.text ?? '').length}:${(c.text ?? '').slice(0, 64)}`;
    } else {
      const png = fs.readFileSync(path.join(this.clipDir, c.file!));
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
      ]);
      this.lastClip = `i:${png.length}:${png.subarray(png.length - 64).toString('hex')}`;
    }
    c.at = Date.now();
    this.saveClips();
    this.broadcast('ai:hub:clips');
    return true;
  }
  clipImage(id: string) {
    const c = this.clips.find((x) => x.id === id && x.kind === 'image');
    if (!c) throw new Error(tr('没有这张图片'));
    const img = nativeImage.createFromPath(path.join(this.clipDir, c.file!));
    const s = img.getSize();
    return {
      mime: 'image/png',
      data: img.toPNG().toString('base64'),
      width: s.width,
      height: s.height,
      source: 'paste',
    };
  }
  pinClip(id: string, v: boolean) {
    const c = this.clips.find((x) => x.id === id);
    if (c) c.pinned = v;
    this.saveClips();
    this.broadcast('ai:hub:clips');
    return !!c;
  }
  removeClip(id: string) {
    const c = this.clips.find((x) => x.id === id);
    if (c) this.dropClip(c);
    this.saveClips();
    this.broadcast('ai:hub:clips');
    return !!c;
  }
  clearClips(keepPinned = true) {
    for (const c of [...this.clips]) if (!keepPinned || !c.pinned) this.dropClip(c);
    this.saveClips();
    this.audit('clipboard_history_clear', {});
    this.broadcast('ai:hub:clips');
    return true;
  }

  // ───────────── 导出 ─────────────
  /** 打包 userData 下的本地数据（不含模型、索引、缓存；密钥类文件只导出脱敏版本） */
  async exportAll(opts: { conversations?: unknown; include?: string[] } = {}) {
    const r = await dialog.showSaveDialog({
      title: tr('导出全部本地数据'),
      defaultPath: `nomi-export-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return null;
    return this.exportTo(r.filePath, opts);
  }
  exportTo(file: string, opts: { conversations?: unknown; include?: string[] } = {}) {
    const files: Record<string, Uint8Array> = {};
    const ud = this.d.userData;
    const add = (rel: string, data: Uint8Array | string) =>
      (files[rel] = typeof data === 'string' ? strToU8(data) : data);
    const addFile = (rel: string, abs: string) => {
      try {
        if (fs.statSync(abs).isFile() && fs.statSync(abs).size < 50 * 2 ** 20)
          add(rel, fs.readFileSync(abs));
      } catch {
        /* missing */
      }
    };
    const addDir = (
      rel: string,
      abs: string,
      filter: (n: string) => boolean = () => true,
      depth = 0,
    ) => {
      if (depth > 4) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        const r2 = `${rel}/${e.name}`;
        if (e.isDirectory()) addDir(r2, path.join(abs, e.name), filter, depth + 1);
        else if (filter(e.name)) addFile(r2, path.join(abs, e.name));
      }
    };
    const want = new Set(
      opts.include ?? [
        'conversations',
        'memory',
        'schedule',
        'calendar',
        'clipboard',
        'skills',
        'screen',
        'settings',
      ],
    );
    if (want.has('conversations') && opts.conversations)
      add('conversations.json', JSON.stringify(opts.conversations, null, 2));
    if (want.has('memory')) addDir('memory', path.join(ud, 'memory'));
    if (want.has('schedule')) addDir('schedule', path.join(ud, 'schedule'));
    if (want.has('calendar')) {
      add('calendar/local.ics', toIcs(this.events.filter((e) => e.cal === 'local')));
      add('calendar/sources.json', JSON.stringify(this.calState().sources, null, 2));
    }
    if (want.has('clipboard')) {
      add('clipboard/history.json', JSON.stringify(this.clips, null, 2));
      addDir('clipboard/images', this.clipDir);
    }
    if (want.has('skills')) addDir('skills', path.join(ud, 'skills'));
    if (want.has('settings')) addDir('notes', path.join(ud, 'desktop', 'notes'));
    if (want.has('screen'))
      addFile('screen-memory/entries.json', path.join(ud, 'screen-memory', 'entries.json'));
    if (want.has('settings')) {
      for (const f of [
        'desktop/settings.json',
        'desktop/reminders.json',
        'knowledge/settings.json',
        'voice/settings.json',
        'local/settings.json',
      ])
        addFile(`settings/${f}`, path.join(ud, f));
      // MCP 配置：只导出结构。密钥是否导出由字段语义决定（env / headers 取值、URL 凭据、
      // 命令行里的 token 一律移除），与它在磁盘上是否以 `enc:` 加密无关
      try {
        const mcp = JSON.parse(
          fs.readFileSync(path.join(ud, 'extensions', 'mcp.json'), 'utf8'),
        ) as Array<Record<string, unknown>>;
        add(
          'settings/mcp.json',
          JSON.stringify(
            mcp.map((s) => redactServerForExport(s, tr('<已移除>'))),
            null,
            2,
          ),
        );
      } catch {
        /* none */
      }
    }
    add(
      'README.txt',
      tr('Nomi 数据导出 {0}\n\n', new Date().toLocaleString('zh-CN')) +
        tr(
          '包含：对话、长期记忆、日程与提醒、日历（.ics）、剪贴板历史、技能、屏幕记忆文字、设置。\n',
        ) +
        tr('不含：API Key 等密钥（已移除）、下载的模型、知识库索引与缓存。\n'),
    );
    const zip = zipSync(files, { level: 6 });
    fs.writeFileSync(file, zip);
    this.audit('data_export', { files: Object.keys(files).length, bytes: zip.length });
    broadcastMascotCommand({ type: 'motion', name: 'nod' });
    return { file, files: Object.keys(files).length, bytes: zip.length };
  }

  tools(): ToolDefinition[] {
    const input = z
      .object({
        days: z.number().int().min(1).max(31).default(1).describe(tr('从今天起查看几天的日程')),
      })
      .strict();
    return [
      {
        name: 'calendar_list',
        description: tr('查看用户本地日历（含订阅的 ICS / CalDAV）从今天起若干天的日程。'),
        input,
        readOnly: true,
        execute: async (raw: unknown) => {
          const { days } = input.parse(raw ?? {});
          const s = new Date();
          s.setHours(0, 0, 0, 0);
          const list = this.occurrences(s.getTime(), s.getTime() + days * 86_400_000).slice(0, 50);
          return {
            ok: true,
            data: {
              events: list.map((o) => ({
                title: o.summary,
                start: new Date(o.start).toLocaleString('zh-CN'),
                end: new Date(o.end).toLocaleString('zh-CN'),
                allDay: o.allDay,
                location: o.location,
              })),
            },
          };
        },
      } as unknown as ToolDefinition,
    ];
  }

  registerIpc() {
    if (this.ipcDone) return;
    this.ipcDone = true;
    const h = (ch: string, fn: (...a: never[]) => unknown) =>
      guardedHandle(
        `ai:hub:${ch}`,
        async (...a: unknown[]) => {
          try {
            return await fn(...(a as never[]));
          } catch (err) {
            return { __error: { code: 'hub', message: (err as Error).message } };
          }
        },
        { owner: 'LocalHubService', wrapErrors: false },
      );
    h('cal-state', () => this.calState());
    h('cal-range', (from: number, to: number) => this.occurrences(Number(from), Number(to)));
    h('cal-upsert', (p: never) => this.upsertEvent(p));
    h('cal-remove', (uid: string) => this.removeEvent(String(uid)));
    h('cal-import', () => this.importIcsDialog());
    h('cal-import-text', (t: string, n: string) => this.importIcsText(String(t), String(n ?? '')));
    h('cal-add-source', (p: never) => this.addSource(p));
    h('cal-sync', (id: string) => this.sync(String(id)));
    h('cal-toggle', (id: string, v: boolean) => this.toggleSource(String(id), !!v));
    h('cal-remove-source', (id: string) => this.removeSource(String(id)));
    h('cal-export', () => this.exportIcs());
    h('cal-system-info', () => systemCalendarInfo());
    h('cal-system-connect', () => this.addSystemSource());
    h('cal-system-create', (p: never) => this.createSystemEvent(p));
    h('clip-state', () => this.clipState());
    h('clip-settings', (p: never) => this.setClipSettings(p));
    h('clip-copy', (id: string) => this.copyClip(String(id)));
    h('clip-image', (id: string) => this.clipImage(String(id)));
    h('clip-pin', (id: string, v: boolean) => this.pinClip(String(id), !!v));
    h('clip-remove', (id: string) => this.removeClip(String(id)));
    h('clip-clear', () => this.clearClips());
    h('export', (o: never) => this.exportAll(o));
  }
}

let inst: LocalHubService | null = null;
export function initLocalHubService(d: HubDeps) {
  inst = new LocalHubService(d);
  return inst;
}
export function getLocalHubService() {
  return inst;
}
