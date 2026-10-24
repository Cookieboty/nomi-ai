/**
 * 内置 CLI 的客户端规格（§5.5）。数值与原来写死的分支一致（route/resolve.ts 的 mapBuiltinModel、
 * affinity.ts 的会话键、server.ts 的 legacyClient、intent.ts 的 Claude 预算判定），行为不变。
 */
import { RESPONSES_EVENTS } from '../spec/responses';

import type { BuiltinModelRule, ClientSpec, SessionKeyRule } from './types';

/** 会话键的默认规则（原 affinity.ts 的顺序；前缀与持久化的会话归属表兼容） */
export const DEFAULT_SESSION_KEY: SessionKeyRule[] = [
  { bodyPath: 'prompt_cache_key', prefix: 'pck' },
  { header: 'x-claude-code-session-id', prefix: 'cc' },
  { bodyPath: 'metadata.user_id', parse: 'claude-user', prefix: 'cc' },
];

/** Claude Code 的内置模型名：claude-* 或裸档位名，按档位映射；其余 claude-* → 主模型 */
const CLAUDE_GATE = '(?:claude|^(?:opus|sonnet|haiku|fable|default)$)';
const claudeTier = (tier: 'opus' | 'sonnet' | 'haiku' | 'fable'): BuiltinModelRule => ({
  pattern: `^(?=.*${CLAUDE_GATE}).*${tier}`,
  slot: `tiers.${tier}`,
});

export const claude: ClientSpec = {
  id: 'claude',
  strictness: 'lenient',
  builtinModels: [
    claudeTier('opus'),
    claudeTier('sonnet'),
    claudeTier('haiku'),
    claudeTier('fable'),
    { pattern: CLAUDE_GATE, slot: 'main' },
  ],
  unknownToMain: false,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'ping' },
  legacy: { ingress: 'messages' },
  // budget_tokens 来自 Nomi 启动时注入的 MAX_THINKING_TOKENS，不随标签的思考深度变（§6.9.5 C5）
  synthesizedReasoning: ['thinking.budget_tokens'],
};

export const codex: ClientSpec = {
  id: 'codex',
  strictness: 'lenient',
  unknownToMain: true,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'comment' },
  legacy: { userAgent: 'codex' },
};

/** Grok Build：按官方结构用 serde 严格反序列化，缺字段 / 未知事件就丢掉整轮 */
export const grok: ClientSpec = {
  id: 'grok',
  strictness: 'strict',
  acceptedEvents: [...RESPONSES_EVENTS],
  // 会话标题 / 摘要、下一句提示没配置时 Grok 用内置名（实测 grok-4.6）
  helperModels: ['^grok-4\\.6'],
  unknownToMain: true,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'comment' },
  legacy: { userAgent: 'grok' },
};

export const dsh: ClientSpec = {
  id: 'dsh',
  strictness: 'lenient',
  unknownToMain: true,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'comment' },
  legacy: { userAgent: 'dsh' },
};

export const gemini: ClientSpec = {
  id: 'gemini',
  strictness: 'lenient',
  unknownToMain: true,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'comment' },
  legacy: { ingress: 'gemini' },
};

/** Nomi 自己的对话（经 SDK）：模型名总是显式的 */
export const nomi: ClientSpec = {
  id: 'nomi',
  strictness: 'lenient',
  unknownToMain: false,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'comment' },
};

/** 旧版共享令牌按这个顺序认身份（与原 legacyClient 的判定顺序一致） */
export const BUILTIN_CLIENT_SPECS: readonly ClientSpec[] = [claude, codex, grok, dsh, gemini, nomi];
