/**
 * 灵动岛式通知（独立实现；思路参考 NotchNook / Alcove / Boring Notch 的公开描述：
 * 透明、无边框、不抢焦点、层级高于菜单栏的面板，贴在刘海 / 屏幕顶部居中，展开动画）。
 *
 * - macOS 刘海屏：黑色岛从刘海里「长」出来；非刘海屏 / 外接屏：顶部居中浮动胶囊。
 * - Windows / Linux：可选的顶部胶囊（默认关，沿用原有气泡 / 系统通知）。
 * - 免打扰时段（日程 → 免打扰）内不弹；macOS 专注模式没有公开 API 可读，无法感知。
 * - 用于：AI 主动消息、编程助手进度、日程提醒。点击岛打开对话窗口。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { IslandKind, IslandNotice } from '@nomi-ai/core/desktop/islandNotice';
import type { Translate } from '@nomi-ai/core/i18n';
import { BrowserWindow, screen } from 'electron';

import { brand } from '../brand';
import { setWindowBounds } from '../host/windowBounds';

import {
  clampIslandHeight,
  islandGeometry,
  islandWindowRect,
  type IslandGeometry,
} from './geometry';
import { islandHtml } from './islandPage';

export type { IslandKind, IslandNotice };

export interface IslandSettings {
  enabled: boolean;
  /** auto：刘海屏贴刘海，否则胶囊；pill：始终胶囊 */
  style: 'auto' | 'pill';
  kinds: Record<Exclude<IslandKind, 'info'>, boolean>;
}

export const defaultIslandSettings = (platform: NodeJS.Platform): IslandSettings => ({
  enabled: platform === 'darwin',
  style: 'auto',
  kinds: { message: true, agent: true, reminder: true },
});

export function sanitizeIsland(raw: unknown, platform: NodeJS.Platform): IslandSettings {
  const d = defaultIslandSettings(platform);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<IslandSettings>;
  const k = (o.kinds ?? {}) as Partial<IslandSettings['kinds']>;
  const b = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    enabled: b(o.enabled, d.enabled),
    style: o.style === 'pill' ? 'pill' : 'auto',
    kinds: {
      message: b(k.message, true),
      agent: b(k.agent, true),
      reminder: b(k.reminder, true),
    },
  };
}

type Deps = {
  file: string;
  /** 内核实例的翻译函数（`core.i18n.t`） */
  t: Translate;
  isQuiet?: () => boolean;
  openChat?: () => void;
  platform?: NodeJS.Platform;
  logger?: { warn(m: string, d?: unknown): void };
};

