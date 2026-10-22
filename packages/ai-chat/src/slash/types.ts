/**
 * 斜杠命令统一模型（设计见 docs/design/chat-slash-commands.md §4）。
 *
 * 借鉴 ACP `available_commands_update` 的最小形状（name / description / input.hint），
 * 再加 Nomi 需要的：来源（分组）、接管方式（kind）、别名和执行器。
 */
import type { CliAccount } from '../services/cliAccountClient';
import type { CliInstallInfo } from '../services/cliUpdateClient';
import type { GatewayState } from '../services/gatewayClient';
import type {
  BackendModelCatalog,
  GitDiffResult,
  HarnessTabMeta,
  SlashDiscoveryEntry,
  SlashExpansion,
  TabSource,
} from '../services/harnessClient';
import type { ProviderState } from '../services/providerClient';
import type { UsageEndpointInfo, UsageQuotaEntry } from '../services/usageClient';
import type { ConversationBackend } from '../types/chat';
import type { ConvMessage } from '../types/conversation';

/** 面板分组（也是展示顺序）。当前端的命令在前，Nomi 的命令在后。 */
export type SlashSource = 'builtin' | 'endpoint' | 'project' | 'user' | 'plugin' | 'skill' | 'ui';

export const SLASH_SOURCE_ORDER: readonly SlashSource[] = [
  'endpoint',
  'project',
  'user',
  'plugin',
  'skill',
  'builtin',
  'ui',
];

/**
 * 接管方式：
 * - native      Nomi 自己执行，结果以系统卡片展示（不发给模型）
 * - passthrough 命令本身是 CLI 在 -p / 流式模式下文档化支持的，原样发给 CLI
 * - expand      Nomi 在本机展开成提示词再发给模型（模板来自项目 / 用户目录）
 * - unsupported 交互式 / 未文档化：给出原因与替代方案，不发给模型
 * - ui          打开 Nomi 自己的界面（面板 / 设置）
 */
export type SlashKind = 'native' | 'passthrough' | 'expand' | 'unsupported' | 'ui';

export interface SlashArgSpec {
  /** 参数提示，如 `[问题]` / `<provider>` */
  hint: string;
}

export interface SlashCommand {
  /** 全局唯一：`<source>:<name>`，用于 key / 去重 */
  id: string;
  /** 不含 `/` 的名字；与其它来源重名时已被加上限定前缀（project: / user: / 插件名:） */
  name: string;
  /** 别名（同样不含 `/`） */
  aliases?: string[];
  label: string;
  description: string;
  source: SlashSource;
  kind: SlashKind;
  args?: SlashArgSpec;
  /** 项目 / 用户 / 插件 / Grok 自带（自定义命令与 skill 才有）；重名时用它当限定前缀 */
  scope?: 'project' | 'user' | 'plugin' | 'bundled';
  /** 来源补充：项目 / 用户 / 插件名 / 位置等，面板里作为小标签 */
  badge?: string;
  /** 与内置命令重名，因而被改成了限定名 */
  qualified?: boolean;
  /**
   * 菜单里保留但不能发送：同名冲突里落选的那一条，而 CLI 没有指定它的调用语法。
   * `reason` 是已翻译的说明。Nomi 加的限定名（project: / user: …）只是界面上的区分，
   * 绝不能当 CLI 协议发出去，所以这类命令的 run 只会给出说明卡片。
   */
  disabled?: { reason: string };
  run: (args: string, ctx: SlashContext) => Promise<SlashOutcome> | SlashOutcome;
}

/** 命令执行后：展示卡片 / 把文本发给后端 / 什么都不用做（已有副作用） */
export type SlashOutcome =
  | { type: 'card'; card: SlashCardInput }
  | { type: 'send'; text: string; note?: string }
  | { type: 'noop' };

// ───────────────────────────── 卡片 ─────────────────────────────

export interface CardAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

export interface CardRow {
  label: string;
  value: string;
  tone?: 'warn' | 'muted';
}

export interface CardListItem {
  /** 分组标题（连续相同的只在第一条前显示） */
  group?: string;
  label: string;
  hint?: string;
  description?: string;
  badge?: string;
  active?: boolean;
  action?: CardAction;
}

export interface ContextCategory {
  key: string;
  label: string;
  tokens: number;
}

export type CardBody =
  | {
      kind: 'context';
      used: number;
      windowSize: number;
      /** 窗口大小来源：内置经验表 / 无法识别的默认值 */
      windowSource: 'table' | 'default';
      /** 已用量依据：CLI / 供应商返回的真实用量 + 之后的估算，或全部估算 */
      basis: 'actual' | 'estimate';
      categories: ContextCategory[];
      model?: string;
      notes: string[];
    }
  | {
      kind: 'cost';
      session: {
        turns: number;
        input: number;
        output: number;
        cacheRead: number;
        costUsd: number;
        /** 有多少轮没有用量数据 */
        missing: number;
      };
      today?: { costUsd: number; tokens: number; calls: number };
      week?: { costUsd: number; tokens: number; calls: number };
      notes: string[];
    }
  | { kind: 'status'; rows: CardRow[] }
  | { kind: 'list'; items: CardListItem[]; empty?: string; note?: string }
  | { kind: 'notice'; tone: 'info' | 'warn' | 'error'; text: string; detail?: string }
  | ({ kind: 'diff' } & GitDiffResult);

