import { createAiRouter, NoopRuntimeLogger, type AiRouterHandle } from '@nomi-ai/ai-runtime';
import { AIClient } from '@nomi-ai/ai-sdk';
import type { IPCBridge } from '@nomi-ai/ai-sdk-client';
import { LLMRegistryKey, ToolRegistryKey, UserProfileKey } from '@nomi-ai/bundle-ig-base';
import type { ToolDefinition, UserProfileService } from '@nomi-ai/bundle-ig-base';
import { createIpcServerTransport, type IpcServerTransport } from '@nomi-ai/contract';

import { createFakeSdkCtx, type FakeSdkCtx } from './fakeSdkCtx';
import {
  createFakeLLM,
  createFakeLLMRegistry,
  createFakeProfileService,
  createFakeToolRegistry,
  type FakeLLM,
} from './fakeSeams';
import { createFakeContractIpc, type FakeRendererWindow } from './rendererIpc';

export interface E2eRuntimeOptions {
  /** 传入一组预注册的 tool 定义（tools/post-execute 由 emit 手动触发） */
  tools?: ToolDefinition[];
  /** 是否把 AIClient 事件发布为契约事件；默认 true */
  broadcastEvents?: boolean;
  /** 允许 fake LLM id 自定义（默认 fake） */
  llmId?: string;
  /** 允许覆盖 UserProfileService（用于 E4 断言写读一致） */
  userProfileService?: UserProfileService;
}

export interface E2eRuntimeHandle {
  ctx: FakeSdkCtx;
  client: AIClient;
  /** 应用契约的 AI 实现（与主进程 AIRuntimeBoot 相同） */
  ai: AiRouterHandle;
  /** 契约的 IPC 传输（与主进程 host/contractIpc.ts 相同） */
  transport: IpcServerTransport;
  llm: FakeLLM;
  profileService: UserProfileService;
  /** 每个窗口对应一个渲染窗口 + 一个 `window.nomiTransport` 形状的 bridge */
  createRendererClient(opts?: { id?: number }): {
    webContents: FakeRendererWindow;
    bridge: IPCBridge;
    dispose(): void;
  };
  /** 等订阅 / 帧投递跑完（契约传输是异步的） */
  settle(ms?: number): Promise<void>;
  dispose(): void;
}

/**
 * `createE2eRuntime` —— 与真实主进程运行时结构等价的内存环境：
 * `AIClient + createAiRouter（appContract）+ createIpcServerTransport`，IPC 走内存版 ipcMain。
 * 每个"渲染窗口"通过 `createRendererClient()` 拿到一份 `bridge`，可用于
 * `new ClientAIClient({ bridge })`（与生产中 preload 暴露的 `window.nomiTransport` 同形）。
 */
export function createE2eRuntime(opts: E2eRuntimeOptions = {}): E2eRuntimeHandle {
  const ctx = createFakeSdkCtx();
  const llm = createFakeLLM(opts.llmId ?? 'fake');
  ctx.provide(LLMRegistryKey, createFakeLLMRegistry(llm));

  const toolRegistry = createFakeToolRegistry();
  for (const tool of opts.tools ?? []) toolRegistry.register(tool);
  ctx.provide(ToolRegistryKey, toolRegistry);

  const profileService = opts.userProfileService ?? createFakeProfileService();
  ctx.provide(UserProfileKey, profileService);
  // 让 profile.set 之后触发 插件事件，与 UserPreferenceMemoryPlugin 语义一致；
  // 用 triggerEvent 而不是 emit，才能让 AIClient.bindRuntimeBridges 里的 ctx.on 回调命中，
  // 从而把它映射为 `userProfile:changed` 业务事件，经契约事件推给订阅了的窗口。
  profileService.subscribe('changed', (profile) => {
    void ctx.triggerEvent('userProfile/changed', { profile });
  });

  const client = new AIClient(ctx);
  const ai = createAiRouter({
    client,
    logger: NoopRuntimeLogger,
    publishEvents: opts.broadcastEvents !== false,
  });
  const ipc = createFakeContractIpc();
  const transport = createIpcServerTransport(ipc.main, {
    // 宿主据 sender URL 判定；这里的窗口都是自家页面
    resolveCaller: () => ({ surface: 'test', trusted: true }),
    strictSerialize: true,
  });
  const stopServe = transport.serve(ai.router);

  const windows: FakeRendererWindow[] = [];
  let nextId = 100;

  return {
    ctx,
    client,
    ai,
    transport,
    llm,
    profileService,
    createRendererClient(childOpts) {
      // 窗口销毁时断开它的会话（宿主在 webContents destroyed 时做同样的事）
      const win = ipc.addWindow(childOpts?.id ?? nextId++, (id) => transport.disconnect(id));
      windows.push(win);
      return { webContents: win, bridge: win.bridge, dispose: () => win.destroy() };
    },
    settle: (ms = 5) => new Promise((r) => setTimeout(r, ms)),
    dispose() {
      for (const win of windows.splice(0)) win.destroy();
      stopServe();
      ai.dispose();
      void client.dispose();
      ctx.disposeAll();
    },
  };
}
