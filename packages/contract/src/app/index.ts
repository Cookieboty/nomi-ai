/**
 * `@nomi-ai/contract/app` —— 应用契约（docs/design/core-host-decoupling.md §4、§12 P1）。
 *
 * 视图与内核之间的唯一来源。本批（P1a）只含 AI 门面（原 `window.aiIPC` 的 `ai:<facade>:<method>`
 * 通道与 `ai:event`）；`window.electronAPI` 的能力在下一批并入，按 §4.3 只增不删（minor）。
 *
 *   const api = createClient(appContract, transport);   // 视图
 *   implement(appContract, handlers);                     // 内核
 */

import { defineContract } from '../contract';

import { aiEvents, aiProcedures } from './ai';

export const appContract = defineContract({
  version: { major: 1, minor: 0 },
  procedures: { ...aiProcedures },
  events: { ...aiEvents },
});

export type AppContract = typeof appContract;

/** preload 暴露到视图全局的传输桥名（§5.2）；形状见 `IpcBridgeLike` */
export const NOMI_TRANSPORT_GLOBAL = 'nomiTransport';

export {
  AI_EVENTS,
  AI_METHODS,
  aiArgsToInput,
  aiEvents,
  aiProcedures,
  type AiClientEventName,
  type AiContractEvent,
  type AiFacadePath,
  type AiMethodSpec,
  type AiProcedureName,
} from './ai';

export * as aiSchemas from './schemas';
