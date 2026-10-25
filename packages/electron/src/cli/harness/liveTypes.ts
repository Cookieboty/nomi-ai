/**
 * 编排层对外类型与常量（从 HarnessOrchestrator 拆出，便于 IPC / 测试 / 其它模块引用）。
 * docs/design/cli-plugin-architecture.md §5.4 / R5。
 */
import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
import type { ExternalCliSpec } from '@nomi-ai/cli-sdk';

import type { AccountKind } from '../accounts/types';
import type { HarnessBackend, HarnessTabSource } from '../types';

type BuiltinBackend = BuiltinCliId;

/** 统一网关提供给编程助手的能力（主进程 GatewayService，§12） */
export interface HarnessGateway {
  /** 新标签默认来源、第三方时用的模型、官方时用的账号 id（clients.<cli>，§12） */
  defaults(kind: BuiltinBackend): {
    source: HarnessTabSource;
    model: string | null;
    accountId: string | null;
  };
  /** 第三方会话的进程级注入；网关没在运行时返回 null */
  launch(
    kind: BuiltinBackend,
    tabId: string,
    model: string,
    /**
     * tabBound：这个进程按标签令牌启动（与 launchForTab 写出同一份配置，含占位模型名）；
     * longContext：标签对长上下文的选择，不给 = 按模型默认
     */
    opts?: { tabBound?: boolean; longContext?: boolean },
  ): {
    env: Record<string, string>;
    args: string[];
    strip: readonly string[];
    modelInConfig?: boolean;
  } | null;
  /** 官方会话：剔除指向网关的残留变量 */
  officialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** 第三方可选模型 */
  models(): Array<{ ref: string; provider: string; label: string; vision?: boolean }>;
  /** 标签关闭后回收它的进程级私有目录 */
  releaseAgent(kind: BuiltinBackend, tabId: string): void;
  /**
   * 第三方进程启动前：签发这个进程代次的标签令牌并在网关登记绑定（§6.7，先登记后启动），
   * 返回把共享令牌换成标签令牌后的环境变量。网关没在运行返回 null；网关拒绝 / 超时会抛出。
   * 不提供时第三方进程用客户端级令牌（旧行为）。
   */
  launchForTab?(
    kind: BuiltinBackend,
    tabId: string,
    model: string,
    effort?: string,
    longContext?: boolean,
  ): Promise<{
    env: Record<string, string>;
    generation: number;
    /** 这次启动是否把真实模型名写进了 CLI 配置；false = 按占位模型名启动（Grok 的 nomi），换模型只改绑定 */
    modelInConfig?: boolean;
  } | null>;
  /**
   * 进程退出 / 标签关闭：作废这个标签的令牌。进程退出时带上它的代次，只作废那一代
   * （旧进程的退出可能晚于新代次的登记）；标签关闭不带代次。
   */
  releaseTab?(kind: BuiltinBackend, tabId: string, generation?: number): void;
  /** gateway / inplace 型换模型（§6.7）：只改绑定，不重启；没有活着的绑定返回 false */
  updateTab?(kind: BuiltinBackend, tabId: string, model: string, effort?: string): Promise<boolean>;
}

/**
 * 官方账号（docs/design/cli-plugin-architecture.md §5.10，主进程 AccountService）：
 * 官方标签用哪个账号目录、要剔除哪些会改变路由或鉴权的继承变量。没有时官方标签用 CLI 自己的目录。
 */
export interface HarnessOfficialAccounts {
  launch(
    kind: AccountBackend,
    accountId: string | null | undefined,
  ): { env: Record<string, string>; strip: readonly string[]; args: string[]; sig: string };
  /** 官方标签拿到 CLI 会话 id：记下它跑在哪个账号里（历史标注、按原账号续接，§5.10 S9） */
  noteSession?(kind: AccountBackend, sessionId: string, accountId: string | null | undefined): void;
}

/**
 * 外部插件（L1 声明式，§5.9，主进程 CliPluginHost）：编排层用通用 ACP 后端跑它们（backend = 'external'）。
 * 没有时不能新建外部 CLI 标签。
 */
export interface HarnessExternalPlugins {
  /** 就绪的外部插件清单；不存在 / 已删除 / 校验不过返回 undefined */
  spec(id: string): ExternalCliSpec | undefined;
  /** 握手报告的能力（只能关掉能力，宿主据此更新注册表） */
  handshake?(id: string, caps: { images: boolean; resume: boolean }): void;
}

/** 有官方账号的后端 */
export type AccountBackend = AccountKind;

export const MAIN_TAB_ID = 'main';

/** 权限卡超时：与桌面能力一致，默认拒绝 */
export const PERMISSION_TIMEOUT_MS = 120_000;
/** Nomi 委派开的标签：用户多半把活交出去就离开了，审批多等一会（docs/design/nomi-delegate-cli.md §5.1） */
export const DELEGATED_PERMISSION_TIMEOUT_MS = 600_000;

/** 标签结束一轮 / 出错时发给主进程订阅者（看板娘、灵动岛、监视器） */
export interface HarnessTabFinished {
  tabId: string;
  title: string;
  backend: HarnessBackend;
  ok: boolean;
  text: string;
  error?: string;
  /** 结束时该标签不在前台（需要提醒） */
  background: boolean;
}

/** sendTab 被用户停止（cancelTab）：不是错误；partialText 是停止前已生成的文字 */
export class HarnessStoppedError extends Error {
  constructor(
    message: string,
    readonly partialText: string,
  ) {
    super(message);
    this.name = 'HarnessStoppedError';
  }
}
