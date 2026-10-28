/**
 * 应用契约在 Electron 宿主上的组装（docs/design/core-host-decoupling.md §4、§8、§12 P1b）。
 *
 * - `createAppRouter`：AI 门面（ai-runtime 的 `createAiHandlers`）+ 五个域的处理函数（coding / knowledge
 *   与事件桥在内核 `@nomi-ai/core/contract/*`；media / shell / mascot 还要用窗口与 AI runtime，留在这里）→
 *   `implement(appContract, …)`；AI runtime 没起来时 `ai.*` 以 UNAVAILABLE 失败，其余域照常可用；
 * - `APP_EVENT_BRIDGE`：五个域的「旧通道 → 契约事件」表，交给 `createContractEventBridge`；
 * - 调用者：surface 与 trusted 由传输层填写（host/contractIpc.ts → resolveAiCaller），
 *   契约里声明的 `surfaces` / `dangerous` 由内置守卫判定（不可关闭）；这里的中间件只记审计日志。
 *
 * 本文件属于 P1b 基础；域代理只改自己的 `<域>.ts`。
 */

import {
  ContractError,
  implement,
  type CallInfo,
  type Middleware,
  type Router,
} from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { codingEventBridge, createCodingHandlers } from '@nomi-ai/core/contract/coding';
import { createKnowledgeHandlers, knowledgeEventBridge } from '@nomi-ai/core/contract/knowledge';

import { createMascotHandlers, mascotEventBridge } from './mascot';
import { createMediaHandlers, mediaEventBridge } from './media';
import { createShellHandlers, shellEventBridge } from './shell';
import type {
  AppHandlers,
  ContractDeps,
  ContractLoggerLike,
  EventBridgeEntry,
  EventBridgeMap,
} from './types';

/** `ai.*` 处理函数（ai-runtime 的 AiHandlersHandle 的结构子集；不在这里加载 ai-runtime） */
type AiHandlerTable = Pick<AppHandlers, keyof AppHandlers & `ai.${string}`>;

export interface AiContractPart {
  handlers: AiHandlerTable;
  bindEvents(publisher: Router<AppContract>['events']): () => void;
}

export interface CreateAppRouterOptions {
  deps: ContractDeps;
  /** AI runtime 的契约处理函数；没有（启动失败）时 `ai.*` 以 UNAVAILABLE 失败 */
  ai?: AiContractPart;
  middleware?: readonly Middleware[];
}

export interface AppRouterHandle {
  router: Router<AppContract>;
  dispose(): void;
}

function mergeBridges(parts: Record<string, EventBridgeMap<string>>): EventBridgeMap<string> {
  const out: Record<string, EventBridgeEntry<string>> = {};
  const owner = new Map<string, string>();
  for (const [part, map] of Object.entries(parts)) {
    for (const [channel, entry] of Object.entries(map)) {
      const prev = owner.get(channel);
      if (prev !== undefined) {
        throw new TypeError(
          `[contract] legacy channel '${channel}' is bridged by ${prev} and ${part}`,
        );
      }
      owner.set(channel, part);
      out[channel] = entry;
    }
  }
  return Object.freeze(out);
}

/** 五个域的事件桥合并表；同一旧通道只能由一个域桥接 */
export const APP_EVENT_BRIDGE: EventBridgeMap<string> = mergeBridges({
  media: mediaEventBridge,
  shell: shellEventBridge,
  coding: codingEventBridge,
  knowledge: knowledgeEventBridge,
  mascot: mascotEventBridge,
});

function unavailableAiHandlers(): AiHandlerTable {
  const table: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    if (!name.startsWith('ai.')) continue;
    const fail = (): never => {
      throw new ContractError('UNAVAILABLE', 'AI runtime is not available');
    };
    table[name] =
      (def as { kind: string }).kind === 'stream'
        ? // eslint-disable-next-line require-yield -- 第一次 next() 就失败
          async function* () {
            fail();
          }
        : fail;
  }
  return table as AiHandlerTable;
}

/** 审计：dangerous 过程的每次调用记一条（谁、从哪个界面）；不改变调用结果 */
export function auditMiddleware(logger: Pick<ContractLoggerLike, 'info'>): Middleware {
  return async (call: CallInfo, next) => {
    if (call.procedure.dangerous) {
      logger.info('contract dangerous call', {
        name: call.name,
        surface: call.caller.surface,
        caller: call.caller.id,
      });
    }
    return next();
  };
}

export function createAppRouter(opts: CreateAppRouterOptions): AppRouterHandle {
  const { deps } = opts;
  const handlers: AppHandlers = {
    ...(opts.ai?.handlers ?? unavailableAiHandlers()),
    ...createMediaHandlers(deps),
    ...createShellHandlers(deps),
    ...createCodingHandlers(deps),
    ...createKnowledgeHandlers(deps),
    ...createMascotHandlers(deps),
  };
  const router = implement(appContract, handlers, {
    middleware: [auditMiddleware(deps.logger), ...(opts.middleware ?? [])],
    logger: { warn: (message, data) => deps.logger.warn(message, data) },
  });
  const unbind = opts.ai?.bindEvents(router.events);
  return {
    router,
    dispose() {
      unbind?.();
    },
  };
}

export {
  createContractEventBridge,
  type ContractEventBridge,
} from '@nomi-ai/core/contract/eventBridge';
export { createContractServices, type ContractServices } from './services';
export * from './types';
