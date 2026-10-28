/**
 * `@nomi-ai/contract/app` —— 应用契约（docs/design/core-host-decoupling.md §4、§12 P1）。
 *
 * 视图与内核之间的唯一来源。P1a：AI 门面（`ai.*`，原 `ai:<facade>:<method>` 与 `ai:event`）；
 * P1b：其余 `ai:*` 服务通道与 `window.electronAPI` 的能力，按域分在五个文件里（每个文件只属于一个域），
 * 这里汇总。按 §4.3 只增不删（minor）。
 *
 *   const api = createClient(appContract, transport);   // 视图
 *   implement(appContract, handlers);                     // 内核
 */

import { defineContract } from '../contract';

import { aiEvents, aiProcedures } from './ai';
import { codingErrors, codingEvents, codingEventSurfaces, codingProcedures } from './coding';
import { knowledgeErrors, knowledgeEvents, knowledgeProcedures } from './knowledge';
import { mascotErrors, mascotEvents, mascotEventSurfaces, mascotProcedures } from './mascot';
import { mediaErrors, mediaEvents, mediaEventSurfaces, mediaProcedures } from './media';
import { shellErrors, shellEvents, shellProcedures } from './shell';

/**
 * 各域共用的业务错误码（P1b 基础）：
 * - `UNAVAILABLE`：处理函数依赖的服务没有创建（启动失败 / 平台不支持），视图按「功能不可用」处理
 */
export const APP_ERRORS = ['UNAVAILABLE'] as const;

/** P1b 的五个域（D1..D5）：键是 `contract/src/app/<文件>.ts` 与 `host-electron/src/host/contract/<文件>.ts` 的文件名 */
export const APP_DOMAINS = Object.freeze({
  media: { key: 'D1', procedures: mediaProcedures, events: mediaEvents, errors: mediaErrors },
  shell: { key: 'D2', procedures: shellProcedures, events: shellEvents, errors: shellErrors },
  coding: { key: 'D3', procedures: codingProcedures, events: codingEvents, errors: codingErrors },
  knowledge: {
    key: 'D4',
    procedures: knowledgeProcedures,
    events: knowledgeEvents,
    errors: knowledgeErrors,
  },
  mascot: { key: 'D5', procedures: mascotProcedures, events: mascotEvents, errors: mascotErrors },
});

export type AppDomain = keyof typeof APP_DOMAINS;

/** 各部分的名字不得重复：对象展开会静默覆盖，所以在模块加载时检查 */
function assertDisjoint(what: string, parts: Record<string, Iterable<string>>): void {
  const owner = new Map<string, string>();
  for (const [part, names] of Object.entries(parts)) {
    for (const name of names) {
      const prev = owner.get(name);
      if (prev !== undefined) {
        throw new TypeError(
          `[contract/app] ${what} '${name}' is declared by both ${prev} and ${part}`,
        );
      }
      owner.set(name, part);
    }
  }
}

const parts = {
  ai: { procedures: aiProcedures, events: aiEvents, errors: APP_ERRORS },
  ...APP_DOMAINS,
};
assertDisjoint(
  'procedure',
  Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Object.keys(v.procedures)])),
);
assertDisjoint(
  'event',
  Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Object.keys(v.events)])),
);
assertDisjoint(
  'error code',
  Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.errors as readonly string[]])),
);

export const appContract = defineContract({
  version: { major: 2, minor: 1 },
  procedures: {
    ...aiProcedures,
    ...mediaProcedures,
    ...shellProcedures,
    ...codingProcedures,
    ...knowledgeProcedures,
    ...mascotProcedures,
  },
  events: {
    ...aiEvents,
    ...mediaEvents,
    ...shellEvents,
    ...codingEvents,
    ...knowledgeEvents,
    ...mascotEvents,
  },
  eventSurfaces: {
    ...mediaEventSurfaces,
    ...codingEventSurfaces,
    ...mascotEventSurfaces,
  },
  errors: [
    ...APP_ERRORS,
    ...mediaErrors,
    ...shellErrors,
    ...codingErrors,
    ...knowledgeErrors,
    ...mascotErrors,
  ],
});

export type AppContract = typeof appContract;

/** preload 暴露到视图全局的传输桥名（§5.2）；形状见 `IpcBridgeLike` */
export const NOMI_TRANSPORT_GLOBAL = 'nomiTransport';

/**
 * preload 暴露的宿主能力桥名：只放不能做成契约调用的能力（`pathForFile(file)`：拖入文件的本机路径，
 * 只能在 preload 里对真实 File 调用；`dropFile(file)`：看板娘窗口拖入文件，路径在 preload 里解析并提交，
 * 视图选不了路径）。视图只在 `services/api.ts` 里读它。
 */
export const NOMI_HOST_GLOBAL = 'nomiHost';

/**
 * 开发态（`pnpm dev:web`）由 Vite 开发服务器注入页面的全局：视图在普通浏览器里运行、没有 preload 桥时，
 * 用它经 WebSocket 连开发态内核（§5.2、§11.3）。只在开发服务器注入（`scripts/dev-web/vite-plugin.mjs`），
 * 构建产物里没有；视图只在 `services/api.ts` 里、`import.meta.env.DEV` 时读它。
 */
export const NOMI_DEV_TRANSPORT_GLOBAL = 'nomiDevTransport';

/** `window.nomiDevTransport` 的形状 */
export interface DevTransportConfig {
  /** `ws://127.0.0.1:<port>` */
  url: string;
  /** 开发态内核本次启动的随机 token */
  token: string;
}

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

export {
  codingEvents,
  codingEventSurfaces,
  codingProcedures,
  type CodingEventName,
  type CodingProcedureName,
} from './coding';
export {
  knowledgeEvents,
  knowledgeProcedures,
  type KnowledgeEventName,
  type KnowledgeProcedureName,
} from './knowledge';
export {
  mascotEvents,
  mascotEventSurfaces,
  mascotProcedures,
  type MascotEventName,
  type MascotProcedureName,
} from './mascot';
export {
  mediaEvents,
  mediaEventSurfaces,
  mediaProcedures,
  type MediaEventName,
  type MediaProcedureName,
} from './media';
export {
  shellEvents,
  shellProcedures,
  type ShellEventName,
  type ShellProcedureName,
} from './shell';
