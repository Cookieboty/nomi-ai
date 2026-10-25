/**
 * 主进程 i18n（托盘、原生对话框、系统通知、看板娘主动消息、返回给界面的错误提示）。
 * 词典和稳定 key 由 @nomi-ai/i18n 统一管理；这里负责 Electron 的偏好持久化与广播。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  createTranslator,
  getDictionary,
  isLocalePref,
  resolveLocale,
  type LocalePref as CatalogLocalePref,
} from '@nomi-ai/i18n';
import { BrowserWindow, app } from 'electron';

import { guardedHandle } from '../security/guardedIpc';

export type Locale = 'zh-CN' | 'en';
export type LocalePref = CatalogLocalePref;
export { isLocalePref, resolveLocale };

let locale: Locale = 'zh-CN';
let pref: LocalePref = 'system';
const listeners = new Set<(l: Locale) => void>();
const translate = createTranslator(() => locale);

export function t(key: string, ...args: unknown[]): string;
export function t<T>(key: T): T;
export function t(key: unknown, ...args: unknown[]): unknown {
  return translate(key, ...args);
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
    // 为诊断和插件接口保留统一的英文词典查询能力。
    guardedHandle('ai:locale:dict', () => getDictionary('en'), opts);
  }
}
