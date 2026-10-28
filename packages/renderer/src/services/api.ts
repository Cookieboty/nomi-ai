/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上（`window.nomiTransport`），与 AIProvider 里的
 *   `ClientAIClient` 共用一个会话；视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - `hasTransport()`：preload 是否暴露了契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态）；
 * - `hostDropFile(file)`：拖到看板娘身上的文件交给内核（preload 的 `window.nomiHost` 解析路径并提交，
 *   视图选不了路径，所以不走契约）；
 * - `installHostBackends()`：入口最先调用一次，把契约接到共享包（`@nomi-ai/ui`、`@nomi-ai/voice`）
 *   留的注入点上；每个域一个文件（`./hostBackends/<域>.ts`），域代理只改自己的那个。
 *
 * 视图里只有本文件可以读 `window.nomiTransport` / `window.nomiHost`（eslint 拦下其余位置，见 §11.1）。
 */

import { createAppClient, type AppClient } from '@nomi-ai/ai-sdk-client';
import { NOMI_HOST_GLOBAL, NOMI_TRANSPORT_GLOBAL } from '@nomi-ai/contract/app';

import { installCodingBackends } from './hostBackends/coding';
import { installKnowledgeBackends } from './hostBackends/knowledge';
import { installMascotBackends } from './hostBackends/mascot';
import { installMediaBackends } from './hostBackends/media';
import { installShellBackends } from './hostBackends/shell';

export type { AppClient };

export const api: AppClient = createAppClient();

export function hasTransport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>)[NOMI_TRANSPORT_GLOBAL] === 'object'
  );
}

interface NomiHost {
  dropFile(file: File): boolean;
}

/**
 * 真实拖入的 File → 交给内核临时授权并总结；路径在 preload 里解析。浏览器预览 / 测试里没有桥，
 * 或文件不在本地（网页拖来的内容）时返回 false
 */
export function hostDropFile(file: File): boolean {
  if (typeof window === 'undefined') return false;
  const host = (window as unknown as Record<string, NomiHost | undefined>)[NOMI_HOST_GLOBAL];
  try {
    return host?.dropFile(file) ?? false;
  } catch {
    return false;
  }
}

let installed = false;

/** 入口（main.tsx / index.tsx）在 initTheme / initLocale 之前调用；重复调用无效 */
export function installHostBackends(): void {
  if (installed) return;
  installed = true;
  if (!hasTransport()) return;
  installMediaBackends(api);
  installShellBackends(api);
  installCodingBackends(api);
  installKnowledgeBackends(api);
  installMascotBackends(api);
}
