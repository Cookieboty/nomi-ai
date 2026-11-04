/**
 * 视图测试的假内核（契约层）：视图里的 `api.*` 走 `createTestClient(appContract, handlers)`
 * （in-process 传输、strict 序列化、入参 schema 校验），测试按**过程名 + 具名入参**给处理函数。
 *
 *   vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
 *
 *   const fake = installFakeApi({ 'harness.gitBranch': () => ({ branch: 'main' }) });
 *   // 或一个函数接住全部过程：installFakeApi((name, input) => (name === 'x.y' ? … : null))
 *   expect(fake.calls).toContainEqual(['harness.gitBranch', { cwd: '/w' }]);
 *   await fake.emit('harness.tabsChanged', tabs);   // 推契约事件给 api.on 的订阅者
 *
 * - 一个文件只建一个客户端（状态挂在 globalThis 上，`vi.resetModules()` 后仍是同一个）：视图在模块里
 *   订阅一次事件，换用例时只换处理函数，订阅不丢；
 * - 没 `installFakeApi` 或 `resetFakeApi()` 之后 `hasTransport()` 为 false，视图走本地退路；
 * - 返回值与事件不校验（测试只给关心的字段）；返回值形状由 contract 与宿主测试覆盖；
 * - 没给处理函数的过程以 NOT_FOUND 失败（与契约 `withMissingHandlers` 一致）；处理函数里抛
 *   `ContractError(code, msg)` 就是内核报错。
 */
import { ContractError } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createTestClient, type TestClient } from '@nomi-ai/contract/testing';
import { act } from '@testing-library/react';
import { vi } from 'vitest';

export type FakeHandler = (input: any) => unknown;
export type FakeHandlers = Record<string, FakeHandler>;
/** 一个函数接住全部过程：`(过程名, 入参)` */
export type FakeInvoke = (name: string, input: any) => unknown;

export type FakeCall = [name: string, input: unknown];

type Caller = { surface: 'chat' | 'mascot' | 'settings' | 'test'; trusted: boolean };

interface FakeState {
  client: TestClient<AppContract> | null;
  impl: FakeInvoke | null;
  calls: FakeCall[];
  caller: Caller;
  /** 还没返回的调用数（untilIdle 用） */
  inflight: number;
}

const KEY = '__nomiFakeAppApi';
const state = (): FakeState => {
  const g = globalThis as unknown as Record<string, FakeState | undefined>;
  return (g[KEY] ??= { client: null, impl: null, calls: [], caller: CHAT, inflight: 0 });
};

const CHAT: Caller = { surface: 'chat', trusted: true };

function client(): TestClient<AppContract> {
  const s = state();
  if (s.client) return s.client;
  const handlers: Record<string, (input: unknown) => unknown> = {};
  for (const [name, def] of Object.entries(appContract.procedures)) {
    if (def.kind === 'stream') continue;
    handlers[name] = (input) => {
      s.calls.push([name, input]);
      if (!s.impl) throw new ContractError('UNAVAILABLE', 'fake api is not installed');
      // 没有入参的过程只传过程名：断言写 `toHaveBeenCalledWith('usage.priceSync')`
      s.inflight++;
      let out: unknown;
      try {
        out = input === undefined ? (s.impl as (n: string) => unknown)(name) : s.impl(name, input);
      } catch (e) {
        s.inflight--;
        throw e;
      }
      if (out && typeof (out as Promise<unknown>).then === 'function')
        return (out as Promise<unknown>).finally(() => {
          s.inflight--;
        });
      s.inflight--;
      return out;
    };
  }
  s.client = createTestClient(appContract, handlers as never, {
    caller: s.caller,
    implement: { validate: { output: false, events: false } },
    clientValidate: { output: false, events: false },
  });
  return s.client;
}

