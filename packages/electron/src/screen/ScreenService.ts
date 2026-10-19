/**
 * 截图提问 + 可选的本地屏幕记忆。
 *
 * - 截图提问：隐藏对话窗 → 截主屏 → 全屏遮罩里框选 → 裁剪压缩后作为图片附件交给对话窗。
 *   发送给模型前由渲染层调用 `check-send`，走 PermissionBroker 的云端告知 / 仅本地模式。
 * - 屏幕记忆：默认关闭。开启后按间隔截屏 → 本地 OCR（复用知识库的 tesseract 语言包）
 *   → 只保存文字 + 小缩略图在 userData/screen-memory；任一可见窗口命中排除词则整帧跳过；
 *   托盘与对话窗显示「● 屏幕记忆中」，可随时暂停 / 清空。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolDefinition } from '@nomi-ai/bundle-ig-base';
import {
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  nativeImage,
  powerMonitor,
  screen,
  type NativeImage,
} from 'electron';
import { z } from 'zod';

import { broadcastMascotCommand } from '../ai/mascotCommand';
import type { DesktopService } from '../desktop/DesktopService';
import { t } from '../i18n';
import { Bm25Index } from '../knowledge/bm25';
import { guardedHandle } from '../security/guardedIpc';
import { installWindowGuards } from '../security/windowGuards';

import {
  cleanOcr,
  expired,
  matchExclusion,
  sanitizeScreenSettings,
  similarFrame,
  toGray,
  toImageRect,
  type ScreenMemSettings,
} from './screenMemory';

interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
}

export interface ScreenDeps {
  root: string;
  logger: Logger;
  desktop: DesktopService;
  /** 本地 OCR（知识库服务）；缺语言包时抛错 */
  ocr: (img: Buffer) => Promise<string>;
  ocrReady: () => boolean;
  chatWindow: () => BrowserWindow | null;
  openChat: () => Promise<BrowserWindow>;
  /** 用对话页的 #snip 路由加载遮罩窗口 */
  loadOverlay: (win: BrowserWindow) => Promise<void>;
}

export interface Attachment {
  mime: 'image/jpeg' | 'image/png';
  data: string;
  width: number;
  height: number;
  source: 'snip' | 'screen' | 'paste';
}

export interface ScreenEntry {
  id: string;
  at: number;
  windows: string[];
  text: string;
  thumb?: string;
}

const MAX_SIDE = 1568;
const SNIP_HOTKEY = 'CommandOrControl+Alt+A';

export class ScreenService {
  private settings: ScreenMemSettings;
  private entries: ScreenEntry[] = [];
  private index = new Bm25Index();
  private timer: NodeJS.Timeout | null = null;
  private lastGray: Uint8Array | null = null;
  private busy = false;
  private overlay: BrowserWindow | null = null;
  private snipImage: NativeImage | null = null;
  private snipResolve: ((a: Attachment | null) => void) | null = null;
  private listeners = new Set<() => void>();
  private ipcDone = false;
  lastSkip = '';

  constructor(private readonly d: ScreenDeps) {
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.settings = sanitizeScreenSettings(this.readJson('settings.json'));
    const raw = this.readJson('entries.json');
    this.entries = Array.isArray(raw) ? (raw as ScreenEntry[]) : [];
    for (const e of this.entries) this.index.add(e.id, `${e.windows.join(' ')} ${e.text}`);
  }

