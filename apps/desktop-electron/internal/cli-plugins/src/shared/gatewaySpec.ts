/**
 * 插件 gateway 入口导出的客户端规格（docs/design/cli-plugin-architecture.md §5.5、§6.6）：纯数据，
 * 形状与 @nomi-ai/gateway 的 ClientSpec 一致（插件包不依赖网关内核；内核 core/src/gateway/worker.ts
 * 把它交给 registerClientSpec，类型在那里由编译器核对）。
 */

/** 内置模型名对应到 ClientModels 的哪个槽位 */
export type GatewayModelSlot =
  'main' | 'summary' | 'subagent' | 'tools' | `tiers.${'opus' | 'sonnet' | 'haiku' | 'fable'}`;

export interface GatewaySessionKeyRule {
  header?: string;
  bodyPath?: string;
  parse?: 'claude-user';
  prefix: string;
}

export interface GatewayClientSpec {
  id: string;
  strictness: 'strict' | 'lenient';
  extraRequired?: Record<string, Record<string, unknown>>;
  /** 列表 = 子集；'spec' = 入口协议规范表里的全集；缺省 = 不过滤 */
  acceptedEvents?: readonly string[] | 'spec';
  helperModels?: string[];
  subagentModels?: string[];
  builtinModels?: Array<{ pattern: string; slot: GatewayModelSlot }>;
  unknownToMain?: boolean;
  sessionKey?: GatewaySessionKeyRule[];
  heartbeat?: { kind: 'comment' | 'ping' };
  legacy?: { ingress?: 'messages' | 'responses' | 'chat' | 'gemini'; userAgent?: string };
  synthesizedReasoning?: Array<'thinking.budget_tokens'>;
}

/** 插件的 gateway 入口 */
export interface CliGatewayEntry {
  client: string;
  ingress: string;
  clientSpec: GatewayClientSpec;
}

/** 会话键的默认规则（与网关内核的 DEFAULT_SESSION_KEY 一致；前缀与持久化的会话归属表兼容） */
export const DEFAULT_SESSION_KEY: GatewaySessionKeyRule[] = [
  { bodyPath: 'prompt_cache_key', prefix: 'pck' },
  { header: 'x-claude-code-session-id', prefix: 'cc' },
  { bodyPath: 'metadata.user_id', parse: 'claude-user', prefix: 'cc' },
];
