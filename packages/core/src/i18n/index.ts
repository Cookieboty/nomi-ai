/**
 * 主进程 i18n（托盘、原生对话框、系统通知、看板娘主动消息、返回给界面的错误提示）。
 * 词典和稳定 key 由 @nomi-ai/i18n 统一管理；这里负责偏好持久化与广播。
 * 语言状态属于内核实例（LocaleService，经 core/scope.ts 的作用域查到），没有模块级的可变状态。
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
  spaceAround,
  type LocalePref as CatalogLocalePref,
} from '@nomi-ai/i18n';

import type { AppEvents } from '../core/appEvents';
import { currentCoreScope, type ScopedI18n } from '../core/scope';

export type Locale = 'zh-CN' | 'en';
export type LocalePref = CatalogLocalePref;
export { isLocalePref, resolveLocale };

/** 翻译函数：稳定 key（或原文）→ 当前语言的文案；非字符串原样返回 */
export interface Translate {
  (key: string, ...args: unknown[]): string;
  <T>(key: T): T;
}

/** 内核实例的界面语言（`core.i18n`）：宿主的托盘、原生对话框等按它翻译并跟随切换 */
export interface CoreI18n {
  readonly t: Translate;
  tName(key: string, name: string, ...rest: unknown[]): string;
  locale(): Locale;
  onChange(fn: (l: Locale) => void): () => void;
}

/** 不在任何内核作用域里（宿主进程自身、工具子进程、单测）时的不可变默认语言：CD_LOCALE，否则中文 */
function fallbackLocale(): Locale {
  return process.env.CD_LOCALE ? resolveLocale('system', [process.env.CD_LOCALE]) : 'zh-CN';
}
const fallbackTranslate = createTranslator(fallbackLocale);

/** 按当前内核实例的界面语言翻译（见 core/scope.ts）；不在内核里时用不可变默认语言 */
export function t(key: string, ...args: unknown[]): string;
export function t<T>(key: T): T;
export function t(key: unknown, ...args: unknown[]): unknown {
  const i18n = currentCoreScope()?.i18n;
  return i18n ? i18n.t(key, ...args) : fallbackTranslate(key, ...args);
}

/** 带角色名（`{0}`）的文案：中文里名字与汉字之间按排版补空格（见 `spaceAround`） */
export function tName(key: string, name: string, ...rest: unknown[]): string {
  return spaceAround(t(key, name, ...rest), name);
}

/** 当前内核实例的界面语言 */
export const getLocale = (): Locale => currentCoreScope()?.i18n?.locale() ?? fallbackLocale();

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

/**
 * 一个内核实例的界面语言：偏好、解析后的语言、变化监听与翻译函数都在实例上，
 * 同一进程里的多个内核互不影响。
 */
export class LocaleService implements ScopedI18n, CoreI18n {
  private readonly file: string;
  private pref: LocalePref = 'system';
  /** 第一次用到时才读偏好文件、解析系统语言（宿主可以在 app ready 之前就建好内核） */
  private resolved: Locale | undefined;
  private readonly listeners = new Set<(l: Locale) => void>();
  private readonly translate = createTranslator(() => this.locale());

  constructor(private readonly deps: LocaleServiceDeps) {
    this.file = deps.file;
  }

  private get current(): Locale {
    if (this.resolved === undefined) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { locale?: unknown };
        if (isLocalePref(raw.locale)) this.pref = raw.locale;
      } catch {
        /* 首次运行：跟随系统 */
      }
      this.resolved = resolveLocale(this.pref, systemLanguages(this.deps));
    }
    return this.resolved;
  }

  get(): { pref: LocalePref; locale: Locale } {
    const locale = this.current;
    return { pref: this.pref, locale };
  }

  locale(): Locale {
    return this.current;
  }

  /** 按本实例的语言翻译（箭头函数：可以单独传给宿主模块） */
  readonly t: Translate = ((key: unknown, ...args: unknown[]) =>
    this.translate(key, ...args)) as Translate;

  /** 带角色名（`{0}`）的文案（见 `tName`） */
  tName(key: string, name: string, ...rest: unknown[]): string {
    return spaceAround(this.t(key, name, ...rest), name);
  }

  /** 语言变化时回调（托盘菜单、人设等需要重建的地方） */
  onChange(fn: (l: Locale) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  set(p: unknown): { pref: LocalePref; locale: Locale } {
    if (!isLocalePref(p)) throw new Error(`unknown locale: ${String(p)}`);
    const prev = this.current;
    this.pref = p;
    const next = resolveLocale(p, systemLanguages(this.deps));
    const changed = next !== prev;
    this.resolved = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ locale: p }, null, 2), 'utf8');
    const s = this.get();
    this.deps.events.publish('locale.changed', s);
    if (changed) this.listeners.forEach((f) => f(next));
    return s;
  }

  /** 英文词典（稳定 key → 译文）：为诊断和插件接口保留的统一查询能力 */
  dict(): Record<string, string> {
    return getDictionary('en');
  }
}
