/**
 * 网关侧的客户端规格与适配器（docs/design/cli-plugin-architecture.md §5.5、§6.6）。
 * 规格主体是数据：哪个 CLI 多严格、额外要求哪些字段、能接受哪些事件、内置模型名怎么映射、
 * 会话键从哪取、心跳发什么、旧版本怎么认。网关里原来写死的 `client === 'claude'` 分支都改读这里。
 * 数据表达不了的行为用钩子（ClientAdapterHooks），由宿主（Electron 的网关进程入口）按 id 登记，
 * 网关内核不依赖任何插件。
 */
import type { ClientModels } from '../config';
import type { Wire } from '../ir';
import type { HeartbeatKind } from '../stream/heartbeat';
import type { SseEvent } from '../stream/sse';

/** 内置模型名对应到 ClientModels 的哪个槽位 */
export type ModelSlot =
  'main' | 'summary' | 'subagent' | 'tools' | `tiers.${'opus' | 'sonnet' | 'haiku' | 'fable'}`;

export interface BuiltinModelRule {
  /** 正则（不区分大小写），匹配请求里的模型名 */
  pattern: string;
  slot: ModelSlot;
}

export interface SessionKeyRule {
  /** 请求头名（小写） */
  header?: string;
  /** 请求体里的路径（点分） */
  bodyPath?: string;
  /** 取到的值怎么解析：claude-user = Claude Code 的 metadata.user_id（JSON 或旧格式） */
  parse?: 'claude-user';
  /** 会话键的前缀（与持久化的会话归属表保持兼容：pck / cc / tab） */
  prefix: string;
}

export interface ClientSpec {
  id: string;
  /** 严格：任何不合规都会让 CLI 丢掉整轮（Grok）；宽松：未知字段 / 事件被忽略（Codex） */
  strictness: 'strict' | 'lenient';
  /**
   * 超出协议规范、这个 CLI 额外要求的字段：事件类型 → 字段名 → 缺失时补的值。
   * （设计稿写的是字段名列表；补值需要默认值，这里直接带上）
   */
  extraRequired?: Record<string, Record<string, unknown>>;
  /** 这个 CLI 能接受的事件类型子集；缺省 = 规范全集 */
  acceptedEvents?: readonly string[];
  /** 辅助请求用的模型名（标题、摘要、提示…），正则；解析到 ClientModels.summary（没设时跟主模型） */
  helperModels?: string[];
  /** 子代理默认模型名，正则；解析到 ClientModels.subagent */
  subagentModels?: string[];
  /** 内置模型名映射（Claude 的 opus / sonnet / haiku / fable 档位等），按顺序第一条命中的胜出 */
  builtinModels?: BuiltinModelRule[];
  /** 不认识的模型名：true = 按主模型处理（Codex、Grok 等发的内部名）；false = 404 */
  unknownToMain?: boolean;
  /** 会话键从哪取（缓存亲和、会话归属表），按顺序第一条有值的胜出 */
  sessionKey?: SessionKeyRule[];
  /** 心跳的形式（要不要由网关决定：默认都发） */
  heartbeat?: { kind: HeartbeatKind };
  /** 遗留识别（旧版共享令牌没有客户端身份）：入口协议或 User-Agent 子串 */
  legacy?: { ingress?: Wire; userAgent?: string };
  /** 推理参数里哪些是 CLI 自己合成的（解码时标 client-default，§6.9.5） */
  synthesizedReasoning?: Array<'thinking.budget_tokens'>;
}

export interface ConformContext {
  spec: ClientSpec;
  /** 入口协议 */
  wire: Wire;
  notes: string[];
}

export interface ClientAdapterHooks {
  /** 请求体改写（规格表达不了的） */
  request?(body: unknown, ctx: { spec: ClientSpec; wire: Wire }): unknown;
  /** 输出事件的校验 / 修正；返回 null 丢弃 */
  conform?(ev: SseEvent, ctx: ConformContext): SseEvent | null;
}

export type { ClientModels };
