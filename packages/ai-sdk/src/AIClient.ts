/**
 * AIClient —— 面向三大消费方（renderer / main / CLI）的稳定 API 门面。
 *
 * 设计不变量（对齐 P5 计划 §P5-3）：
 * - `new AIClient(ctx, { logger?, config? })` 构造即完成 7 Facade 装配；
 * - Facade 内部只做**薄封装 + DTO 映射**，绝不实现业务逻辑；
 * - 对外唯一事件入口是 `AIClient.on(evt, fn)`；桥接由本类完成，插件事件对外不可见；
 * - `AvatarFacade` 通过 `isAvailable()` 探测；未注入时任何具体调用
 *   都会抛 `SEAM_NOT_INJECTED`。
 */

import type { AppConfig } from './config/AppConfig';
import { NoopLogger, type ILogger } from './di/ILogger';
import type { SdkContext } from './di/SdkContext';
import { AIClientError, ErrorCodes } from './errors';
import { createAsrFacade, type AsrFacade } from './facade/AsrFacade';
import { createAvatarFacade, type AvatarFacade } from './facade/AvatarFacade';
import { createChatFacade, type ChatFacade } from './facade/ChatFacade';
import { createMemoryFacade, type MemoryFacade } from './facade/MemoryFacade';
import { createSessionFacade, type SessionFacade } from './facade/SessionFacade';
import { createToolsFacade, type ToolsFacade } from './facade/ToolsFacade';
import { createTtsFacade, type TtsFacade } from './facade/TtsFacade';
import type { AIClientEvent, AIClientEventMap, AIClientEventPayload } from './types/events';

export interface AIClientOptions {
  logger?: ILogger;
  /** 已经通过 loadAppConfig 校验的业务配置；未传则视为空配置 */
  config?: AppConfig;
}

export class AIClient {
  readonly chat: ChatFacade;
  readonly sessions: SessionFacade;
  readonly tools: ToolsFacade;
  readonly memory: MemoryFacade;
  readonly asr: AsrFacade;
  readonly tts: TtsFacade;
  readonly avatar: AvatarFacade;

  private readonly logger: ILogger;
  private readonly listeners = new Map<AIClientEvent, Set<(payload: never) => void>>();
  private readonly bridgeDisposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly ctx: SdkContext,
    opts: AIClientOptions = {},
  ) {
    this.logger = opts.logger ?? NoopLogger;

    this.chat = createChatFacade(ctx);
    this.sessions = createSessionFacade();
    this.tools = createToolsFacade(ctx);
    this.memory = createMemoryFacade(ctx);
    this.asr = createAsrFacade(ctx);
    this.tts = createTtsFacade(ctx);
    this.avatar = createAvatarFacade(ctx);

    this.bindRuntimeBridges();
    this.logger.info('AIClient ready', { config: opts.config });
  }

  /** 订阅业务事件；返回反订阅函数 */
  on<E extends AIClientEvent>(evt: E, fn: (payload: AIClientEventPayload<E>) => void): () => void {
    this.assertLive();
    let bucket = this.listeners.get(evt);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(evt, bucket);
    }
    const wrapped = fn as unknown as (payload: never) => void;
    bucket.add(wrapped);
    return () => {
      bucket?.delete(wrapped);
    };
  }

  /** 内部：把 插件事件桥接为 AIClientEvent，仅在构造期挂钩 */
  private bindRuntimeBridges(): void {
    const push = <E extends AIClientEvent>(evt: E, payload: AIClientEventMap[E]) => {
      const bucket = this.listeners.get(evt);
      if (!bucket) return;
      for (const fn of bucket) {
        try {
          (fn as (p: AIClientEventMap[E]) => void)(payload);
        } catch (err) {
          this.logger.error(`AIClient listener for '${evt}' threw`, err);
        }
      }
    };

    const bridges: Array<{
      event: Parameters<SdkContext['on']>[0];
      map: (
        payload: unknown,
      ) => { evt: AIClientEvent; data: AIClientEventMap[AIClientEvent] } | undefined;
    }> = [
      {
        event: 'session/assistant-message',
        map: (p) => {
          const payload = p as AIClientEventMap['message:complete'];
          return payload?.message ? { evt: 'message:complete', data: payload } : undefined;
        },
      },
      {
        event: 'agent/turn-end',
        map: (p) => {
          const payload = p as {
            sessionId: string;
            turnId: string;
            ok: boolean;
            reason?: string;
          };
          return {
            evt: 'agent:turn-end',
            data: payload,
          };
        },
      },
      {
        event: 'agent/stopped-by-user',
        map: (p) => {
          const payload = p as { sessionId: string; reqId: string };
          return { evt: 'agent:stopped-by-user', data: payload };
        },
      },
      {
        event: 'tool/confirm-required',
        map: (p) => {
          const payload = p as AIClientEventMap['tool:confirm-required'];
          return { evt: 'tool:confirm-required', data: payload };
        },
      },
      {
        event: 'tools/post-execute',
        map: (p) => {
          const payload = p as AIClientEventMap['tool:executed'];
          return { evt: 'tool:executed', data: payload };
        },
      },
      {
        event: 'tts/chunk',
        map: (p) => {
          const payload = p as AIClientEventMap['tts:chunk'];
          return { evt: 'tts:chunk', data: payload };
        },
      },
      {
        event: 'tts/end',
        map: (p) => {
          const payload = p as AIClientEventMap['tts:end'];
          return { evt: 'tts:end', data: payload };
        },
      },
      {
        event: 'userProfile/changed',
        map: (p) => {
          const payload = p as AIClientEventMap['userProfile:changed'];
          return { evt: 'userProfile:changed', data: payload };
        },
      },
    ];

    for (const { event, map } of bridges) {
      const off = this.ctx.on(event, (hookCtx: { payload: unknown }) => {
        const mapped = map(hookCtx.payload);
        if (mapped) push(mapped.evt, mapped.data);
      });
      this.bridgeDisposers.push(off);
    }

    if (this.avatar.isAvailable()) {
      this.bridgeDisposers.push(this.avatar.on('touch', (t) => push('avatar:touch', t)));
      this.bridgeDisposers.push(this.avatar.on('motion:end', (m) => push('avatar:motion-end', m)));
    }
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new AIClientError(ErrorCodes.DISPOSED, 'AIClient 已 dispose');
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.bridgeDisposers.splice(0)) {
      try {
        off();
      } catch (err) {
        this.logger.warn('AIClient bridge disposer threw', err);
      }
    }
    this.listeners.clear();
  }
}
