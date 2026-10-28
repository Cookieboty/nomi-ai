/**
 * 无界面 e2e 的运行环境（docs/design/core-host-decoupling.md §11.3）：真实内核（`createCore`）跑在
 * `@nomi-ai/host-node` 的无界面宿主上，视图侧的 `ClientAIClient` 经 in-process 传输连进来——
 * 不启动 Electron、不需要显示环境。
 *
 * 和真实应用的唯一差别是插件宿主里多一个探针插件（宿主钩子 `aiPluginsAfter`，装在内置插件之后）：
 * - 换上假的 LLM（`LLMRegistryKey` 后 provide 的覆盖内置的，对话走 FakeLLM，结果确定、不联网）；
 * - 往真实的工具表里加测试工具、装假的危险工具防线；
 * - 拿到插件上下文，用 `emit()` 发插件事件（TTS 分片、回合结束、工具执行…），由真实 AIClient 桥接成契约事件。
 */

import { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import {
  definePlugin,
  LLMRegistryKey,
  ToolRegistryKey,
  UserProfileKey,
  type PluginContext,
  type PluginEvent,
  type ToolDefinition,
  type UserProfileService,
} from '@nomi-ai/bundle-ig-base';
import type { CallerContext, Client } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import type { InProcessClient } from '@nomi-ai/contract/testing';
import { startHeadlessCore, type HeadlessCore } from '@nomi-ai/host-node/core';

import {
  createFakeLLM,
  createFakeLLMRegistry,
  installDangerToolGuardrail,
  type FakeLLM,
  type ToolDenial,
} from './fakeSeams';

export interface E2eCoreOptions {
  /** 额外注册到真实工具表的工具 */
  tools?: ToolDefinition[];
  /** 假 LLM 的 provider id（默认 fake） */
  llmId?: string;
  /** 交给假的危险工具防线的工具名 */
  dangerTools?: string[];
}

export interface E2eWindow {
  /** 视图侧的 AI 客户端（与 ai-chat / renderer 的 AIProvider 同一个类） */
  client: ClientAIClient;
  /** 同一连接上的应用契约客户端 */
  api: Client<AppContract>;
  transport: InProcessClient;
  /** 关窗口：断开连接 */
  close(): Promise<void>;
}

export interface E2eCore {
  headless: HeadlessCore;
  llm: FakeLLM;
  /** 探针插件的上下文（与内置插件共用一个服务表） */
  plugin: PluginContext;
  /** 内核里真实的用户画像服务 */
  profile(): UserProfileService;
  /** 假防线的拒绝记录 */
  denials: ToolDenial[];
  /** 发一个插件事件并等它派发、帧送达 */
  emit(evt: PluginEvent, payload: unknown): Promise<void>;
  /** 开一个窗口（一个契约连接）；默认对话窗口身份 */
  openWindow(caller?: CallerContext): E2eWindow;
  /** 等订阅 / 帧投递跑完（契约传输与插件事件都是异步的） */
  settle(ms?: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startE2eCore(opts: E2eCoreOptions = {}): Promise<E2eCore> {
  const llm = createFakeLLM(opts.llmId ?? 'fake');
  let plugin: PluginContext | undefined;
  let denials: ToolDenial[] = [];

  const probe = definePlugin({
    name: 'E2eProbePlugin',
    apply(ctx) {
      plugin = ctx;
      ctx.provide(LLMRegistryKey, createFakeLLMRegistry(llm));
      const tools = ctx.inject(ToolRegistryKey);
      if (!tools) throw new Error('[e2e] ToolRegistry is not provided by the core');
      for (const tool of opts.tools ?? []) tools.register(tool);
      if (opts.dangerTools?.length) {
        denials = installDangerToolGuardrail(ctx, opts.dangerTools).denials;
      }
    },
  });

  const headless = await startHeadlessCore({
    logLevel: 'warn',
    host: { aiPluginsAfter: () => [{ plugin: probe }] },
  });
  // AI runtime 启动失败时内核只记日志、其余域照常可用；e2e 要的就是 AI runtime，直接失败
  if (!plugin || !headless.core.services.aiRuntime) {
    await headless.stop();
    throw new Error('[e2e] AI runtime did not start (see the core log above)');
  }
  const ctx = plugin;
  const settle = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));
  const windows = new Set<E2eWindow>();

  return {
    headless,
    llm,
    plugin: ctx,
    profile() {
      const svc = ctx.inject(UserProfileKey);
      if (!svc) throw new Error('[e2e] UserProfileService is not provided by the core');
      return svc;
    },
    get denials() {
      return denials;
    },
    async emit(evt, payload) {
      ctx.emit(evt, payload);
      await settle();
    },
    openWindow(caller) {
      const conn = headless.connect(caller);
      const client = new ClientAIClient({ transport: conn.transport });
      const win: E2eWindow = {
        client,
        api: conn.api,
        transport: conn.transport,
        async close() {
          windows.delete(win);
          await client.dispose();
          conn.close();
        },
      };
      windows.add(win);
      return win;
    },
    settle,
    async stop() {
      for (const w of [...windows]) await w.close();
      await headless.stop();
    },
  };
}