export type SlashCardInput = CardBody & {
  title: string;
  actions?: CardAction[];
};

export interface SlashCard {
  id: string;
  /** 用户输入的命令原文（如 `/context`） */
  command: string;
  at: number;
  /** 出现在哪条消息之后；null = 会话开头 */
  afterId: string | null;
  backend: ConversationBackend;
  title: string;
  body: CardBody;
  actions?: CardAction[];
}

// ───────────────────────────── 上下文 ─────────────────────────────

/** 命令执行需要的、要异步读取的本机数据；全部来自主进程，不含凭据 */
export interface SlashData {
  cli: CliInstallInfo | null;
  usage: UsageEndpointInfo | null;
  quota: UsageQuotaEntry | null;
  /** CLI 当前的全局官方账号（dsh 没有；没登录为 null） */
  cliAccount: CliAccount | null;
  /** 发起命令的 CLI 标签（来源 / 模型）；Nomi 为 null */
  cliTab: HarnessTabMeta | null;
  /** 统一网关的状态：Nomi 对话的模型分配、CLI 第三方模型 */
  nomiGateway: GatewayState | null;
  /** 旧存储（网关里还没分配时的保底，如只有环境变量供应商） */
  nomiProviders: ProviderState | null;
}

export interface SlashContext {
  backend: ConversationBackend;
  cwd: string;
  /** 当前显示的会话消息（统一模型） */
  messages: readonly ConvMessage[];
  /** CLI 标签状态（Nomi 为 null） */
  session: { id: string | null; running: boolean } | null;
  /** 当前可用命令（/help 用） */
  commands: () => readonly SlashCommand[];
  load: () => Promise<SlashData>;
  actions: SlashActions;
}

export interface SlashActions {
  /** /clear /new：Nomi 开新会话；CLI 标签用同端同目录开新标签 */
  newSession: () => void | Promise<void>;
  openPlugins: () => void;
  openProviders: () => void;
  openSettings: () => void;
  /** Nomi：切换对话模型（`供应商/模型`，写网关的分配） */
  switchNomiModel: (ref: string) => Promise<void>;
  /**
   * CLI 标签：切换这个标签的来源（第三方时 model 是 `供应商/模型`）。
   * 第三方 → 官方且已有对话时先确认；返回 false = 用户取消
   */
  setTabSource: (source: TabSource, model?: string) => Promise<boolean>;
  /**
   * CLI 标签：这个标签的来源、模型目录与当前选择（与输入框的模型按钮同一份数据）。
   * catalog 为 null = 这个后端不能按标签切模型。
   */
  tabModels: () => Promise<{
    catalog: BackendModelCatalog | null;
    current: string | null;
    source: TabSource;
  }>;
  /** CLI 标签：切换这个标签的模型（空串 = 默认模型），下一条消息起生效 */
  setTabModel: (model: string, expectSource?: TabSource) => Promise<void>;
  gitDiff: () => Promise<GitDiffResult>;
  /** 主进程按 id 展开（Codex / Grok 的自定义命令与 skill） */
  expand: (id: string, args: string) => Promise<SlashExpansion | null>;
  /** Nomi 自带 Skills：读取启用的 skill 正文 */
  nomiSkillBody: (name: string) => Promise<string | null>;
  /** 把一段文本当作普通消息发出（卡片里的「作为普通文字发送」） */
  sendPlain: (text: string) => void;
}

export interface AdapterInput {
  backend: ConversationBackend;
  /** 主进程发现的项目 / 用户命令、skills、插件；null = 还没读到或不可用 */
  discovered: readonly SlashDiscoveryEntry[] | null;
  /** Nomi 自带 Skills（仅 nomi） */
  nomiSkills?: ReadonlyArray<{ name: string; description: string }>;
}

/** MessageInput 与会话层之间的桥：输入框只管弹面板与回车，命令怎么跑由会话层决定 */
export interface SlashBridge {
  /** 当前端命令 + 输入框自带的界面命令 → 合并去重后的注册表 */
  compose: (extra: SlashCommand[]) => SlashCommand[];
  /** 用户刚输入 `/`：重新读一次项目 / 用户命令目录（文件可能刚改过） */
  refresh: () => void;
  /** 当前显示的会话归属（读最新值）：输入框据此判断命令完成时用户是否还停在发起它的会话 */
  scope?: () => string;
  /** 执行一条输入。handled=false 表示不是命令（text 存在时为去掉 `//` 转义后的文字） */
  run: (text: string, all: SlashCommand[]) => Promise<{ handled: boolean; text?: string }>;
}
