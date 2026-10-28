/**
 * 无界面宿主（docs/design/core-host-decoupling.md §6.3、§11.3）：用 `createNodeHostPorts` 的端口（临时目录、
 * 内存密钥、记录下来的对话框 / 通知 / 窗口调用）建一个完整的内核，并用 in-process 传输接上类型化的契约客户端。
 * 无界面 e2e（`e2e/`）与开发态浏览器入口（`pnpm dev:web`）都用它；不需要 Electron 和显示环境。
 *
 * ```ts
 * const h = await startHeadlessCore();
 * const { api } = h.connect();                       // 默认以对话窗口（chat，受信）身份
 * await api.theme.set({ pref: 'ink' });
 * h.control.windowCalls;                             // 内核要求打开的窗口
 * await h.stop();                                    // 停内核、断连接、删临时目录
 * ```
 *
 * 没有宿主片段：要用窗口对象的过程（看板娘窗口、灵动岛、应用图标、旧窗口通道）以 UNAVAILABLE 失败。
 * 内核仍有进程级的状态（界面语言、诊断日志目录等，见 §12 P4 进度说明），同一进程里的多个无界面内核会共用它们。
 */

import { createClient, type CallerContext, type Client, type Router } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import { createInProcessServer, type InProcessClient } from '@nomi-ai/contract/testing';
import {
  createCore,
  type Core,
  type CoreConfig,
  type CoreContractOptions,
  type CoreHostHooks,
} from '@nomi-ai/core/createCore';
import { LoggerService, LogLevel } from '@nomi-ai/core/services/LoggerService';
import type { HostPorts } from '@nomi-ai/host-ports';

import { createNodeHostPorts, type NodeHostControl, type NodeHostPortsOptions } from './index';

export interface HeadlessCoreOptions {
  /** 端口选项（根目录、预设对话框答案、能力声明…） */
  ports?: NodeHostPortsOptions;
  /** 内核配置；`autoSyncModels` 缺省为 false（不联网） */
  config?: CoreConfig;
  /** 宿主钩子（无界面 e2e 用 `aiPluginsAfter` 换上假的 LLM / 工具） */
  host?: CoreHostHooks;
  /** 宿主片段与 router 中间件 */
  contract?: CoreContractOptions;
  /** 根日志；缺省按端口的日志目录新建（写文件，同时输出到控制台） */
  logger?: LoggerService;
  /** 日志级别，默认 `info`（e2e 用 `warn` 降噪）；start() 之后生效到底（诊断服务启动时会改级别） */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /** start() 之后是否启动提醒与定时任务，默认 true（无界面宿主没有要等的窗口） */
  reminders?: boolean;
}

export interface HeadlessClient {
  api: Client<AppContract>;
  transport: InProcessClient;
  /** 断开这个连接（等于窗口关闭）：服务端会话关闭、进行中的调用取消 */
  close(): void;
}

export interface HeadlessCore {
  core: Core;
  ports: HostPorts;
  control: NodeHostControl;
  router: Router<AppContract>;
  /**
   * 建一个契约客户端（一个连接 = 一个窗口）。默认身份 `{ surface: 'chat', trusted: true }`；
   * 帧走完整的线协议（严格序列化检查）。
   */
  connect(caller?: CallerContext): HeadlessClient;
  /** 停内核、断开全部连接、删除自动建的临时目录；可重入 */
  stop(): Promise<void>;
}

export const HEADLESS_CHAT_CALLER: CallerContext = Object.freeze({
  surface: 'chat',
  trusted: true,
});

const LEVELS = {
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
} as const;

function createLogger(ports: HostPorts, level: keyof typeof LEVELS): LoggerService {
  const logger = new LoggerService({ ports });
  logger.setLevel(LEVELS[level]);
  return logger;
}

/** 建端口、建内核并 `start()`；返回后 router 已就绪 */
export async function startHeadlessCore(options: HeadlessCoreOptions = {}): Promise<HeadlessCore> {
  const { ports, control } = createNodeHostPorts(options.ports);
  const logger = options.logger ?? createLogger(ports, options.logLevel ?? 'info');
  const core = createCore({
    ports,
    logger,
    config: { autoSyncModels: false, ...options.config },
    ...(options.host ? { host: options.host } : {}),
    ...(options.contract ? { contract: options.contract } : {}),
  });
  try {
    await core.start();
  } catch (err) {
    await core.stop().catch(() => undefined);
    control.dispose();
    throw err;
  }
  // 诊断服务在 start() 里按开发态把级别调成 DEBUG：明确要了级别就再设一次（启动期间的日志仍按缺省级别）
  if (options.logLevel) logger.setLevel(LEVELS[options.logLevel]);
  if (options.reminders !== false) core.startReminders();

  const server = createInProcessServer();
  const stopServing = server.serve(core.router as unknown as Router);
  const clients = new Set<InProcessClient>();

  let stopping: Promise<void> | undefined;
  return {
    core,
    ports,
    control,
    router: core.router,
    connect(caller = HEADLESS_CHAT_CALLER) {
      if (stopping) throw new Error('[host-node] headless core is stopped');
      const transport = server.connect(caller);
      clients.add(transport);
      const api = createClient(core.router.contract, transport, { handshake: 'off' });
      return {
        api,
        transport,
        close() {
          clients.delete(transport);
          transport.disconnect();
        },
      };
    },
    stop() {
      stopping ??= (async () => {
        for (const c of [...clients]) c.disconnect();
        clients.clear();
        stopServing();
        try {
          await core.stop();
        } finally {
          // 先把缓冲的日志写完，再删临时目录（否则进程退出时补写会找不到日志目录）
          logger.flushSync();
          control.dispose();
        }
      })();
      return stopping;
    },
  };
}
