/**
 * 界面主题：用户选择持久化到 userData/theme.json，广播给所有窗口（对话窗口 + 看板娘）。
 * 「跟随系统」用 nativeTheme 解析：深色 → Graphite，浅色 → Cream，系统切换时实时更新。
 * 新用户默认 Sunset Orange；已保存的选择优先。
 *
 * macOS 窗口外观（nativeTheme.themeSource）跟随所选主题：否则系统是浅色、主题是深色时，
 * 失焦窗口的红绿灯按浅色外观画成半透明深灰，落在深色标题栏上就看不见了。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, nativeTheme } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

export const THEME_IDS = ['mist', 'graphite', 'ink', 'cream', 'sunset'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ThemePref = ThemeId | 'system' | 'image';
export const DEFAULT_THEME: ThemePref = 'sunset';

export const normalizeThemePref = (v: unknown): ThemePref | null => {
  if (typeof v !== 'string') return null;
  if (v === 'system' || v === 'image') return v;
  return (THEME_IDS as readonly string[]).includes(v) ? (v as ThemeId) : null;
};

export const isThemePref = (v: unknown): v is ThemePref => normalizeThemePref(v) !== null;
export const resolveTheme = (pref: ThemePref, dark: boolean): ThemeId =>
  pref === 'image' ? 'graphite' : pref === 'system' ? (dark ? 'graphite' : 'cream') : pref;

/** 深色主题：窗口外观用 dark（与 packages/ui/src/tokens.css 的深色主题一致） */
const DARK_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(['graphite', 'ink']);

/** 所选主题对应的原生窗口外观；「跟随系统」交还给系统 */
export const appearanceFor = (pref: ThemePref): 'system' | 'dark' | 'light' =>
  pref === 'system' ? 'system' : DARK_THEMES.has(resolveTheme(pref, true)) ? 'dark' : 'light';

export interface ThemeState {
  pref: ThemePref;
  resolved: ThemeId;
}

interface NativeThemeLike {
  shouldUseDarkColors: boolean;
  themeSource?: 'system' | 'dark' | 'light';
  on(ev: 'updated', fn: () => void): unknown;
}

export class ThemeService {
  private pref: ThemePref = DEFAULT_THEME;
  private listeners = new Set<(s: ThemeState) => void>();

  /** 主题变化（含「跟随系统」时系统切换）回调；返回取消订阅 */
  onChange(fn: (s: ThemeState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  constructor(
    private readonly file: string,
    private readonly native: NativeThemeLike = nativeTheme,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { theme?: unknown };
      const n = normalizeThemePref(raw.theme);
      if (n) this.pref = n;
    } catch {
      /* 首次运行：用默认 */
    }
    this.syncAppearance();
    this.native.on('updated', () => {
      if (this.pref === 'system') this.broadcast();
    });
  }

  get(): ThemeState {
    return { pref: this.pref, resolved: resolveTheme(this.pref, this.native.shouldUseDarkColors) };
  }

  set(id: unknown): ThemeState {
    const n = normalizeThemePref(id);
    if (!n) throw new Error(`unknown theme: ${String(id)}`);
    this.pref = n;
    // 先切外观再解析：从固定主题切回「跟随系统」时，shouldUseDarkColors 要按系统重新算
    this.syncAppearance();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ theme: n }, null, 2), 'utf8');
    this.broadcast();
    return this.get();
  }

  private syncAppearance(): void {
    if (this.platform !== 'darwin') return;
    const next = appearanceFor(this.pref);
    if (this.native.themeSource !== next) this.native.themeSource = next;
  }

  private broadcast(): void {
    const s = this.get();
    for (const fn of this.listeners) fn(s);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ai:theme:changed', s);
    }
  }

  registerIpc(): void {
    const opts = { owner: 'ThemeService', wrapErrors: false };
    guardedHandle('ai:theme:get', () => this.get(), opts);
    guardedHandle('ai:theme:set', (id) => this.set(id), opts);
  }
}
