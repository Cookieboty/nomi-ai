/**
 * AIRuntimeBoot - 主进程 AI 运行时引导器
 *
 * 责任：
 * 1. 装配 `@nomi-ai/ai-runtime` 单例（Booter + Lifecycle + Logger）；
 * 2. 启动 IgPluginHost + AI SDK providers，得到 `AIClient`；
 * 3. 挂上 `IPCTransportServer`（业务方法反射）、`EventBroadcaster`（事件广播）、
 *    `CapabilityIpcServer`（seams 通道）、`AiChatCompat`（旧通道兼容）；
 * 4. 可选：把遗留 `AdvancedTTSEngine` 注册为 `electron-native` TtsProvider（P8-5 尾巴）；
 * 5. 在 `dispose()` 时逆序清理。
 *
 * 依赖注入通过 `AIRuntimeBootOptions.seams` 提供；未提供的 seam 只是 IPC 通道会返回
 * `SEAM_NOT_INJECTED`，不影响业务门面。
 */

import {
  AiChatCompat,
  CapabilityIpcServer,
  EventBroadcaster,
  GATEWAY_PROVIDER_ID,
  IPCTransportServer,
  ProviderIpcServer,
  ProviderService,
  ProviderStore,
  createAiSdkBooter,
  createSafeStorageCipher,
  llmProvidersFromEnv,
  providerOverrideFromEnv,
  createElectronIpcAdapter,
  createGuardedIpcAdapter,
  createElectronLifecycle,
  runtime,
  type Booter,
  type RoutedLLMRegistry,
  type RuntimeLogger,
} from '@nomi-ai/ai-runtime';
import type { AIClient } from '@nomi-ai/ai-sdk';
import { FileSessionStorePlugin } from '@nomi-ai/bundle-ig-electron-caps';
import { app, safeStorage } from 'electron';

import { desktopIgPlugins } from '../desktop/plugin';
import { getExtensionsService } from '../extensions/ExtensionsService';
import { getGatewayService } from '../gateway/GatewayService';
import { isTrustedAiSender } from '../security/ipcSenderGuard';
import type { ILoggerService } from '../services/LoggerService';
import { getUsageService } from '../usage/UsageService';

import { splitGatewayUsage } from './gatewayUsage';
import { mascotIgPlugins } from './mascotBridge';
import type { TtsProvider } from './TtsElectronNativeProvider';

export interface AIRuntimeBootSeams {
  clipboard?: unknown;
  screen?: unknown;
}

export interface AIRuntimeBootOptions {
  profile?: string;
  home?: string;
  booter?: Booter;
  seams?: AIRuntimeBootSeams;
  /** 是否启用旧 `ai-chat:*` 通道兼容层，默认 true */
  enableLegacyCompat?: boolean;
  /** 是否挂 CapabilityIpcServer（若 seams 均未注入，可跳过），默认 true */
  enableCapabilityIpc?: boolean;
  /** 是否挂事件广播，默认 true */
  enableEventBroadcast?: boolean;
  /**
   * 额外要注入到 `client.tts` 的本地 TtsProvider 列表（例如
   * [TtsElectronNativeProvider](file:///./TtsElectronNativeProvider.ts)）。
   *
   * 语义：
   *   - 注入时机在 `client` 就绪之后、CapabilityIpc / EventBroadcaster 挂载之前；
   *   - 若当前 profile 未装载 `bundle-ig-electron-caps` 的 `TtsPlugin`，
   *     `client.tts.register` 会抛 `SEAM_NOT_INJECTED`，本函数**吞掉**该错误
   *     并 `logger.warn` 提示（避免阻塞主流程）；其它异常照常向外抛。
   */
  ttsProviders?: TtsProvider[];
}

export interface AIRuntimeBootHandle {
  client: AIClient;
  profile: string;
  /** 多 provider 配置服务（面板 / 托盘切换） */
  providers: ProviderService;
  /** 某个角色当前实际路由到的 provider（桌面工具判断本地 / 云端） */
  resolveProvider(
    role: 'chat' | 'agent-tools' | 'summary',
  ): { id: string; name: string; baseURL?: string } | null;
  /** 按 id 查 provider 的名字 / 地址（工具调用实际使用的 provider 显示名字用）；不含 key */
  lookupProvider(id: string): { id: string; name: string; baseURL?: string } | null;
  /** 已保存 provider 的连接信息（语音识别等非聊天用途；只在主进程内使用，绝不发给渲染进程） */
  providerCredentials(
    id: string,
  ): { id: string; name: string; baseURL: string; apiKey?: string } | null;
  /** 已保存 provider 列表（不含 key） */
  listProviders(): Array<{ id: string; name: string; baseURL: string }>;
  channels: {
    business: readonly string[];
  };
  dispose(): Promise<void>;
}

