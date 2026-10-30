/**
 * 契约组装（contract/router.ts）：
 * - createAppRouter：AI runtime 没起来时 `ai.*` 以 UNAVAILABLE 失败；给了 AI 处理函数就用它，并接上事件；
 * - 宿主片段只补内核没有的过程，和内核重名时报错；谁都没实现的过程 UNAVAILABLE；
 * - dangerous 过程走审计中间件，不可信调用者被内置守卫拒绝；
 * - 事件总线：服务直接发布契约事件，attach 之后交给 router 的 events；tap 收到每次发布；
 * - need()：服务缺失时 UNAVAILABLE。
 */

import { canSubscribe, ContractError, createClient, type EventPublisher } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createInProcessServer } from '@nomi-ai/contract/testing';
import type { HostPorts } from '@nomi-ai/host-ports';

import { createContractEventBus } from '../../../src/contract/eventBus';
import { createAppRouter, type AiContractPart } from '../../../src/contract/router';
import { need, type ContractDeps } from '../../../src/contract/types';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function deps(): ContractDeps {
  return {
    services: {},
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

  it('宿主片段：补上内核没有的过程；和内核重名时报错；都没有的 UNAVAILABLE', async () => {
    const app = createAppRouter({
      deps: deps(),
      hostHandlers: { 'appIcon.set': () => 'ink' as const },
    });
    const { api, close } = connect(app.router);
    try {
      await expect(api.appIcon.set({ variant: 'ink' })).resolves.toBe('ink');
      await expect(api.appIcon.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await expect(api.mascot.scaleGet()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      close();
    }
    expect(() =>
      createAppRouter({ deps: deps(), hostHandlers: { 'theme.get': () => ({}) as never } }),
    ).toThrow(/theme\.get/);
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

describe('createContractEventBus', () => {
  it('attach 之后事件交给契约 sink；tap 收到每次发布；detach 后不再交给 sink', () => {
    const inner = createRecordingAppEvents();
    const bus = createContractEventBus(inner, { warn: jest.fn() });
    const sink = { publish: jest.fn() };

    bus.publish('theme.changed', 1, { surface: 'chat' });
    expect(sink.publish).not.toHaveBeenCalled();

    const detach = bus.attach(sink);
    bus.publish('theme.changed', 2);
    bus.publish('window.mouseEnter', null);
    expect(inner.published.map((e) => [e.event, e.payload, e.surfaces])).toEqual([
      ['theme.changed', 1, ['chat']],
      ['theme.changed', 2, null],
      ['window.mouseEnter', null, null],
    ]);
    expect(sink.publish.mock.calls).toEqual([
      ['theme.changed', 2],
      ['window.mouseEnter', null],
    ]);

    detach();
    bus.publish('theme.changed', 5);
    expect(sink.publish).toHaveBeenCalledTimes(2);
  });

  it('契约事件发布失败（schema 不符）只记 warn，不影响发布方', () => {
    const inner = createRecordingAppEvents();
    const warn = jest.fn();
    const bus = createContractEventBus(inner, { warn });
    bus.attach({
      publish: () => {
        throw new ContractError('BAD_OUTPUT', 'Invalid event');
      },
    });
    expect(() => bus.publish('theme.changed', 1)).not.toThrow();
    expect(inner.last('theme.changed')).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '契约事件发布失败',
      expect.objectContaining({ event: 'theme.changed' }),
    );
  });

  it('接在真实 router 上：payload 按契约 schema 校验，订阅者收到校验后的数据', () => {
    const app = createAppRouter({ deps: deps() });
    const warn = jest.fn();
    const bus = createContractEventBus(null, { warn });
    bus.attach(app.router.events);
    const seen: unknown[] = [];
    const off = app.router.events.subscribe('window.mouseLeave', (d) => seen.push(d));
    bus.publish('window.mouseLeave', null);
    bus.publish('window.mouseLeave', { not: 'null' });
    expect(seen).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);
    off();
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

describe('按窗口投递（契约 eventSurfaces，§8）', () => {
  const scoped: Array<[string, 'mascot' | 'chat']> = [
    ['desktop.bubble', 'mascot'],
    ['mascot.cursor', 'mascot'],
    ['desktop.summary', 'chat'],
    ['nav.desktopPanelRequested', 'chat'],
    ['nav.scheduleRequested', 'chat'],
    ['nav.voiceSettingsRequested', 'chat'],
    ['harness.events', 'chat'],
    ['harness.tabMessage', 'chat'],
  ];

  it.each(scoped)('%s 只有 %s 窗口能订阅', (event, only) => {
    const other = only === 'mascot' ? 'chat' : 'mascot';
    expect(canSubscribe(appContract, event, only)).toBe(true);
    expect(canSubscribe(appContract, event, other)).toBe(false);
  });

  // 对话窗口开着时确认请求只发给它（授权卡片），否则发给桌面角色：两边都能订阅，设置窗口不行
  it.each(['desktop.confirmRequest', 'desktop.confirmCancel'])(
    '%s 桌面角色与对话窗口能订阅',
    (event) => {
      expect(canSubscribe(appContract, event, 'mascot')).toBe(true);
      expect(canSubscribe(appContract, event, 'chat')).toBe(true);
      expect(canSubscribe(appContract, event, 'settings')).toBe(false);
    },
  );
});
