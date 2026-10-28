/**
 * 渲染进程的语言状态与 React 适配器。
 * 词典由 @nomi-ai/i18n 统一管理；这里仅负责浏览器 / Electron 的语言状态同步。
 * 新文案使用 `project.module.message` key；运行时不接受中文原文作为 key。
 */
import {
  createTranslator,
  format as formatMessage,
  isLocalePref,
  resolveLocale,
  type LocalePref as CatalogLocalePref,
} from '@nomi-ai/i18n';
import {
  Fragment,
  createElement,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

export type Locale = 'zh-CN' | 'en';
export type LocalePref = CatalogLocalePref;
export { isLocalePref, resolveLocale };

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
export const format = formatMessage;

const translate = createTranslator(() => locale);

/** 翻译稳定 key；非字符串（ReactNode / undefined）原样返回，便于在渲染处直接包裹。 */
export function t(key: string, ...args: unknown[]): string;
export function t<T>(key: T): T;
export function t(key: unknown, ...args: unknown[]): unknown {
  return translate(key, ...args);
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

/**
 * 主进程语言服务的注入点（视图入口在 initLocale 之前接上，应用契约 `locale.*`；本包不依赖契约）。
 * 返回值形状同 `{ pref, locale }`；没有后端时只用本地状态。
 */
export interface LocaleBackend {
  get(): Promise<unknown>;
  set(pref: LocalePref): Promise<unknown>;
  /** 订阅语言变化；返回取消订阅 */
  onChanged(fn: (state: unknown) => void): () => void;
}

let backend: LocaleBackend | null = null;

/** 接上 / 拿掉主进程语言服务（null = 只用本地状态） */
export function setLocaleBackend(b: LocaleBackend | null): void {
  backend = b;
}
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
  const b = backend;
  if (!b) return () => undefined;
  void b
    .get()
    .then((v) => {
      const s = fromPayload(v);
      if (s) apply(s.pref, s.locale);
    })
    .catch(() => undefined);
  return b.onChanged((v) => {
    const s = fromPayload(v);
    if (s) apply(s.pref, s.locale);
  });
}

/** 用户在设置里切换语言 */
export async function setLocalePref(p: LocalePref): Promise<void> {
  applyLocale(p);
  const b = backend;
  if (!b) return;
  const s = fromPayload(await b.set(p).catch(() => null));
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
