/**
 * AIRuntimeBoot - AI 运行时引导器（内核，纯 Node；docs/design/core-host-decoupling.md §7.1）
 *
 * 责任：
 * 1. 按内核实例创建 `AIRuntimeService`（Booter + Lifecycle + Logger；不用 ai-runtime 的模块级 `runtime`，
 *    一个进程可以有多个内核）；
 * 2. 启动 IgPluginHost + AI SDK providers，得到 `AIClient`；
 * 3. 用应用契约实现 AI 门面（`createAiHandlers`：`ai.*` 处理函数 + 事件），由 `createCore` 与其余域的
 *    处理函数一起组装成 router；供应商的契约过程（`providers.*`）直接调 `providers`（ProviderService）；
 * 4. 宿主给的插件与本地 TtsProvider：Electron 宿主注入 `bundle-ig-electron-caps` 的
 *    `FileSessionStorePlugin`（用户画像）与系统 TTS（`electron-native`），内核不 import 宿主插件包；
 * 5. 在 `dispose()` 时逆序清理。
 *
 * 用到的内核服务（网关、用量、扩展、人设）经 `services` 在调用时读取，不再取模块级单例。
 */

import {
  AIRuntimeService,
  createAiHandlers,
  GATEWAY_PROVIDER_ID,
  ProviderService,
  ProviderStore,
  createAiSdkBooter,
  createSafeStorageCipher,
  llmProvidersFromEnv,
  providerOverrideFromEnv,
  type AiHandlersHandle,
  type Booter,
  type IgPluginEntry,
  type RoutedLLMRegistry,
  type RuntimeLogger,
} from '@nomi-ai/ai-runtime';
import { appContract } from '@nomi-ai/contract/app';
import type { HostPorts } from '@nomi-ai/host-ports';

import type { AppEvents } from '../core/appEvents';
import { createDesktopIgPlugins, type DesktopToolSources } from '../desktop/plugin';
import type { ExtensionsService } from '../extensions/ExtensionsService';
import type { GatewayService } from '../gateway/GatewayService';
import { createPersonaIdentityPlugin } from '../persona/igPlugin';
import type { PersonaService } from '../persona/PersonaService';
import { safeStorageFromSecrets } from '../security/secretStorage';
import type { ILoggerService } from '../services/LoggerService';
import type { UsageService } from '../usage/UsageService';

import { splitGatewayUsage } from './gatewayUsage';
import { createMascotIgPlugins } from './mascotBridge';

type AIClient = AIRuntimeService['client'];

/**
 * 宿主注入的本地 TtsProvider（`ctx.tts.register(...)` 的注册对象）的最小形状；完整契约在
 * `bundle-ig-electron-caps/seams` 的 `TtsProvider`（Electron 宿主的 TtsElectronNativeProvider 结构上满足）。
 */
export interface TtsProviderLike {
  info: { id: string };
}

/** AI runtime 在调用时读取的内核服务（内核实例的服务表） */
export interface AIRuntimeServices {
  gateway(): GatewayService | null | undefined;
  usage(): UsageService | null | undefined;
  ext(): ExtensionsService | null | undefined;
  persona(): PersonaService | null | undefined;
}

