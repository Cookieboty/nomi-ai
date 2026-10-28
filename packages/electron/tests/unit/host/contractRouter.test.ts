/**
 * P1b 基础（host/contract）：
 * - createAppRouter：AI runtime 没起来时 `ai.*` 以 UNAVAILABLE 失败；给了 AI 处理函数就用它，并接上事件；
 * - dangerous 过程走审计中间件，不可信调用者被内置守卫拒绝；
 * - 事件桥：旧通道照常广播，桥接表里的通道在 attach 之后同时发成契约事件，map 可以转换 payload；
 * - need()：服务缺失时 UNAVAILABLE。
 */

import { ContractError, createClient, type EventPublisher } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import {
  APP_EVENT_BRIDGE,
  createAppRouter,
  createContractEventBridge,
  createContractServices,
  need,
  type AiContractPart,
  type ContractDeps,
} from '../../../src/host/contract';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function deps(): ContractDeps {
  return {
    services: createContractServices(),
    ports: {} as HostPorts,
    events: createRecordingAppEvents(),
    logger,
  };
}

function connect(router: ReturnType<typeof createAppRouter>['router'], trusted = true) {
  const server = createInProcessServer();
  const stop = server.serve(router as never);
  const transport = server.connect({ surface: 'chat', trusted });
  const api = createClient(router.contract, transport, { handshake: 'off' });
  return {
    api,
    close: () => {
      transport.disconnect();
      stop();
    },
  };
}

describe('createAppRouter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('没有 AI runtime：ai.* 以 UNAVAILABLE 失败（其余域照常组装）', async () => {
    const app = createAppRouter({ deps: deps() });
    const { api, close } = connect(app.router);
    try {
      await expect(api.ai.sessions.list()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(api.ai.chat.stream({ messages: [] }).result).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    } finally {
      close();
      app.dispose();
    }
  });

  it('给了 AI 处理函数：调用委派给它，事件经 bindEvents 接上，dispose 时解绑', async () => {
    const unbind = jest.fn();
    let publisher: EventPublisher<AppContract> | undefined;
    const handlers = {} as Record<string, unknown>;
    const ai = { handlers, bindEvents: jest.fn() } as unknown as AiContractPart;
    // 先用桩填满 ai.*，再覆盖关心的
    const base = createAppRouter({ deps: deps() });
    for (const name of Object.keys(base.router.contract.procedures)) {
      if (name.startsWith('ai.')) handlers[name] = () => undefined;
    }
    handlers['ai.sessions.list'] = () => [];
    (ai.bindEvents as jest.Mock).mockImplementation((p: EventPublisher<AppContract>) => {
      publisher = p;
      return unbind;
    });
    const app = createAppRouter({ deps: deps(), ai });
    const { api, close } = connect(app.router);
    try {
      await expect(api.ai.sessions.list()).resolves.toEqual([]);
      expect(publisher).toBe(app.router.events);
    } finally {
      close();
      app.dispose();
    }
    expect(unbind).toHaveBeenCalledTimes(1);
  });

  it('dangerous 过程：受信调用者记审计日志，不可信调用者 FORBIDDEN', async () => {
    const handlers: Record<string, unknown> = {};
    const base = createAppRouter({ deps: deps() });
    for (const name of Object.keys(base.router.contract.procedures)) {
      if (name.startsWith('ai.')) handlers[name] = () => undefined;
    }
    const ai = { handlers, bindEvents: () => () => undefined } as unknown as AiContractPart;
    const app = createAppRouter({ deps: deps(), ai });

    const trusted = connect(app.router, true);
    await trusted.api.ai.tools.confirm({ reqId: 'r1', ok: true });
    expect(logger.info).toHaveBeenCalledWith(
      'contract dangerous call',
      expect.objectContaining({ name: 'ai.tools.confirm', surface: 'chat' }),
    );
    trusted.close();

    const untrusted = connect(app.router, false);
    await expect(untrusted.api.ai.tools.confirm({ reqId: 'r2', ok: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    untrusted.close();
  });
});

describe('createContractEventBridge', () => {
  it('attach 之后桥接表里的通道发成契约事件；tap 收到每次发布；表外通道只警告一次', () => {
    const inner = createRecordingAppEvents();
    const warn = jest.fn();
    const bridge = createContractEventBridge(
      inner,
      {
        'x:changed': 'x.changed',
        'x:mapped': { event: 'x.mapped', map: (p) => ({ wrapped: p }) },
      },
      { warn },
    );
    const sink = { publish: jest.fn() };

    bridge.publish('x:changed', 1, { surface: 'chat' });
    expect(sink.publish).not.toHaveBeenCalled();

    const detach = bridge.attach(sink);
    bridge.publish('x:changed', 2);
    bridge.publish('x:mapped', 3);
    bridge.publish('x:other', 4);
    bridge.publish('x:other', 4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { channel: 'x:other' });
    expect(inner.published.map((e) => [e.channel, e.payload, e.surfaces])).toEqual([
      ['x:changed', 1, ['chat']],
      ['x:changed', 2, null],
      ['x:mapped', 3, null],
      ['x:other', 4, null],
      ['x:other', 4, null],
    ]);
    expect(sink.publish.mock.calls).toEqual([
      ['x.changed', 2],
      ['x.mapped', { wrapped: 3 }],
    ]);
    expect(bridge.contractEventOf('x:mapped')).toBe('x.mapped');
    expect(bridge.contractEventOf('toString')).toBeUndefined();

    detach();
    bridge.publish('x:changed', 5);
    expect(sink.publish).toHaveBeenCalledTimes(2);
  });

  it('契约事件发布失败只记 warn，不影响发布方', () => {
    const inner = createRecordingAppEvents();
    const warn = jest.fn();
    const bridge = createContractEventBridge(inner, { 'x:changed': 'x.changed' }, { warn });
    bridge.attach({
      publish: () => {
        throw new ContractError('BAD_OUTPUT', 'Invalid event');
      },
    });
    expect(() => bridge.publish('x:changed', 1)).not.toThrow();
    expect(inner.last('x:changed')).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '契约事件发布失败',
      expect.objectContaining({ channel: 'x:changed', event: 'x.changed' }),
    );
  });

  it('APP_EVENT_BRIDGE 的每个目标都是契约里声明的事件', () => {
    const app = createAppRouter({ deps: deps() });
    for (const entry of Object.values(APP_EVENT_BRIDGE)) {
      const event = typeof entry === 'string' ? entry : entry.event;
      expect(app.router.events.has(event)).toBe(true);
    }
  });
});

describe('need', () => {
  it('服务缺失时以 UNAVAILABLE 失败', () => {
    expect(need(1, 'x')).toBe(1);
    expect(() => need(undefined, 'theme')).toThrow(
      expect.objectContaining({ code: 'UNAVAILABLE' }),
    );
  });
});
