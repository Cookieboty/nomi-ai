/**
 * preload 里认窗口：两个窗口共用同一个 preload 包（docs/design/core-host-decoupling.md §8），
 * 主进程建窗口时经 `webPreferences.additionalArguments` 传 `--nomi-window=<kind>`，preload 从
 * `process.argv` 读出来，只决定桌面角色窗口才接上 `nomiHost.dropFile` 的提交通道。
 *
 * 这只是 preload 侧的收窄：参数由主进程给，页面脚本改不了；主进程收到 `desktop:drop-file` 时仍按发送方
 * webContents 再校验一次是不是桌面角色窗口（host/nomiHostIpc.ts → DesktopService），两层互不依赖。
 */

export const NOMI_WINDOW_ARG_PREFIX = '--nomi-window=';

export type NomiWindowKind = 'mascot' | 'chat';

/** 主进程：生成要放进 additionalArguments 的参数 */
export function nomiWindowArg(kind: NomiWindowKind): string {
  return `${NOMI_WINDOW_ARG_PREFIX}${kind}`;
}

/** preload：从 argv 读窗口类型；没有或不认识时为 undefined（按对话窗口对待，拿不到 dropFile） */
export function nomiWindowKindFromArgv(
  argv: readonly string[] | undefined,
): NomiWindowKind | undefined {
  const arg = argv?.find((a) => typeof a === 'string' && a.startsWith(NOMI_WINDOW_ARG_PREFIX));
  const kind = arg?.slice(NOMI_WINDOW_ARG_PREFIX.length);
  return kind === 'mascot' || kind === 'chat' ? kind : undefined;
}
