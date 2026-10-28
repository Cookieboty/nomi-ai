/**
 * 视图测试用的 `services/api` 替身（D4 起用，任何域都能用）：契约里每个 query / mutation 都转给
 * `state.invoke(name, input)`，走完整线协议（strict 序列化、入参校验）。返回值与事件不校验
 * （测试只给关心的字段）。
 *
 *   const mock = vi.hoisted(() => ({ transport: true }) as ApiMockState);
 *   vi.mock('../src/services/api', async () =>
 *     (await import('./helpers/knowledgeApi')).createApiMock(mock),
 *   );
 *   mock.invoke = vi.fn(async (name) => (name === 'kb.state' ? state : true));
 *   mock.router.events.publish('kb.changed', null);   // 推事件
 */

import { createClient, implement, type Router } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createInProcessServer, withMissingHandlers } from '@nomi-ai/contract/testing';

export interface ApiMockState {
  /** 过程名（`kb.toggleSource`）+ 具名入参；没设置时调用失败 */
  invoke?: (name: string, input: unknown) => unknown;
  /** `hasTransport()` 的返回值 */
  transport: boolean;
  /** createApiMock 填写：推事件用 */
  router?: Router<AppContract>;
}

export function createApiMock(state: ApiMockState) {
  const handlers: Record<string, (input: unknown) => unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    if (def.kind === 'stream') continue;
    handlers[name] = (input) => {
      if (!state.invoke) throw new Error(`no test handler for '${name}'`);
      return state.invoke(name, input);
    };
  }
  const router = implement(appContract, withMissingHandlers(appContract, handlers as never), {
    validate: { output: false, events: false },
  });
  const server = createInProcessServer();
  server.serve(router as unknown as Router);
  const api = createClient(appContract, server.connect(), {
    handshake: 'off',
    validate: { output: false, events: false },
  });
  state.router = router;
  return {
    api,
    hasTransport: () => state.transport,
    installHostBackends: () => undefined,
  };
}
