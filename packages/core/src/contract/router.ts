/**
 * 应用契约的组装（docs/design/core-host-decoupling.md §4、§7.1、§8、§12 P1b / P4）。
 *
 * - `createAppRouter`：AI 门面（ai-runtime 的 `createAiHandlers`）+ 内核的域处理函数（coding / knowledge /
 *   media / shell，以及 mascot 里不碰窗口的部分）+ 宿主片段（`hostHandlers`：要用窗口的过程，Electron 是
 *   看板娘窗口、灵动岛、旧窗口通道与应用图标）→ `implement(appContract, …)`。
 *   - 宿主片段只能**补**内核没有实现的过程，和内核重名时报错（不静默覆盖内核行为）；
 *   - 谁都没实现的过程以 UNAVAILABLE 失败（无界面宿主没有窗口片段；AI runtime 没起来时 `ai.*` 也是这样），
 *     其余过程照常可用；
 * - 调用者：surface 与 trusted 由传输层填写，契约里声明的 `surfaces` / `dangerous` 由内置守卫判定
 *   （不可关闭）；这里的中间件只记审计日志。
 */

import {
  ContractError,
  implement,
  type CallInfo,
  type Middleware,
  type Router,
} from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';

import { createCodingHandlers } from './coding';
import { createKnowledgeHandlers } from './knowledge';
import { createMascotCoreHandlers } from './mascot';
import { createMediaHandlers } from './media';
import type { VoiceStreams } from './media/voiceSenders';
import { createShellHandlers } from './shell';
import type { AppHandlers, ContractDeps, ContractLoggerLike } from './types';

/** `ai.*` 处理函数（ai-runtime 的 AiHandlersHandle 的结构子集） */
type AiHandlerTable = Pick<AppHandlers, keyof AppHandlers & `ai.${string}`>;

export interface AiContractPart {
  handlers: AiHandlerTable;
  bindEvents(publisher: Router<AppContract>['events']): () => void;
}

export interface CreateAppRouterOptions {
  deps: ContractDeps;
  /** AI runtime 的契约处理函数；没有（启动失败）时 `ai.*` 以 UNAVAILABLE 失败 */
  ai?: AiContractPart;
  /** 宿主片段：只补内核没有实现的过程（窗口、灵动岛、应用图标…） */
  hostHandlers?: Partial<AppHandlers>;
  middleware?: readonly Middleware[];
  /** 测试用：媒体域的流式识别会话表 */
  voiceStreams?: VoiceStreams;
}

export interface AppRouterHandle {
  router: Router<AppContract>;
  dispose(): void;
}

/** 没有实现的过程：以 UNAVAILABLE 失败（stream 在第一次 next() 时失败） */
function unavailableHandlers(): AppHandlers {
  const table: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    const fail = (): never => {
      throw new ContractError(
        'UNAVAILABLE',
        name.startsWith('ai.') ? 'AI runtime is not available' : `'${name}' is not available`,
      );
    };
    table[name] =
      (def as { kind: string }).kind === 'stream'
        ? // eslint-disable-next-line require-yield -- 第一次 next() 就失败
          async function* () {
            fail();
          }
        : fail;
  }
  return table as AppHandlers;
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

/** 内核实现的过程（不含 `ai.*`） */
export function createCoreHandlers(
  deps: ContractDeps,
  opts: { voiceStreams?: VoiceStreams } = {},
): Partial<AppHandlers> {
  return {
    ...createMediaHandlers(deps, opts.voiceStreams),
    ...createShellHandlers(deps),
    ...createCodingHandlers(deps),
    ...createKnowledgeHandlers(deps),
    ...createMascotCoreHandlers(deps),
  };
}

export function createAppRouter(opts: CreateAppRouterOptions): AppRouterHandle {
  const { deps } = opts;
  const core: Partial<AppHandlers> = {
    ...opts.ai?.handlers,
    ...createCoreHandlers(deps, { voiceStreams: opts.voiceStreams }),
  };
  for (const name of Object.keys(opts.hostHandlers ?? {})) {
    if (Object.prototype.hasOwnProperty.call(core, name)) {
      throw new TypeError(`[contract] host handler '${name}' would replace the core handler`);
    }
  }
  const handlers: AppHandlers = { ...unavailableHandlers(), ...core, ...opts.hostHandlers };
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
