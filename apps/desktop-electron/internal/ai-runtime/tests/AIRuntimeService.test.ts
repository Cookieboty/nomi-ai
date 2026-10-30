/**
 * AIRuntimeService & runtime 单例的生命周期测试。
 *
 * - `start(profile)` → 返回 AIClient，`isStarted=true`，logger 打印 `AI runtime booted (profile)`；
 * - `stop()` 后 booter.dispose 被调用、before-quit off 被调用；
 * - 重复 start 抛 `RuntimeAlreadyStartedError`；
 * - `runtime.configure` 在运行时状态下抛错。
 */

import type { PluginContext } from '@nomi-ai/bundle-ig-base';
import { LLMRegistryKey, ToolRegistryKey, UserProfileKey } from '@nomi-ai/bundle-ig-base';
import { describe, it, expect, vi } from 'vitest';

import {
  AIRuntimeService,
  RuntimeAlreadyStartedError,
  RuntimeNotStartedError,
  type AppLifecycle,
  type Booter,
} from '../src/AIRuntimeService';
import { runtime } from '../src/index';

import { createFakeSdkCtx } from './helpers/fakeSdkCtx';
import {
  createFakeLLM,
  createFakeLLMRegistry,
  createFakeProfileService,
  createFakeToolRegistry,
} from './helpers/fakeSeams';

function seededCtx() {
  const ctx = createFakeSdkCtx();
  ctx.provide(LLMRegistryKey, createFakeLLMRegistry(createFakeLLM()));
  ctx.provide(ToolRegistryKey, createFakeToolRegistry());
  ctx.provide(UserProfileKey, createFakeProfileService());
  return ctx;
}

function fakeBooter(): { booter: Booter; dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn();
  const booter: Booter = {
    async boot() {
      // toSdkContext 只调用 inject/on/emit，直接把 fake ctx 转成 PluginContext 即可
      return seededCtx() as unknown as PluginContext;
    },
    dispose,
  };
  return { booter, dispose };
}

function fakeLifecycle(): { lifecycle: AppLifecycle; off: ReturnType<typeof vi.fn> } {
  const off = vi.fn();
  const lifecycle: AppLifecycle = {
    onBeforeQuit: vi.fn(() => off),
  };
  return { lifecycle, off };
}

describe('AIRuntimeService', () => {
  it('start() returns AIClient and marks isStarted', async () => {
    const { booter } = fakeBooter();
    const svc = new AIRuntimeService({ booter });
    const client = await svc.start('companion', { home: '/tmp' });
    expect(client).toBeDefined();
    expect(svc.isStarted).toBe(true);
    expect(svc.profile).toBe('companion');
  });

  it('start() logs "AI runtime booted (<profile>)"', async () => {
    const { booter } = fakeBooter();
    const info = vi.fn();
    const svc = new AIRuntimeService({
      booter,
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });
    await svc.start('chat-only', { home: '/tmp' });
    const bootedLog = info.mock.calls.find(([msg]) =>
      String(msg).includes('AI runtime booted (chat-only)'),
    );
    expect(bootedLog).toBeTruthy();
  });

  it('stop() invokes booter.dispose + lifecycle off', async () => {
    const { booter, dispose } = fakeBooter();
    const { lifecycle, off } = fakeLifecycle();
    const svc = new AIRuntimeService({ booter, lifecycle });
    await svc.start('companion', { home: '/tmp' });
    await svc.stop();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    expect(svc.isStarted).toBe(false);
  });

  it('accessing client before start throws RuntimeNotStartedError', () => {
    const { booter } = fakeBooter();
    const svc = new AIRuntimeService({ booter });
    expect(() => svc.client).toThrow(RuntimeNotStartedError);
  });

  it('double start throws RuntimeAlreadyStartedError', async () => {
    const { booter } = fakeBooter();
    const svc = new AIRuntimeService({ booter });
    await svc.start('companion', { home: '/tmp' });
    await expect(svc.start('companion', { home: '/tmp' })).rejects.toBeInstanceOf(
      RuntimeAlreadyStartedError,
    );
    await svc.stop();
  });
});

describe('runtime singleton', () => {
  it('configure → start → stop full cycle', async () => {
    const { booter } = fakeBooter();
    const svc = runtime.configure({ booter });
    await svc.start('companion', { home: '/tmp' });
    expect(runtime.client).toBeDefined();
    await runtime.stop();
  });

  it('configure while started throws', async () => {
    const { booter } = fakeBooter();
    const svc = runtime.configure({ booter });
    await svc.start('companion', { home: '/tmp' });
    expect(() => runtime.configure({ booter })).toThrow(/already started/);
    await runtime.stop();
  });
});
