/**
 * 界面主题：用户选择持久化到 userData/theme.json，广播给所有窗口（对话窗口 + 看板娘）。
 * 「跟随系统」用 nativeTheme 解析：深色 → Graphite，浅色 → Cream，系统切换时实时更新。
 * 新用户默认 Warm Ink；已保存的选择优先。历史 id `paper` 读入时映射为 `cream`。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, ipcMain, nativeTheme } from 'electron';

export const THEME_IDS = ['mist', 'graphite', 'ink', 'cream'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ThemePref = ThemeId | 'system';
export const DEFAULT_THEME: ThemePref = 'ink';

const LEGACY: Record<string, ThemeId> = { paper: 'cream' };

export const normalizeThemePref = (v: unknown): ThemePref | null => {
  if (typeof v !== 'string') return null;
  if (v === 'system') return 'system';
  if (v in LEGACY) return LEGACY[v]!;
  return (THEME_IDS as readonly string[]).includes(v) ? (v as ThemeId) : null;
};

export const isThemePref = (v: unknown): v is ThemePref => normalizeThemePref(v) !== null;
export const resolveTheme = (pref: ThemePref, dark: boolean): ThemeId =>
  pref === 'system' ? (dark ? 'graphite' : 'cream') : pref;

export interface ThemeState {
  pref: ThemePref;
  resolved: ThemeId;
}

interface NativeThemeLike {
  shouldUseDarkColors: boolean;
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
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { theme?: unknown };
      const n = normalizeThemePref(raw.theme);
      if (n) this.pref = n;
    } catch {
      /* 首次运行：用默认 */
    }
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ theme: n }, null, 2), 'utf8');
    this.broadcast();
    return this.get();
  }

  private broadcast(): void {
    const s = this.get();
    for (const fn of this.listeners) fn(s);
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ai:theme:changed', s);
    }
  }

  registerIpc(): void {
    ipcMain.removeHandler('ai:theme:get');
    ipcMain.removeHandler('ai:theme:set');
    ipcMain.handle('ai:theme:get', () => this.get());
    ipcMain.handle('ai:theme:set', (_e, id: unknown) => this.set(id));
  }
}
