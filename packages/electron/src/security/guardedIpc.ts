/**
 * `ai:*` 通道的统一注册入口：每次调用先校验 sender（同 AIRuntimeBoot 的白名单），
 * 并在全局通道表里认领通道名（重名直接抛错）。
 *
 * 取代各服务里手写的 `ipcMain.removeHandler(ch); ipcMain.handle(ch, ...)`，
 * 避免新增服务时漏掉 sender 校验。
 */
import { ipcMain } from 'electron';

import { claimIpcChannel } from '../handlers/ipc/channelRegistry';

import { isTrustedSenderUrl } from './ipcSenderGuard';

interface InvokeEventLike {
  sender?: { getURL?: () => string } | null;
  senderFrame?: { url?: string } | null;
}

/**
 * 校验一次 `ipcMain.handle` 调用的来源：
 * 主 frame URL 必须受信；若事件带 senderFrame（可能是被嵌入的子 frame），其 URL 也必须受信。
 */
export function isTrustedInvokeEvent(event: unknown): boolean {
  const e = event as InvokeEventLike | null | undefined;
  if (!isTrustedSenderUrl(e?.sender?.getURL?.())) return false;
  const frameUrl = e?.senderFrame?.url;
  return !frameUrl || isTrustedSenderUrl(frameUrl);
}

export interface GuardedHandleOptions {
  /** 通道所有者（通常是服务类名），用于重名检测 */
  owner: string;
  /** 把 handler 抛出的错误转成 `{ __error: { message } }` 返回（渲染端各 client 约定的信封），默认开启 */
  wrapErrors?: boolean;
}

export function guardedHandle(
  channel: string,
  fn: (...args: unknown[]) => unknown,
  opts: GuardedHandleOptions,
): void {
  claimIpcChannel(channel, opts.owner);
  const wrap = opts.wrapErrors !== false;
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedInvokeEvent(event)) throw new Error(`untrusted sender for ${channel}`);
    if (!wrap) return fn(...args);
    try {
      return await fn(...args);
    } catch (err) {
      return { __error: { message: err instanceof Error ? err.message : String(err) } };
    }
  });
}