  private get thumbDir() {
    return path.join(this.d.root, 'thumbs');
  }
  private readJson(f: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.d.root, f), 'utf8'));
    } catch {
      return null;
    }
  }
  private writeJson(f: string, v: unknown) {
    const p = path.join(this.d.root, f);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(v));
    fs.renameSync(`${p}.tmp`, p);
  }

  // ───────────── 状态 ─────────────
  active(): boolean {
    return this.settings.enabled && this.settings.pausedUntil <= Date.now();
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    for (const fn of this.listeners) fn();
    this.broadcast('ai:screen:changed', this.state());
  }
  private broadcast(ch: string, payload: unknown) {
    for (const w of BrowserWindow.getAllWindows())
      if (!w.isDestroyed()) w.webContents.send(ch, payload);
  }
  state() {
    return {
      settings: this.settings,
      active: this.active(),
      count: this.entries.length,
      ocrReady: this.d.ocrReady(),
      lastSkip: this.lastSkip,
      chat: this.d.desktop.providerFor('chat'),
      localOnly: this.d.desktop.broker.localOnly,
    };
  }

  start(): void {
    this.applyHotkey();
    this.reschedule();
    this.prune();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      globalShortcut.unregister(SNIP_HOTKEY);
    } catch {
      /* ignore */
    }
  }

  private applyHotkey() {
    try {
      globalShortcut.unregister(SNIP_HOTKEY);
      if (this.settings.snipHotkey)
        globalShortcut.register(SNIP_HOTKEY, () => void this.snipToChat());
    } catch (e) {
      this.d.logger.warn('截图快捷键注册失败', { error: String(e) });
    }
  }

  private reschedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.settings.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.settings.intervalSec * 1000);
  }

  setSettings(p: Partial<ScreenMemSettings>): ScreenMemSettings {
    const was = this.settings.enabled;
    this.settings = sanitizeScreenSettings({ ...this.settings, ...p });
    this.writeJson('settings.json', this.settings);
    this.reschedule();
    this.applyHotkey();
    if (!was && this.settings.enabled) {
      this.d.desktop.say(t('好的，我会在本机记下屏幕上的文字，敏感窗口会自动跳过，随时可以暂停～'));
      broadcastMascotCommand({ type: 'motion', name: 'nod' });
    }
    this.d.desktop.audit.append({
      tool: 'screen_memory_settings',
      args: { enabled: this.settings.enabled, intervalSec: this.settings.intervalSec },
      decision: 'user',
      result: 'ok',
      ms: 0,
      source: 'settings',
    } as never);
    this.changed();
    return this.settings;
  }

  pause(minutes: number) {
    this.setSettings({ pausedUntil: Date.now() + minutes * 60_000 });
  }

  // ───────────── 截图提问 ─────────────
  private async grab(display = screen.getPrimaryDisplay()): Promise<NativeImage> {
    const w = Math.round(display.bounds.width * display.scaleFactor);
    const h = Math.round(display.bounds.height * display.scaleFactor);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
    });
    const s = sources.find((x) => x.display_id === String(display.id)) ?? sources[0];
    if (!s) throw new Error(t('无法读取屏幕（可能需要在系统设置里授予屏幕录制权限）'));
    return s.thumbnail;
  }

  static toAttachment(img: NativeImage, source: Attachment['source']): Attachment {
    let out = img;
    const { width, height } = img.getSize();
    const long = Math.max(width, height);
    if (long > MAX_SIDE) {
      const k = MAX_SIDE / long;
      out = img.resize({ width: Math.round(width * k), height: Math.round(height * k) });
    }
    const sz = out.getSize();
    return {
      mime: 'image/jpeg',
      data: out.toJPEG(85).toString('base64'),
      width: sz.width,
      height: sz.height,
      source,
    };
  }

  /** 截图并框选；返回附件或 null（取消） */
  async snip(): Promise<Attachment | null> {
    if (this.overlay) {
      this.overlay.focus();
      return null;
    }
    const chat = this.d.chatWindow();
    const wasVisible = !!chat && !chat.isDestroyed() && chat.isVisible();
    if (wasVisible) chat!.hide();
    await new Promise((r) => setTimeout(r, 250));
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    try {
      this.snipImage = await this.grab(display);
    } catch (e) {
      if (wasVisible) chat!.show();
      throw e;
    }
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'ai-chat-preload.bundle.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    installWindowGuards(win);
    this.overlay = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    const done = new Promise<Attachment | null>((resolve) => (this.snipResolve = resolve));
    win.on('closed', () => {
      this.overlay = null;
      this.snipResolve?.(null);
      this.snipResolve = null;
      this.snipImage = null;
      if (wasVisible) this.d.chatWindow()?.show();
    });
    await this.d.loadOverlay(win);
    win.show();
    win.focus();
    return done;
  }

  private finishSnip(
    rect: { x: number; y: number; width: number; height: number } | null,
    view?: { width: number; height: number },
  ) {
    const img = this.snipImage;
    let att: Attachment | null = null;
    if (img && rect && view && rect.width >= 4 && rect.height >= 4) {
      const r = toImageRect(rect, view, img.getSize());
      att = ScreenService.toAttachment(img.crop(r), 'snip');
    } else if (img && rect === null && view) {
      att = null;
    }
    const resolve = this.snipResolve;
    this.snipResolve = null;
    resolve?.(att);
    this.overlay?.close();
    if (att) {
      broadcastMascotCommand({ type: 'motion', name: 'nod' });
      this.d.desktop.audit.append({
        tool: 'screen_snip',
        args: { width: att.width, height: att.height },
        decision: 'user',
        result: 'ok',
        ms: 0,
        source: 'settings',
      } as never);
    }
  }

  /** 快捷键入口：截图后打开对话窗并附上图片 */
  async snipToChat(): Promise<void> {
    try {
      const att = await this.snip();
      if (!att) return;
      const win = await this.d.openChat();
      const send = () => !win.isDestroyed() && win.webContents.send('ai:screen:attachment', att);
      if (win.webContents.isLoading())
        win.webContents.once('did-finish-load', () => setTimeout(send, 400));
      else send();
    } catch (e) {
      this.d.desktop.say(t('截图失败：{0}', (e as Error).message));
    }
  }

  async captureFull(): Promise<Attachment> {
    const chat = this.d.chatWindow();
    const wasVisible = !!chat && chat.isVisible();
    if (wasVisible) chat!.hide();
    await new Promise((r) => setTimeout(r, 250));
    try {
      return ScreenService.toAttachment(await this.grab(), 'screen');
    } finally {
      if (wasVisible) chat!.show();
    }
  }

  // ───────────── 屏幕记忆 ─────────────
  async tick(force = false): Promise<{ saved: boolean; reason: string }> {
    const r = await this.sample(force);
    this.lastSkip = r.saved ? '' : r.reason;
    return r;
  }

  private async sample(force: boolean): Promise<{ saved: boolean; reason: string }> {
    if (!force && !this.active()) return { saved: false, reason: 'off' };
    if (this.busy) return { saved: false, reason: 'busy' };
    if (!this.d.ocrReady()) return { saved: false, reason: 'ocr-missing' };
    try {
      if (!force && powerMonitor.getSystemIdleTime() > 300) return { saved: false, reason: 'idle' };
    } catch {
      /* ignore */
    }
    this.busy = true;
    try {
      const wins = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const names = wins.map((w) => w.name).filter((n) => n && !/Nomi/i.test(n));
      const hit = matchExclusion(names, this.settings.exclusions);
      if (hit) return { saved: false, reason: `excluded:${hit}` };
      const img = await this.grab();
      const small = img.resize({ width: 32, height: 18 });
      const gray = toGray(new Uint8Array(small.toBitmap()));
      if (!force && similarFrame(this.lastGray, gray)) return { saved: false, reason: 'unchanged' };
      this.lastGray = gray;
      const big = img.resize({ width: Math.min(1600, img.getSize().width) });
      const text = cleanOcr(await this.d.ocr(big.toPNG()));
      if (text.length < 8) return { saved: false, reason: 'no-text' };
      const id = randomUUID();
      const thumb = `${id}.jpg`;
      fs.writeFileSync(path.join(this.thumbDir, thumb), img.resize({ width: 320 }).toJPEG(70));
      const e: ScreenEntry = { id, at: Date.now(), windows: names.slice(0, 8), text, thumb };
      this.entries.push(e);
      this.index.add(id, `${e.windows.join(' ')} ${text}`);
      this.prune();
      this.writeJson('entries.json', this.entries);
      this.broadcast('ai:screen:changed', this.state());
      return { saved: true, reason: 'ok' };
    } catch (err) {
      this.d.logger.warn('屏幕记忆采样失败', { error: String(err) });
      return { saved: false, reason: 'error' };
    } finally {
      this.busy = false;
    }
  }

  private prune() {
    const old = expired(this.entries, this.settings.retentionDays, Date.now());
    if (!old.length) return;
    const ids = new Set(old.map((o) => o.id));
    for (const o of old) this.dropFiles(o);
    this.entries = this.entries.filter((e) => !ids.has(e.id));
    for (const id of ids) this.index.remove(id);
    this.writeJson('entries.json', this.entries);
  }
  private dropFiles(e: ScreenEntry) {
    if (e.thumb) fs.rmSync(path.join(this.thumbDir, e.thumb), { force: true });
  }

  search(q: string, limit = 20): Array<ScreenEntry & { thumbUrl?: string }> {
    const list = q.trim()
      ? this.index
          .search(q, limit)
          .map((h) => this.entries.find((e) => e.id === h.id))
          .filter((e): e is ScreenEntry => !!e)
      : [...this.entries].sort((a, b) => b.at - a.at).slice(0, limit);
    return list.map((e) => ({ ...e, thumbUrl: this.thumbData(e) }));
  }
  private thumbData(e: ScreenEntry): string | undefined {
    if (!e.thumb) return undefined;
    try {
      return `data:image/jpeg;base64,${fs.readFileSync(path.join(this.thumbDir, e.thumb)).toString('base64')}`;
    } catch {
      return undefined;
    }
  }
  remove(id: string): boolean {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return false;
    this.dropFiles(e);
    this.entries = this.entries.filter((x) => x.id !== id);
    this.index.remove(id);
    this.writeJson('entries.json', this.entries);
    this.changed();
    return true;
  }
  clear(): number {
    const n = this.entries.length;
    for (const e of this.entries) this.dropFiles(e);
    this.entries = [];
    this.index = new Bm25Index();
    this.writeJson('entries.json', this.entries);
    this.d.desktop.audit.append({
      tool: 'screen_memory_clear',
      args: { n },
      decision: 'user',
      result: 'ok',
      ms: 0,
      source: 'settings',
    } as never);
    this.changed();
    return n;
  }

  /** 给模型用的工具：搜索本机屏幕记忆（仅在开启后可用） */
  tools(): ToolDefinition[] {
    const input = z
      .object({ query: z.string().min(1).max(200).describe(t('要找的文字或话题')) })
      .strict();
    return [
      {
        name: 'screen_memory_search',
        description: t(
          '搜索用户本机的「屏幕记忆」（之前屏幕上出现过的文字）。仅当用户问“我之前在屏幕上看到的…”之类问题时使用。',
        ),
        input,
        execute: async (raw: unknown) => {
          if (!this.settings.enabled)
            return { ok: false, error: { code: 'disabled', message: t('用户没有开启屏幕记忆') } };
          const { query } = input.parse(raw);
          const send = await this.d.desktop.broker.checkSend(
            this.d.desktop.providerFor('chat'),
            undefined,
            t('屏幕记忆文字'),
          );
          if (send)
            return {
              ok: false,
              error: {
                code: send,
                message:
                  send === 'local_only' ? t('仅本地模式：不能发给云端模型') : t('用户拒绝发送'),
              },
            };
          const hits = this.search(query, 5).map((e) => ({
            time: new Date(e.at).toLocaleString('zh-CN'),
            windows: e.windows.slice(0, 3),
            text: e.text.slice(0, 600),
          }));
          return { ok: true, data: { results: hits } };
        },
      } as unknown as ToolDefinition,
    ];
  }

  registerIpc(): void {
    if (this.ipcDone) return;
    this.ipcDone = true;
    const h = (ch: string, fn: (...a: never[]) => unknown) =>
      guardedHandle(
        `ai:screen:${ch}`,
        async (...a: unknown[]) => {
          try {
            return await fn(...(a as never[]));
          } catch (err) {
            return { __error: { code: 'screen', message: (err as Error).message } };
          }
        },
        { owner: 'ScreenService', wrapErrors: false },
      );
    h('state', () => this.state());
    h('set-settings', (p: Partial<ScreenMemSettings>) => this.setSettings(p));
    h('pause', (m: number) => this.pause(Number(m) || 60));
    h('resume', () => this.setSettings({ pausedUntil: 0 }));
    h('snip', () => this.snip());
    h('capture-full', () => this.captureFull());
    h('snip-source', () => {
      const img = this.snipImage;
      if (!img) return null;
      const s = img.getSize();
      return { url: `data:image/jpeg;base64,${img.toJPEG(80).toString('base64')}`, ...s };
    });
    h('snip-done', (rect: never, view: never) => this.finishSnip(rect, view));
    h('check-send', async () => {
      const r = await this.d.desktop.broker.checkSend(
        this.d.desktop.providerFor('chat'),
        undefined,
        t('图片 / 截图'),
      );
      return r ?? 'ok';
    });
    h('sample-now', () => this.tick(true));
    h('search', (q: string) => this.search(String(q ?? '')));
    h('remove', (id: string) => this.remove(id));
    h('clear', () => this.clear());
  }
}

let inst: ScreenService | null = null;
export function initScreenService(d: ScreenDeps): ScreenService {
  inst = new ScreenService(d);
  return inst;
}
export function getScreenService(): ScreenService | null {
  return inst;
}
export const __nativeImage = nativeImage;
