/**
 * D5 视图测试的假宿主：`vi.mock('…/services/api', () => mascotApiModule())` 后，视图里的
 * `api.*` 走 `createTestClient(appContract, handlers)`（完整线协议、strict 序列化）。
 *
 * 状态挂在 globalThis 上：用 `vi.resetModules()` 的测试重新加载被测模块时，mock 工厂会重新执行，
 * 拿到的仍是同一个假宿主。
 */
import type { Handlers } from '@nomi-ai/contract';
import { appContract, type AppContract } from '@nomi-ai/contract/app';
import { createTestClient, type TestClient } from '@nomi-ai/contract/testing';

type Caller = { surface: 'chat' | 'mascot' | 'settings' | 'test'; trusted: boolean };

interface HostState {
  client: TestClient<AppContract> | null;
}

const KEY = '__nomiD5FakeHost';
const state = (): HostState => {
  const g = globalThis as unknown as Record<string, HostState | undefined>;
  return (g[KEY] ??= { client: null });
};

/** 装上假宿主：只实现测试关心的过程，其余以 NOT_FOUND 失败 */
export function installMascotHost(
  handlers: Partial<Handlers<AppContract>>,
  caller: Caller = { surface: 'mascot', trusted: true },
): TestClient<AppContract> {
  resetMascotHost();
  const client = createTestClient(appContract, handlers, { caller });
  state().client = client;
  return client;
}

/** 卸下假宿主：视图里 hasTransport() 回到 false */
export function resetMascotHost(): void {
  state().client?.close();
  state().client = null;
}

/** 推一个契约事件给视图的 `api.on` 订阅者，并等它送达 */
export async function publishMascotEvent(event: string, data: unknown): Promise<void> {
  const client = state().client;
  if (!client) throw new Error('fake host is not installed');
  // 订阅帧是异步送达的：先让出几轮微任务 / 宏任务
  await new Promise((r) => setTimeout(r, 0));
  (client.router.events.publish as (e: string, d: unknown) => void)(event, data);
  await new Promise((r) => setTimeout(r, 0));
}

/** `services/api` 的替身模块 */
export function mascotApiModule(): {
  api: unknown;
  hasTransport: () => boolean;
  hasWindowHost: () => boolean;
  isGoHost: () => boolean;
  hostAssetUrl: (url: string) => string;
} {
  const api = new Proxy(
    {},
    {
      get(_t, key) {
        const client = state().client;
        if (!client) throw new Error(`fake host is not installed (api.${String(key)})`);
        const value = (client.api as unknown as Record<PropertyKey, unknown>)[key];
        return typeof value === 'function' ? value.bind(client.api) : value;
      },
    },
  );
  // 测试里的假宿主就是看板娘窗口
  const installed = () => state().client !== null;
  // Electron 宿主：资源地址原样用
  return {
    api,
    hasTransport: installed,
    hasWindowHost: installed,
    isGoHost: () => false,
    hostAssetUrl: (url: string) => url,
  };
}

/** 角色包快照（`character.getActivePack` 的返回）：测试只写关心的字段，其余按内置包的空值补齐 */
export function packSnapshot(partial: Record<string, unknown>): {
  source: 'userData' | 'resources' | 'builtin';
  [k: string]: unknown;
} {
  return {
    source: 'builtin',
    id: null,
    mode: null,
    displayName: null,
    assetBaseUrl: null,
    onboarding: null,
    voiceBaseUrl: null,
    riveUrl: null,
    staticUrl: null,
    spriteManifestUrl: null,
    hitboxes: null,
    rive: null,
    locales: null,
    ...partial,
  } as { source: 'userData' | 'resources' | 'builtin'; [k: string]: unknown };
}
