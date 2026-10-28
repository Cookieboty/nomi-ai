/**
 * 测试用内核：用应用契约实现一个假的 AI 门面（in-process 传输），
 * 让 ClientAIClient / hooks 走与生产一致的契约路径（握手、校验、序列化、订阅）。
 */

import { implement, type Handlers, type ProcedureDef, type Router } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createInProcessServer, type InProcessClient } from '@nomi-ai/contract/testing';

type AnyHandler = (input: unknown, ctx: { signal: AbortSignal }) => unknown;

export interface FakeServer {
  router: Router<AppContract>;
  /** 每次调用：过程名 + 入参 */
  calls: Array<{ name: string; input: unknown }>;
  connect(caller?: {
    surface: 'chat' | 'mascot' | 'settings' | 'test';
    trusted: boolean;
  }): InProcessClient;
  publish(event: keyof AppContract['events'], data: unknown): void;
  readonly sessionCount: number;
}

export function createFakeServer(overrides: Partial<Record<string, AnyHandler>> = {}): FakeServer {
  const calls: FakeServer['calls'] = [];
  const handlers: Record<string, AnyHandler> = {};
  for (const [name, def] of Object.entries(appContract.procedures) as Array<
    [string, ProcedureDef]
  >) {
    const impl: AnyHandler =
      overrides[name] ??
      (def.kind === 'stream'
        ? async function* () {}
        : () => {
            throw new Error(`[IPC_ERROR] ${name} is not stubbed`);
          });
    handlers[name] = (input, ctx) => {
      calls.push({ name, input });
      return impl(input, ctx);
    };
  }
  const router = implement(appContract, handlers as unknown as Handlers<AppContract>);
  const server = createInProcessServer();
  server.serve(router);
  return {
    router,
    calls,
    connect: (caller) => server.connect(caller),
    publish: (event, data) => router.events.publish(event, data as never),
    get sessionCount() {
      return server.sessionCount;
    },
  };
}

/** 一份合法的 UserProfile */
export function makeProfile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    identity: {},
    preferences: {},
    habits: {},
    dislikes: [],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

/** 让事件订阅 / 帧投递跑完（in-process 传输按微任务异步投递） */
export const flush = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