/**
 * 把 ILoggerService 适配成 RuntimeLogger（同名方法即可）。
 */
function toRuntimeLogger(l: ILoggerService): RuntimeLogger {
  return {
    info: (msg, meta) => l.info(String(msg), meta as Record<string, unknown> | undefined),
    warn: (msg, meta) => l.warn(String(msg), meta as Record<string, unknown> | undefined),
    error: (msg, meta) => l.error(String(msg), meta as Record<string, unknown> | undefined),
  };
}

function tryRegisterTtsProviders(
  client: AIClient,
  providers: TtsProvider[],
  logger: ILoggerService,
): void {
  if (providers.length === 0) return;
  for (const provider of providers) {
    try {
      // client.tts.register 内部会 `require()` TtsService；未注入时抛 SEAM_NOT_INJECTED。
      // 这里对 register 参数做一次协变转型：electron 侧本地契约与 seams 结构等价，
      // 但 electron tsconfig `moduleResolution: node` 无法直接解析 `@nomi-ai/bundle-ig-electron-caps/seams`
      // 子入口，故用 unknown 中转，等价性靠单测保证。
      (client.tts.register as (p: TtsProvider) => void)(provider);
      logger.info(`TtsProvider registered: id=${provider.info.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      if (code === 'SEAM_NOT_INJECTED') {
        logger.warn(
          `TtsProvider skipped: ctx.tts not injected (profile 未加载 bundle-ig-electron-caps?); provider=${provider.info.id}`,
        );
        continue;
      }
      logger.error(`TtsProvider register failed: id=${provider.info.id}`, { error: message });
      throw err;
    }
  }
}

/**
 * 启动 AI runtime；调用方一般在 Application.start() → app.whenReady() 后调用。
 */
export async function startAIRuntime(
  logger: ILoggerService,
  opts: AIRuntimeBootOptions = {},
): Promise<AIRuntimeBootHandle> {
  const profile = opts.profile ?? process.env.IG_AI_PROFILE ?? 'waifu';
  const home = opts.home ?? app.getAppPath();
  const runtimeLogger = toRuntimeLogger(logger);

  // GatewayStore 是供应商唯一来源。这里只保留内存 ProviderStore：用量 sink + 预设/状态 IPC 垫片。
  // 旧 ai-providers.json 由 GatewayService 启动迁移后改名为 *.migrated，运行时不再读写。
  const cipher = createSafeStorageCipher(safeStorage);
  const providerStore = new ProviderStore({
    cipher,
    // 用量与计费：每次成功调用记一条（响应 usage；没有才估算并标「估算」）
    onCall: (e) =>
      getUsageService()?.record({
        ts: e.at,
        dur: e.durationMs,
        source: 'nomi',
        via: 'chat',
        // 经统一网关：模型名是「供应商/模型」，拆回真正的供应商与模型（显示名与计价按它们算）
        ...splitGatewayUsage(e.providerId, e.model),
        promptTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheRead: e.cacheReadTokens,
        cacheWrite: e.cacheWriteTokens,
        est: e.estimated,
        key: e.reqId ? `nomi:${e.reqId}:${e.at}` : undefined,
      }),
  });
  if (cipher.kind === 'none') {
    logger.warn(
      '系统安全存储（safeStorage）不可用：provider token 仅做编码保存，未加密。面板中会提示用户。',
    );
  }
  let registry: RoutedLLMRegistry | undefined;
  const providerService = new ProviderService({
    store: providerStore,
    envEntries: llmProvidersFromEnv(process.env),
    getRegistry: () => registry,
    overrideId: providerOverrideFromEnv(process.env),
  });

  const booter =
    opts.booter ??
    createAiSdkBooter({
      logger: runtimeLogger,
      // FileSessionStorePlugin 提供 ProfileStorageKey → 用户画像持久化到 userData/ai-chat/memory
      before: [{ plugin: FileSessionStorePlugin }],
      // 看板娘动作 / 表情工具（live2d_play_motion / live2d_set_expression）→ IPC → 渲染进程
      after: [...mascotIgPlugins, ...desktopIgPlugins],
      // env(MCP_SERVERS) 来的工具同样强制走用户确认 + 审计（ExtensionsService.guardEnvTool）
      mcpToolGuard: (server, def) => getExtensionsService()?.guardEnvTool(server, def) ?? def,
      providers: {
        store: providerStore,
        // 统一网关：Nomi 对话 / agent-tools / summary 只走网关（无旧存储回退）
        gateway: { resolve: (role) => getGatewayService()?.nomiRoute(role) ?? null },
        onRegistry: (r) => {
          registry = r;
        },
      },
    });
  const lifecycle = createElectronLifecycle();
  const service = runtime.configure({ booter, lifecycle, logger: runtimeLogger });
  const client = await service.start(profile, { home });

  if (opts.ttsProviders && opts.ttsProviders.length > 0) {
    tryRegisterTtsProviders(client, opts.ttsProviders, logger);
  }

  // 所有 ai:* 通道统一套 sender origin 白名单（file:// 生产页面 / 127.0.0.1 dev server）
  const adapter = createGuardedIpcAdapter(createElectronIpcAdapter(), (event) =>
    isTrustedAiSender(event),
  );

  const transport = new IPCTransportServer({
    client,
    adapter,
    logger: runtimeLogger,
  });
  transport.start();

  let broadcaster: EventBroadcaster | undefined;
  if (opts.enableEventBroadcast !== false) {
    broadcaster = new EventBroadcaster({ adapter, logger: runtimeLogger });
    broadcaster.start(client);
  }

  let capability: CapabilityIpcServer | undefined;
  if (opts.enableCapabilityIpc !== false) {
    const seams = opts.seams ?? {};
    capability = new CapabilityIpcServer({
      adapter,
      logger: runtimeLogger,
      injector: {
        getScreen: () => seams.screen,
        getClipboard: () => seams.clipboard,
      },
    });
    capability.start();
  }

  const providerIpc = new ProviderIpcServer({
    adapter,
    service: providerService,
    logger: runtimeLogger,
  });
  providerIpc.start();

  let compat: AiChatCompat | undefined;
  if (opts.enableLegacyCompat !== false) {
    compat = new AiChatCompat({ adapter, client, logger: runtimeLogger });
    compat.start();
  }

  logger.info(`AI runtime ready (profile=${profile})`, {
    channels: transport.channels.length,
    home,
  });

  return {
    client,
    profile,
    providers: providerService,
    resolveProvider(role) {
      const p = registry?.resolve(role)?.provider;
      if (!p) return null;
      // 经统一网关：报真正的上游供应商与地址（网关本身是本机回环，不能据此判断本地）
      if (p.id === GATEWAY_PROVIDER_ID) return getGatewayService()?.nomiProvider(role) ?? null;
      const st = providerService.state();
      const v =
        st.providers.find((x) => x.id === p.id) ?? st.envProviders.find((x) => x.id === p.id);
      return { id: p.id, name: v?.name ?? p.id, baseURL: v?.baseURL };
    },
    lookupProvider(id) {
      const gw = getGatewayService()?.providerInfo(id) ?? null;
      if (gw) return gw;
      // 仅环境变量垫片（ProviderService.envProviders），不读旧 ai-providers.json
      const st = providerService.state();
      const v = st.envProviders.find((x) => x.id === id);
      return v ? { id: v.id, name: v.name, baseURL: v.baseURL } : null;
    },
    providerCredentials(id) {
      // 只走网关（「模型」页与迁移后的供应商）；知识库 / 语音设置里的旧 id 在迁移后应已对应网关 id
      return getGatewayService()?.credentials(id) ?? null;
    },
    listProviders() {
      return getGatewayService()?.listOpenAiCompatible() ?? [];
    },
    channels: {
      business: transport.channels,
    },
    async dispose() {
      try {
        providerIpc.stop();
        providerStore.flush();
        registry?.dispose();
      } catch (err) {
        logger.warn('ProviderIpcServer.stop threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        compat?.stop();
      } catch (err) {
        logger.warn('AiChatCompat.stop threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        capability?.stop();
      } catch (err) {
        logger.warn('CapabilityIpcServer.stop threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        broadcaster?.stop();
      } catch (err) {
        logger.warn('EventBroadcaster.stop threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        transport.stop();
      } catch (err) {
        logger.warn('IPCTransportServer.stop threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await runtime.stop();
      logger.info('AI runtime stopped');
    },
  };
}
