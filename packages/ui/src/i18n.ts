/**
 * 轻量 i18n（仅 zh-CN / en）。
 * - 以中文原文作为 key（gettext 风格）：`t('开始新对话')`；zh-CN 原样返回，en 查 locales/en/*。
 * - 插值：`t('已检测 {0} 个', n)` / `t('你好 {name}', { name })`。
 * - 语言选择：跟随系统（zh* → zh-CN，其余 → en）/ 中文 / English；桌面端经主进程 `ai:locale:*`
 *   持久化与广播（托盘、原生对话框、通知同步），切换无需重启。
 */
import {
  Fragment,
  createElement,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import en from './locales/en';

export type Locale = 'zh-CN' | 'en';
export type LocalePref = Locale | 'system';

const DICTS: Record<Locale, Record<string, string>> = {
  'zh-CN': {},
  en: en as Record<string, string>,
};

export const resolveLocale = (
  pref: LocalePref,
  system: string | readonly string[] | undefined,
): Locale => {
  if (pref !== 'system') return pref;
  const first = Array.isArray(system) ? system[0] : system;
  return String(first ?? '')
    .toLowerCase()
    .startsWith('zh')
    ? 'zh-CN'
    : 'en';
};
export const isLocalePref = (v: unknown): v is LocalePref =>
  v === 'system' || v === 'zh-CN' || v === 'en';

let pref: LocalePref = 'system';
// 单元测试（Vitest）默认中文，断言沿用中文原文；需要英文时显式 applyLocale('en')
const IN_TEST = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VITEST,
);
const sysLangs = (): readonly string[] =>
  IN_TEST
    ? ['zh-CN']
    : typeof navigator !== 'undefined'
      ? navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
      : [];
let locale: Locale = resolveLocale('system', sysLangs());
const subs = new Set<() => void>();

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

/** 翻译：key 为中文原文；非字符串（ReactNode / undefined）原样返回，便于在渲染处直接包裹 */
export function t(key: string, ...args: unknown[]): string;
export function t<T>(key: T): T;
export function t(key: unknown, ...args: unknown[]): unknown {
  if (typeof key !== 'string') return key;
  if (locale === 'zh-CN') return format(key, args);
  // 插值参数若本身是词典里的文案（如常量里的标签），一并翻译
  const tx = args.map((a) => (typeof a === 'string' ? (DICTS.en[a] ?? a) : a));
  return format(DICTS.en[key] ?? key, tx);
}

export const getLocale = (): Locale => locale;
export const getLocalePref = (): LocalePref => pref;

function apply(p: LocalePref, l: Locale): void {
  pref = p;
  locale = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  try {
    localStorage.setItem('cd.locale', p);
  } catch {
    /* ignore */
  }
  subs.forEach((f) => f());
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('cd:locale-changed', { detail: { pref: p, locale: l } }));
}

/** 本地应用（无 IPC 时用浏览器语言解析「跟随系统」） */
export function applyLocale(p: LocalePref): void {
  apply(p, resolveLocale(p, sysLangs()));
}

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
  on(ch: string, fn: (p: unknown) => void): () => void;
}
const bridge = (): Bridge | undefined => {
  const b = (globalThis as { aiIPC?: Bridge }).aiIPC;
  return b && typeof b.invoke === 'function' ? b : undefined;
};
const fromPayload = (v: unknown): { pref: LocalePref; locale: Locale } | null => {
  const o = v as { pref?: unknown; locale?: unknown } | null;
  return o && isLocalePref(o.pref) && (o.locale === 'zh-CN' || o.locale === 'en')
    ? { pref: o.pref, locale: o.locale }
    : null;
};

/** 启动时调用一次 */
export function initLocale(): () => void {
  let cached: string | null = null;
  try {
    cached = localStorage.getItem('cd.locale');
  } catch {
    /* ignore */
  }
  applyLocale(isLocalePref(cached) ? cached : 'system');
  const b = bridge();
  if (!b) return () => undefined;
  // 主进程词典：主进程常量（模型目录 / 预设名称等）原样发给界面，在这里补充英文
  void b
    .invoke('ai:locale:dict')
    .then((d) => {
      if (d && typeof d === 'object') {
        DICTS.en = { ...(d as Record<string, string>), ...(en as Record<string, string>) };
        subs.forEach((f) => f());
      }
    })
    .catch(() => undefined);
  void b
    .invoke('ai:locale:get')
    .then((v) => {
      const s = fromPayload(v);
      if (s) apply(s.pref, s.locale);
    })
    .catch(() => undefined);
  return b.on('ai:locale:changed', (v) => {
    const s = fromPayload(v);
    if (s) apply(s.pref, s.locale);
  });
}

/** 用户在设置里切换语言 */
export async function setLocalePref(p: LocalePref): Promise<void> {
  applyLocale(p);
  const b = bridge();
  if (!b) return;
  const s = fromPayload(await b.invoke('ai:locale:set', p).catch(() => null));
  if (s) apply(s.pref, s.locale);
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** React：订阅语言变化（根组件调用一次即可让整棵树随语言重渲染） */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/**
 * 根组件包装：语言变化时用 render() 重新创建整棵树的元素，所有组件随之重渲染（不卸载、不丢状态）。
 * 用法：root.render(<LocaleRoot render={() => <App />} />)
 */
export function LocaleRoot({ render }: { render: () => ReactNode }): ReactElement {
  useLocale();
  return createElement(Fragment, null, render());
}
