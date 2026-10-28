/**
 * 主进程 i18n（托盘、原生对话框、系统通知、看板娘主动消息、返回给界面的错误提示）。
 * 词典和稳定 key 由 @nomi-ai/i18n 统一管理；这里负责偏好持久化与广播。
 * 不依赖 Electron：系统语言经宿主端口（app.preferredLanguages / app.locale），广播经 AppEvents。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HostPorts } from '@nomi-ai/host-ports';
import {
  createTranslator,
  getDictionary,
  isLocalePref,
  resolveLocale,
  type LocalePref as CatalogLocalePref,
} from '@nomi-ai/i18n';

import type { AppEvents } from '../core/appEvents';
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

/** 界面监听的语言变化通道 */
export const LOCALE_CHANGED = 'ai:locale:changed';

export interface LocaleServiceDeps {
  /** 偏好文件（userData/locale.json） */
  file: string;
  /** 系统首选语言列表（app.preferredLanguages）；为空时退回系统界面语言（app.locale） */
  ports: Pick<HostPorts, 'app'>;
  events: AppEvents;
}

function systemLanguages(deps: LocaleServiceDeps): string[] {
  // 测试 / e2e 可用 CD_LOCALE 固定语言
  if (process.env.CD_LOCALE) return [process.env.CD_LOCALE];
  try {
    const l = deps.ports.app.preferredLanguages();
    if (l?.length) return [...l];
  } catch {
    /* ignore */
  }
  try {
    return [deps.ports.app.locale()];
  } catch {
    return [];
  }
}

export class LocaleService {
  private readonly file: string;

  constructor(private readonly deps: LocaleServiceDeps) {
    this.file = deps.file;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { locale?: unknown };
      if (isLocalePref(raw.locale)) pref = raw.locale;
    } catch {
      /* 首次运行：跟随系统 */
    }
    locale = resolveLocale(pref, systemLanguages(deps));
  }

  get(): { pref: LocalePref; locale: Locale } {
    return { pref, locale };
  }

  set(p: unknown): { pref: LocalePref; locale: Locale } {
    if (!isLocalePref(p)) throw new Error(`unknown locale: ${String(p)}`);
    pref = p;
    const next = resolveLocale(p, systemLanguages(this.deps));
    const changed = next !== locale;
    locale = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ locale: p }, null, 2), 'utf8');
    const s = this.get();
    this.deps.events.publish(LOCALE_CHANGED, s);
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