export interface FakeApi {
  /** 每次调用的 `[过程名, 入参]`（含没给处理函数而失败的） */
  calls: FakeCall[];
  /** 某个过程的全部入参 */
  inputs(name: string): unknown[];
  /** 推一个契约事件，并等订阅者收到 */
  emit(event: string, data: unknown): Promise<void>;
  /** 只推不等（几个事件要在同一轮里先后到时用），之后 `await settle()` */
  publish(event: string, data: unknown): void;
  /** 让出一轮宏任务：已推出的事件 / 已发出的调用送达 */
  settle(): Promise<void>;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 装上假内核（替换上一个用例的处理函数，清空调用记录） */
export function installFakeApi(impl: FakeHandlers | FakeInvoke, caller: Caller = CHAT): FakeApi {
  const s = state();
  if (s.client && (caller.surface !== s.caller.surface || caller.trusted !== s.caller.trusted)) {
    s.client.close();
    s.client = null;
  }
  s.caller = caller;
  s.calls = [];
  s.impl =
    typeof impl === 'function'
      ? impl
      : (name, input) => {
          const fn = impl[name];
          if (!fn) throw new ContractError('NOT_FOUND', `no test handler for '${name}'`);
          return fn(input);
        };
  const c = client();
  return {
    get calls() {
      return state().calls;
    },
    inputs: (name) =>
      state()
        .calls.filter(([n]) => n === name)
        .map(([, i]) => i),
    async emit(event, data) {
      // 订阅帧是异步送达的：先让出一轮，推完再等订阅者收到
      await tick();
      (c.router.events.publish as (e: string, d: unknown) => void)(event, data);
      await tick();
    },
    publish(event, data) {
      (c.router.events.publish as (e: string, d: unknown) => void)(event, data);
    },
    settle: tick,
  };
}

/**
 * 等界面「做完手上的事」：假内核没有还没返回的调用、连续两轮没有发出新调用，React 也把更新提交完。
 * 按轮数判定，不按时间：机器再慢也只是多等几轮，不会因为超时翻车。用它代替
 * `await waitFor(() => …)` / `findBy*`，之后同步断言。轮数用完仍没停下说明界面在不停地发请求，直接报错。
 * 界面里有延时发请求（如本机历史 120ms 后才读）时，用例开 `vi.useFakeTimers()`：每一轮把已排上的定时器
 * 立即执行掉，不真的等时间。
 */
export async function untilIdle(maxRounds = 200): Promise<void> {
  const s = state();
  let quiet = 0;
  for (let i = 0; i < maxRounds; i++) {
    const before = s.calls.length;
    await act(async () => {
      if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
      else await tick();
    });
    quiet = s.inflight === 0 && s.calls.length === before ? quiet + 1 : 0;
    if (quiet >= 2) return;
  }
  throw new Error(`fake api never went idle after ${maxRounds} rounds (${s.inflight} in flight)`);
}

/** 卸下假内核：`hasTransport()` 回到 false，再调用以 UNAVAILABLE 失败 */
export function resetFakeApi(): void {
  const s = state();
  s.impl = null;
  s.calls = [];
  s.inflight = 0;
}

/** `services/api` 的替身模块 */
export function fakeApiModule(): {
  api: unknown;
  hasTransport: () => boolean;
  installHostBackends: () => void;
  hostPathForFile: (file: File) => string;
  hostAssetUrl: (url: string) => string;
  onHostOnlyFiles: (fn: unknown) => () => void;
  isGoHost: () => boolean;
} {
  const api = new Proxy(
    {},
    {
      get(_t, key) {
        const c = client();
        const value = (c.api as unknown as Record<PropertyKey, unknown>)[key];
        return typeof value === 'function' ? value.bind(c.api) : value;
      },
    },
  );
  return {
    api,
    hasTransport: () => state().impl !== null,
    installHostBackends: () => undefined,
    onHostOnlyFiles: () => () => undefined,
    isGoHost: () => false,
    hostPathForFile: () => '',
    hostAssetUrl: (url: string) => url,
  };
}
