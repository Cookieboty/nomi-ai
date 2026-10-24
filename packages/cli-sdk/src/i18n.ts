/**
 * 插件里面向用户的文案（§5.7）：中文原文作 key，由宿主注入翻译函数（主进程用自己的 t()，
 * 英文词典在 packages/electron/src/i18n/en.json）。没注入时按原文返回并替换 {0}、{1} 占位。
 * 插件包不依赖 Electron，所以不能直接 import 主进程的 i18n。
 */
export type Translate = (key: string, ...args: unknown[]) => string;

const format = (key: string, args: unknown[]): string =>
  key.replace(/\{(\d+)\}/g, (m, i: string) =>
    Number(i) < args.length ? String(args[Number(i)]) : m,
  );

const fallback: Translate = (key, ...args) => format(key, args);

let current: Translate = fallback;

/** 宿主启动时调用一次；传 null 恢复为原文 */
export function setTranslate(fn: Translate | null): void {
  current = fn ?? fallback;
}

/** 插件内的翻译：t('原文 {0}', x) */
export function t(key: string, ...args: unknown[]): string {
  return current(key, ...args);
}
