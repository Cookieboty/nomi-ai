/**
 * CLI 插件契约（docs/design/cli-plugin-architecture.md §5.1、§5.3、§5.7）：清单 + 主进程能力实现。
 * 插件按清单里的能力位选择实现；宿主对没实现的能力给默认行为（隐藏对应界面）。
 * 本文件只有类型与 defineCliPlugin，不 import electron（插件的 main 入口也只能依赖 node:* 与本包）。
 */
import type { SessionDriver } from './driver';
import type { HarnessEvent, HarnessPermissionMode, SessionEvent } from './events';
import type { CliManifest } from './manifest';

/** 宿主给插件的能力（日志、数据目录、用户主目录）；插件不直接碰 Electron */
export interface CliMainHost {
  logger: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
  /** 插件自己的数据目录（userData/cli-plugins/<id>） */
  dataDir: string;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

/** 启动注入（§5.3）：宿主统一执行 env / strip / files / privateHome */
export interface AgentLaunch {
  env: Record<string, string>;
  args: string[];
  /** 要从继承环境里剔除的变量（会抢鉴权的 API Key 等） */
  strip: string[];
  /** 进程级私有目录里要写的文件（宿主统一写入、统一回收） */
  files?: Array<{ path: string; content: string; mode?: number }>;
  /** 私有 HOME：共享条目软链回用户目录（正则字符串，可序列化） */
  privateHome?: { envVar: string; shared: string; keepPrivate: string[] };
}

export interface LaunchContext {
  cwd: string;
  permissionMode: HarnessPermissionMode;
  /** 标签级模型 / 思考深度覆盖（null = CLI 默认） */
  model: string | null;
  effort: string | null;
  /** 官方账号目录（null = 用户自己的 CLI 目录，§5.10） */
  accountDir: string | null;
  /** 进程级私有目录（宿主分配、进程结束回收） */
  runDir: string;
}

export interface ThirdPartyLaunchContext extends LaunchContext {
  /** 网关地址与这个标签的路由令牌（§6.7） */
  gatewayUrl: string;
  token: string;
  /** 网关给这个标签解析出的模型元数据（窗口、输出上限、是否支持图片） */
  model: string | null;
  modelMeta?: { contextWindow?: number; maxOutput?: number; images?: boolean };
}

export interface LaunchCapability {
  official(ctx: LaunchContext): AgentLaunch;
  thirdParty?(ctx: ThirdPartyLaunchContext): AgentLaunch;
  /** CLI 发给网关的占位模型名（如 Grok 的 nomi）；有它才可能用 gateway 方式换模型（§6.7） */
  placeholderModel?: string;
}

export interface DetectCapability {
  /** 找可执行文件（默认实现按清单的 binary.names 在 PATH 里找） */
  resolveBin?(env: NodeJS.ProcessEnv): Promise<string | null>;
  version?(bin: string): Promise<string | null>;
}

export interface UpdateCapability {
  latest(): Promise<string | null>;
  /** 返回要运行的升级命令（宿主执行，带进度） */
  command(): { command: string; args: string[] } | null;
}

/** 对共享驱动的定制（§5.4）：参数、事件映射补丁；插件不再自己实现会话 */
export interface SessionCustomization {
  /** 驱动的启动参数（在 launch.args 之前） */
  args?(ctx: LaunchContext & { resumeId: string | null }): string[];
  /** 一行输出 → 事件（stream-json / exec 驱动用；每个进程 / 每轮新建） */
  parser?(): (line: string) => HarnessEvent[];
  /** 驱动事件进编排层之前的补丁（改写 / 丢弃） */
  mapEvent?(e: SessionEvent): SessionEvent | null;
  /** 创建驱动（缺省按 transport 用共享驱动） */
  createDriver?(o: { launch: AgentLaunch; ctx: LaunchContext }): SessionDriver;
}

export interface ModelCatalogCapability {
  list(o: { env: NodeJS.ProcessEnv }): Promise<{
    models: Array<{ id: string; label?: string; efforts?: string[]; defaultEffort?: string }>;
    defaultModel?: string;
  }>;
}

export interface PermissionCapability {
  /** Nomi 档位 → 启动参数（重启生效的 CLI） */
  launchArgs?(mode: HarnessPermissionMode): string[];
  /** Nomi 档位 → 协议 mode id（原地切换的 CLI） */
  modeId?(mode: HarnessPermissionMode): string;
  /** 协议 mode id → Nomi 档位（打开历史会话时沿用；认不出返回 null） */
  fromModeId?(id: string): HarnessPermissionMode | null;
}

/** 历史会话（§5.7） */
export interface HistoryFileRef {
  path: string;
  mtime: number;
  size: number;
  dirId?: string;
}

export interface HistorySessionMeta {
  sessionId: string;
  cwd?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: HarnessPermissionMode;
  /** 线路：网关 → 第三方；其它 → 官方 */
  route?: 'gateway' | 'official' | 'custom';
  /** 会话里记录的账号 id（Codex creator_account_id 等） */
  accountId?: string;
}

export type HistoryParse =
  | { meta: HistorySessionMeta; messages?: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { error: string; formatHint?: string };

export interface HistoryCapability {
  /** 会话文件在哪（尊重 CLI 的 HOME 环境变量） */
  roots(env: NodeJS.ProcessEnv, home: string): string[];
  /** 列出候选文件（只读目录，不解析内容） */
  scan(root: string): AsyncIterable<HistoryFileRef>;
  /** 解析元数据与对话；认不出的格式返回 { error }，不要返回 null */
  parse(text: string, f: HistoryFileRef): HistoryParse;
  /** 续接时给 CLI 的参数 / ACP 的 session/load */
  resume(sessionId: string): { args?: string[]; loadSession?: boolean };
}

export interface ProgressCapability {
  /** 外部（终端里）运行的会话文件位置，供进度监视器只读扫描 */
  watchRoots(env: NodeJS.ProcessEnv, home: string): string[];
}

export interface UsageCapability {
  /** 本地会话日志里的用量（只读记账字段） */
  logRoots?(env: NodeJS.ProcessEnv, home: string): string[];
  /** 订阅额度：在账号目录里运行官方 CLI 取（不读凭据） */
  quota?(o: { env: NodeJS.ProcessEnv }): Promise<unknown>;
}

/** 官方账号：一个账号 = 一个配置目录，登录由 CLI 自己完成，插件不接触凭据（§5.10） */
export interface AccountCapability {
  /** CLI 的配置目录环境变量（CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME / GEMINI_CLI_HOME） */
  homeEnv: string;
  /** 官方启动时要剔除的继承变量（会改路由或鉴权的） */
  strip: string[];
  /** 账号目录里与用户目录共享的条目 */
  shared: Array<{ name: string; dir: boolean; createIfMissing?: boolean }>;
  /** 登录 / 登出 / 状态命令（在账号目录里运行） */
  loginArgs: string[];
  logoutArgs?: string[];
  statusArgs?: string[];
}

export interface SlashDiscoveryCapability {
  list(o: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    home: string;
  }): Promise<Array<{ name: string; description?: string; kind?: 'command' | 'skill' | 'agent' }>>;
}

export interface TerminalCapability {
  /** 「在终端里打开」的命令行（env 是要设的变量，宿主按平台转义） */
  command(o: { cwd: string; resumeId?: string; env: Record<string, string> }): {
    command: string;
    args: string[];
  };
}

export interface CliMainImpl {
  detect?: DetectCapability;
  update?: UpdateCapability;
  launch: LaunchCapability;
  session?: SessionCustomization;
  models?: ModelCatalogCapability;
  permissions?: PermissionCapability;
  history?: HistoryCapability;
  progress?: ProgressCapability;
  usage?: UsageCapability;
  accounts?: AccountCapability;
  slash?: SlashDiscoveryCapability;
  terminal?: TerminalCapability;
}

export interface CliPlugin {
  manifest: CliManifest;
  main?: (host: CliMainHost) => CliMainImpl | Promise<CliMainImpl>;
}

/** 插件工厂：只做类型约束（与仓库里其它 defineXxx 一致），校验在宿主加载时做 */
export function defineCliPlugin(p: CliPlugin): CliPlugin {
  return p;
}
