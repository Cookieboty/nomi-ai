/**
 * `ai:*` 通道的统一注册入口：每次调用先校验 sender（同 AIRuntimeBoot 的白名单），
 * 并在全局通道表里认领通道名（重名直接抛错）。
 *
 * 取代各服务里手写的 `ipcMain.removeHandler(ch); ipcMain.handle(ch, ...)`，
 * 避免新增服务时漏掉 sender 校验。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

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
  /** handler 需要 IpcMainInvokeEvent（如定位发起窗口）时置 true：fn 的第一个参数是 event，其后才是渲染端参数 */
  passEvent?: boolean;
}

export function guardedHandle(
  channel: string,
  fn: (...args: unknown[]) => unknown,
  opts: GuardedHandleOptions & { passEvent?: false },
): void;
export function guardedHandle(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  opts: GuardedHandleOptions & { passEvent: true },
): void;
export function guardedHandle(
  channel: string,
  fn: (...args: never[]) => unknown,
  opts: GuardedHandleOptions,
): void {
  claimIpcChannel(channel, opts.owner);
  const wrap = opts.wrapErrors !== false;
  const call = (event: IpcMainInvokeEvent, args: unknown[]): unknown =>
    (fn as (...a: unknown[]) => unknown)(...(opts.passEvent ? [event, ...args] : args));
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    // 先校验 sender，再做任何业务；校验失败直接 reject，handler 不会被调用
    if (!isTrustedInvokeEvent(event)) throw new Error(`untrusted sender for ${channel}`);
    if (!wrap) return call(event, args);
    try {
      return await call(event, args);
    } catch (err) {
      return { __error: errorEnvelope(err) };
    }
  });
}

/** 业务错误码（如账号删除的 unknown-live）：只带形如 kebab-case 的短 code，界面据此走控制流而不是匹配文案（#137） */
const ERROR_CODE_RE = /^[a-z][a-z0-9-]{0,39}$/;

function errorEnvelope(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? { message, code } : { message };
}
