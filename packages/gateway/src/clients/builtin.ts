/**
 * 网关内核自带的客户端规格（§5.5）：只有 Nomi 自己的对话。各编程助手（claude / codex / grok / gemini / dsh）
 * 的规格是数据，放在各自插件的 gateway 入口（@nomi-ai/cli-plugins/<cli>/gateway），由宿主在网关进程启动时
 * 用 registerClientSpec 组装进来（P9.5）；网关内核不依赖任何插件。
 */
import type { ClientSpec, SessionKeyRule } from './types';

/** 会话键的默认规则（原 affinity.ts 的顺序；前缀与持久化的会话归属表兼容） */
export const DEFAULT_SESSION_KEY: SessionKeyRule[] = [
  { bodyPath: 'prompt_cache_key', prefix: 'pck' },
  { header: 'x-claude-code-session-id', prefix: 'cc' },
  { bodyPath: 'metadata.user_id', parse: 'claude-user', prefix: 'cc' },
];

/** Nomi 自己的对话（经 SDK）：模型名总是显式的 */
export const nomi: ClientSpec = {
  id: 'nomi',
  strictness: 'lenient',
  unknownToMain: false,
  sessionKey: DEFAULT_SESSION_KEY,
  heartbeat: { kind: 'comment' },
};

export const BUILTIN_CLIENT_SPECS: readonly ClientSpec[] = [nomi];
