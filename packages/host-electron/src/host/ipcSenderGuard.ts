/**
 * 契约传输（`contract:request`）的 sender 白名单。
 *
 * 仅放行加载了受信内容的渲染窗口：
 * - 打包环境：`file://`（随包页面）；
 * - 开发环境：额外放行 renderer / chat 两个 127.0.0.1 dev server 端口。
 *
 * 若窗口被导航到任意外部站点（即使导航守卫被绕过），其 sender URL 不在白名单内，
 * 所有契约调用（LLM 对话、工具执行、provider 密钥写入等）一律拒绝。
 */

import type { IpcInvokeEvent } from '@nomi-ai/ai-runtime';
import type { CallerContext, Surface } from '@nomi-ai/contract';
import { app } from 'electron';

import { DEV_HOST, devChatUrl, devRendererUrl } from '../core/devPorts';

const devPorts = (): Set<string> =>
  new Set([new URL(devRendererUrl()).port, new URL(devChatUrl()).port]);

export function isTrustedSenderUrl(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol === 'file:') return true;

  if (
    !app.isPackaged &&
    process.env.NODE_ENV === 'development' &&
    url.protocol === 'http:' &&
    url.hostname === DEV_HOST &&
    devPorts().has(url.port)
  ) {
    return true;
  }

  return false;
}

/**
 * 受信页面属于哪个界面（docs/design/core-host-decoupling.md §8）：
 * 对话窗口（打包后 `…/ai-chat/index.html`，开发态 chat dev server）为 `chat`，其余为看板娘 `mascot`。
 * 只在 URL 已判定受信之后调用。
 */
export function aiSurfaceForUrl(raw: string): Surface {
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') {
      return /\/ai-chat\/[^/]*$/.test(decodeURIComponent(url.pathname)) ? 'chat' : 'mascot';
    }
    return url.port === new URL(devChatUrl()).port ? 'chat' : 'mascot';
  } catch {
    return 'mascot';
  }
}

/**
 * 契约传输的调用者判定（`createIpcServerTransport` 的 `resolveCaller`）：
 * 主 frame 与实际发起调用的 frame 都必须受信，否则返回 null（这个发送方的所有调用都被拒绝，
 * 与原 `ai:*` 通道的 sender 白名单一致）；受信来源按 URL 给出 surface，`trusted: true`。
 */
export function resolveAiCaller(event: IpcInvokeEvent): CallerContext | null {
  if (!isTrustedSenderUrl(event.senderUrl)) return null;
  if (event.senderFrameUrl && !isTrustedSenderUrl(event.senderFrameUrl)) return null;
  return { surface: aiSurfaceForUrl(event.senderUrl as string), trusted: true };
}