export class IslandService {
  private settings: IslandSettings;
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private queue: IslandNotice[] = [];
  private showing = false;
  private geom: IslandGeometry | null = null;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly d: Deps) {
    this.platform = d.platform ?? process.platform;
    let raw: unknown = {};
    try {
      raw = JSON.parse(fs.readFileSync(d.file, 'utf8'));
    } catch {
      /* 首次 */
    }
    this.settings = sanitizeIsland(raw, this.platform);
  }

  get(): IslandSettings & { mode: 'notch' | 'pill'; platform: NodeJS.Platform } {
    let mode: 'notch' | 'pill' = 'pill';
    try {
      mode = islandGeometry(this.platform, screen.getPrimaryDisplay(), this.settings.style).mode;
    } catch {
      /* 测试环境 */
    }
    return { ...this.settings, mode, platform: this.platform };
  }

  set(patch: Partial<IslandSettings>): IslandSettings {
    this.settings = sanitizeIsland(
      { ...this.settings, ...patch, kinds: { ...this.settings.kinds, ...(patch.kinds ?? {}) } },
      this.platform,
    );
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
    fs.writeFileSync(this.d.file, JSON.stringify(this.settings, null, 2), 'utf8');
    if (!this.settings.enabled) this.destroy();
    return this.settings;
  }

  /** 是否会显示这条通知（开关 / 类型 / 免打扰） */
  accepts(n: IslandNotice, force = false): boolean {
    if (force) return true;
    if (!this.settings.enabled) return false;
    if (n.kind !== 'info' && !this.settings.kinds[n.kind]) return false;
    if (this.d.isQuiet?.()) return false;
    return true;
  }

  notify(n: IslandNotice, force = false): boolean {
    if (!this.accepts(n, force)) return false;
    const clean: IslandNotice = {
      kind: n.kind,
      title: String(n.title ?? '').slice(0, 80),
      body: String(n.body ?? '').slice(0, 160),
      durationMs: n.durationMs,
      ...(n.endpoint ? { endpoint: String(n.endpoint).slice(0, 24) } : {}),
      ...(n.status ? { status: n.status } : {}),
    };
    // 同样的内容排队中就不重复
    if (!this.queue.some((q) => q.title === clean.title && q.body === clean.body))
      this.queue.push(clean);
    if (this.queue.length > 5) this.queue.splice(0, this.queue.length - 5);
    void this.pump();
    return true;
  }

  private ensureWindow(): Promise<void> {
    const display = screen.getPrimaryDisplay();
    const g = islandGeometry(this.platform, display, this.settings.style);
    const same =
      this.geom &&
      this.geom.x === g.x &&
      this.geom.y === g.y &&
      this.geom.width === g.width &&
      this.geom.mode === g.mode;
    if (this.win && !this.win.isDestroyed() && same && this.ready) return this.ready;
    this.destroy();
    this.geom = g;
    const rect = islandWindowRect(g, g.height);
    const win = new BrowserWindow({
      ...rect,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      backgroundColor: '#00000000',
      title: `${brand.appName} Island`,
      ...(this.platform === 'darwin' ? { type: 'panel' as const } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        // 独立的内存会话：默认会话上的统一 CSP 响应头（script-src 'self'）会连带拦掉这个 data: 页面的
        // 内联脚本，岛就只剩一个空黑块、永远不展开。页面自带更严的 meta CSP（default-src 'none'）。
        partition: 'nomi-island',
      },
    });
    // 菜单栏之上（≈ NSStatusWindowLevel），全屏 App 与所有桌面空间都可见
    win.setAlwaysOnTop(true, this.platform === 'darwin' ? 'status' : 'screen-saver');
    // 必须 skipTransformProcessType：默认会把整个进程在 Foreground ↔ UIElement 间来回转换，
    // macOS 会因此丢掉菜单栏 App 菜单 / 状态栏图标与 Dock（每次弹岛都发生）。见 docs 的托盘说明。
    if (this.platform === 'darwin') applyIslandWorkspaceBehavior(win);
    win.webContents.on('did-navigate-in-page', (_e, url) => {
      if (/#open-/.test(url)) this.d.openChat?.();
    });
    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      if (title.startsWith('hidden:')) {
        if (!win.isDestroyed()) win.hide();
        this.showing = false;
        void this.pump();
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win = win;
    this.ready = win
      .loadURL(
        `data:text/html;charset=utf-8;base64,${Buffer.from(islandHtml(g)).toString('base64')}`,
      )
      .then(() => undefined);
    return this.ready;
  }

  private async pump(): Promise<void> {
    if (this.showing) return;
    const next = this.queue.shift();
    if (!next) return;
    this.showing = true;
    try {
      await this.ensureWindow();
      const w = this.win;
      if (!w || w.isDestroyed()) throw new Error('island window gone');
      // 先在隐藏状态下填充内容并量出内容高度 → 窗口高度 = 岛高度（不留空黑），再显示并播放展开动画
      const measured = await w.webContents.executeJavaScript(
        `window.__island.prepare(${JSON.stringify(next)})`,
      );
      const g = this.geom;
      if (g) {
        setWindowBounds(w, islandWindowRect(g, clampIslandHeight(g, Number(measured))));
      }
      w.showInactive();
      if (g && process.platform === 'win32')
        setWindowBounds(w, islandWindowRect(g, clampIslandHeight(g, Number(measured))));
      await w.webContents.executeJavaScript(`window.__island.play(${JSON.stringify(next)})`);
    } catch (e) {
      this.showing = false;
      this.d.logger?.warn('island notify failed', String(e));
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = null;
    this.geom = null;
    this.showing = false;
  }

  /** 设置页「测试」：不论开关与免打扰都弹一条示例通知；返回是否显示 */
  test(): boolean {
    return this.notify(
      {
        kind: 'message',
        title: brand.appName,
        body: this.d.t('electron.common.this-is-what-an-island-notification-looks-like'),
        durationMs: 4000,
      },
      true,
    );
  }
}

/** 岛窗口的「所有空间 + 全屏可见」设置；单独导出便于回归测试 */
export function applyIslandWorkspaceBehavior(win: {
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
}): void {
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}
