/**
 * 本窗口唯一的应用契约客户端（docs/design/core-host-decoupling.md §4.1、§11.1、§12 P1b）。
 *
 * - `api`：`createAppClient()` 建在窗口共享的契约传输上（`window.nomiTransport`），与 AIProvider 里的
 *   `ClientAIClient` 共用一个会话；视图里只有这个文件建客户端，其余代码 `import { api } from '…/services/api'`；
 * - `hasTransport()`：preload 是否暴露了契约传输（浏览器预览 / 测试里为 false，调用方据此退回本地状态）；
 * - `installHostBackends()`：入口最先调用一次，把契约接到共享包（`@nomi-ai/ui`、`@nomi-ai/voice`）
 *   留的注入点上；每个域一个文件（`./hostBackends/<域>.ts`），域代理只改自己的那个。
 *
 * 本文件属于 P1b 基础，域代理不改。
 */

import { createAppClient, type AppClient } from '@nomi-ai/ai-sdk-client';
import { NOMI_TRANSPORT_GLOBAL } from '@nomi-ai/contract/app';

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