export interface AIRuntimeBootOptions {
  /** 宿主端口：应用目录（插件宿主 home）、provider token 加密（secrets）、退出前收尾（lifecycle） */
  ports: Pick<HostPorts, 'paths' | 'secrets' | 'lifecycle'>;
  profile?: string;
  /** 默认 `ports.paths.appPath()` */
  home?: string;
  booter?: Booter;
  /** 是否把 AIClient 事件发布为契约事件（推给订阅了的窗口），默认 true */
  enableEventBroadcast?: boolean;
  /** 内核服务（调用时读取） */
  services: AIRuntimeServices;
  /** 桌面工具插件读取的服务（桌面 / 知识库 / 记忆 / 委派 / 扩展） */
  desktopTools: DesktopToolSources;
  /** 看板娘指令（avatar_gesture / avatar_emotion）经这个事件总线发给看板娘窗口 */
  events: AppEvents;
  /** 宿主插件，装在内置插件之前（Electron：FileSessionStorePlugin 提供用户画像存储） */
  hostPlugins?: IgPluginEntry[];
  /** 宿主插件，装在内置插件之后（无界面宿主测试：假的 LLM / 工具覆盖内置的） */
  hostPluginsAfter?: IgPluginEntry[];
  /**
   * 额外要注入到 `client.tts` 的本地 TtsProvider 列表（例如 Electron 宿主的
   * `TtsElectronNativeProvider`）。
   *
   * 语义：
   *   - 注入时机在 `client` 就绪之后、契约处理函数建好之前；
   *   - 若当前 profile 未装载 `bundle-ig-electron-caps` 的 `TtsPlugin`，
   *     `client.tts.register` 会抛 `SEAM_NOT_INJECTED`，本函数**吞掉**该错误
   *     并 `logger.warn` 提示（避免阻塞主流程）；其它异常照常向外抛。
   */
  ttsProviders?: TtsProviderLike[];
  /** Nomi 对话请求发出前的外发检查，见 AiRouterOptions.prepareChat */
  prepareChat?: (
    options: Record<string, unknown>,
    method: string,
    signal?: AbortSignal,
  ) => Promise<void>;
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
    /** 视图可调用的契约过程（`ai.*`） */
    business: readonly string[];
  };
  /** AI 门面的契约处理函数；宿主组装 router 时传给 `createAppRouter({ ai })` */
  ai: AiHandlersHandle;
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
  providers: TtsProviderLike[],
  logger: ILoggerService,
): void {
  if (providers.length === 0) return;
  for (const provider of providers) {
    try {
      // client.tts.register 内部会 `require()` TtsService；未注入时抛 SEAM_NOT_INJECTED。
      // 宿主的本地契约与 seams 结构等价（内核不 import 宿主插件包），这里只按最小形状转型。
      (client.tts.register as (p: TtsProviderLike) => void)(provider);
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
 * 启动 AI runtime；由 `createCore` 的 `start()` 调用（宿主已就绪之后）。
 */
export async function startAIRuntime(
  logger: ILoggerService,
  opts: AIRuntimeBootOptions,
): Promise<AIRuntimeBootHandle> {
  const { ports, services } = opts;
  const profile = opts.profile ?? process.env.IG_AI_PROFILE ?? 'waifu';
  const home = opts.home ?? ports.paths.appPath();
  const runtimeLogger = toRuntimeLogger(logger);

  // GatewayStore 是供应商唯一来源。这里只保留内存 ProviderStore：用量 sink + 预设/状态 IPC 垫片。
  // 旧 ai-providers.json 由 GatewayService 启动迁移后改名为 *.migrated，运行时不再读写。
  const cipher = createSafeStorageCipher(safeStorageFromSecrets(ports.secrets));
  const providerStore = new ProviderStore({
    cipher,
    // 用量与计费：每次成功调用记一条（响应 usage；没有才估算并标「估算」）
    onCall: (e) =>
      services.usage()?.record({
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
      // 宿主插件（Electron：FileSessionStorePlugin 提供 ProfileStorageKey → 用户画像持久化到
      // userData/ai-chat/memory）；角色身份（PersonaService → PersonaIdentityKey）：角色 preset 从这里读人设
      before: [
        ...(opts.hostPlugins ?? []),
        { plugin: createPersonaIdentityPlugin(() => services.persona()?.get()) },
      ],
      // 看板娘动作 / 表情工具（avatar_gesture / avatar_emotion）→ 事件总线 → 渲染进程
      after: [
        ...createMascotIgPlugins(opts.events),
        ...createDesktopIgPlugins(opts.desktopTools),
        ...(opts.hostPluginsAfter ?? []),
      ],
      // env(MCP_SERVERS) 来的工具同样强制走用户确认 + 审计（ExtensionsService.guardEnvTool）
      mcpToolGuard: (server, def) => services.ext()?.guardEnvTool(server, def) ?? def,
      providers: {
        store: providerStore,
        // 统一网关：Nomi 对话 / agent-tools / summary 只走网关（无旧存储回退）
        gateway: { resolve: (role) => services.gateway()?.nomiRoute(role) ?? null },
        onRegistry: (r) => {
          registry = r;
        },
      },
    });
  // 退出前收尾经宿主的 lifecycle 端口（Electron：app 的 before-quit；回调失败只记日志）
  const lifecycle = {
    onBeforeQuit: (fn: () => void | Promise<void>) => ports.lifecycle.onBeforeQuit(fn),
  };
  // 按内核实例创建（不用模块级 runtime 单例）
  const service = new AIRuntimeService({ booter, lifecycle, logger: runtimeLogger });
  const client = await service.start(profile, { home });

  if (opts.ttsProviders && opts.ttsProviders.length > 0) {
    tryRegisterTtsProviders(client, opts.ttsProviders, logger);
  }

  // AI 门面：应用契约的 ai.* 处理函数 + 事件。router 由 createCore 组装、传输由宿主挂，
  // 调用者判定（sender 白名单 + surface）在传输层，dangerous 过程只接受受信调用者
  const ai = createAiHandlers({
    client,
    logger: runtimeLogger,
    prepareChat: opts.prepareChat,
    publishEvents: opts.enableEventBroadcast !== false,
  });
  const procedures = Object.keys(appContract.procedures).filter((n) => n.startsWith('ai.'));

  logger.info(`AI runtime ready (profile=${profile})`, {
    procedures: procedures.length,
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
      if (p.id === GATEWAY_PROVIDER_ID) return services.gateway()?.nomiProvider(role) ?? null;
      const st = providerService.state();
      const v =
        st.providers.find((x) => x.id === p.id) ?? st.envProviders.find((x) => x.id === p.id);
      return { id: p.id, name: v?.name ?? p.id, baseURL: v?.baseURL };
    },
    lookupProvider(id) {
      const gw = services.gateway()?.providerInfo(id) ?? null;
      if (gw) return gw;
      // 仅环境变量垫片（ProviderService.envProviders），不读旧 ai-providers.json
      const st = providerService.state();
      const v = st.envProviders.find((x) => x.id === id);
      return v ? { id: v.id, name: v.name, baseURL: v.baseURL } : null;
    },
    providerCredentials(id) {
      // 只走网关（「模型」页与迁移后的供应商）；知识库 / 语音设置里的旧 id 在迁移后应已对应网关 id
      return services.gateway()?.credentials(id) ?? null;
    },
    listProviders() {
      return services.gateway()?.listOpenAiCompatible() ?? [];
    },
    channels: {
      business: procedures,
    },
    ai,
    async dispose() {
      try {
        providerStore.flush();
        registry?.dispose();
      } catch (err) {
        logger.warn('provider store flush threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        ai.dispose();
      } catch (err) {
        logger.warn('ai contract handlers dispose threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await service.stop();
      logger.info('AI runtime stopped');
    },
  };
}
