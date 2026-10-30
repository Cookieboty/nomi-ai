/**
 * 网关侧入口：客户端规格（纯数据，§5.5），由宿主在网关进程启动时登记进内核（P9.5）。
 * 不 import node:* 与 main 入口。
 */
import { manifest } from '@nomi-ai/cli-catalog/claude/manifest';

import {
  DEFAULT_SESSION_KEY,
  type CliGatewayEntry,
  type GatewayModelSlot,
} from '../shared/gatewaySpec';

/** Claude Code 的内置模型名：claude-* 或裸档位名，按档位映射；其余 claude-* → 主模型 */
const CLAUDE_GATE = '(?:claude|^(?:opus|sonnet|haiku|fable|default)$)';
const tier = (t: 'opus' | 'sonnet' | 'haiku' | 'fable') => ({
  pattern: `^(?=.*${CLAUDE_GATE}).*${t}`,
  slot: `tiers.${t}` as GatewayModelSlot,
});

export const gateway: CliGatewayEntry = {
  client: manifest.id,
  ingress: manifest.ingress,
  clientSpec: {
    id: manifest.id,
    strictness: 'lenient',
    builtinModels: [
      tier('opus'),
      tier('sonnet'),
      tier('haiku'),
      tier('fable'),
      { pattern: CLAUDE_GATE, slot: 'main' },
    ],
    unknownToMain: false,
    sessionKey: DEFAULT_SESSION_KEY,
    heartbeat: { kind: 'ping' },
    legacy: { ingress: 'messages' },
    // budget_tokens 来自 Nomi 启动时注入的 MAX_THINKING_TOKENS，不随标签的思考深度变（§6.9.5 C5）
    synthesizedReasoning: ['thinking.budget_tokens'],
  },
};
