/**
 * 主进程 i18n（托盘、原生对话框、系统通知、看板娘主动消息、返回给界面的错误提示）。
 * 与渲染进程同一套规则：中文原文作 key，en.json 提供英文；`ai:locale:*` 持久化并广播。
 * 新用户默认跟随系统语言（zh* → 中文，其余 → English）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, app } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

import en from './en.json';

export type Locale = 'zh-CN' | 'en';
export type LocalePref = Locale | 'system';
export const isLocalePref = (v: unknown): v is LocalePref =>
  v === 'system' || v === 'zh-CN' || v === 'en';

export const resolveLocale = (pref: LocalePref, system: readonly string[]): Locale =>
  pref !== 'system'
    ? pref
    : String(system[0] ?? '')
          .toLowerCase()
          .startsWith('zh')
      ? 'zh-CN'
      : 'en';

const EN = en as Record<string, string>;
let locale: Locale = 'zh-CN';
let pref: LocalePref = 'system';
const listeners = new Set<(l: Locale) => void>();

export function format(s: string, args: unknown[]): string {
  if (!args.length) return s;
  const named =
    args.length === 1 && args[0] && typeof args[0] === 'object'
      ? (args[0] as Record<string, unknown>)
      : null;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = named ? named[k] : args[Number(k)];
    return v === undefined ? m : String(v);
  });
}

export function t(key: string, ...args: unknown[]): string;
export function t<T>(key: T): T;
export function t(key: unknown, ...args: unknown[]): unknown {
  if (typeof key !== 'string') return key;
  if (locale === 'zh-CN') return format(key, args);
  // 插值参数若本身是词典里的文案（常量里的标签），一并翻译
  const tx = args.map((a) => (typeof a === 'string' ? (EN[a] ?? a) : a));
  return format(EN[key] ?? key, tx);
}
export const getLocale = (): Locale => locale;
/** 语言变化时回调（托盘菜单等需要重建的地方） */
export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function systemLanguages(): string[] {
  // 测试 / e2e 可用 CD_LOCALE 固定语言
  if (process.env.CD_LOCALE) return [process.env.CD_LOCALE];
  try {
    const l = app.getPreferredSystemLanguages?.();
    if (l?.length) return l;
  } catch {
    /* ignore */
  }
  try {
    return [app.getLocale()];
  } catch {
    return [];
  }
}

export class LocaleService {
  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { locale?: unknown };
      if (isLocalePref(raw.locale)) pref = raw.locale;
    } catch {
      /* 首次运行：跟随系统 */
    }
    locale = resolveLocale(pref, systemLanguages());
  }

  get(): { pref: LocalePref; locale: Locale } {
    return { pref, locale };
  }

  set(p: unknown): { pref: LocalePref; locale: Locale } {
    if (!isLocalePref(p)) throw new Error(`unknown locale: ${String(p)}`);
    pref = p;
    const next = resolveLocale(p, systemLanguages());
    const changed = next !== locale;
    locale = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ locale: p }, null, 2), 'utf8');
    const s = this.get();
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ai:locale:changed', s);
    }
    if (changed) listeners.forEach((f) => f(locale));
    return s;
  }

  registerIpc(): void {
    const opts = { owner: 'LocaleService', wrapErrors: false };
    guardedHandle('ai:locale:get', () => this.get(), opts);
    guardedHandle('ai:locale:set', (p) => this.set(p), opts);
    // 主进程常量（模型目录、预设名称等）会原样发给界面，界面用这份词典补充翻译
    guardedHandle('ai:locale:dict', () => EN, opts);
  }
}
