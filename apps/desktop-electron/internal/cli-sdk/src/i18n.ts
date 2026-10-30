/**
 * 插件里面向用户的文案（§5.7）使用稳定的 project.module.message key。
 * 由宿主注入翻译函数；插件包不依赖 Electron，也不直接持有语言词典。
 * 未注入宿主翻译时按 key 返回并替换 {0}、{1} 占位，保证插件仍可独立运行。
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

/** 插件内的翻译：t('electron.cli.some-message', x) */
export function t(key: string, ...args: unknown[]): string {
  return current(key, ...args);
}
