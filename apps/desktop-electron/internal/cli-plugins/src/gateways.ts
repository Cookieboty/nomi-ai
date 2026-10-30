/**
 * 全部内置插件的网关侧入口（P9.5）：网关进程按这个顺序登记客户端规格。
 * 顺序就是旧版共享令牌认身份的顺序（claude、codex、grok、dsh、gemini，与原 legacyClient 一致）。
 */
import { gateway as claude } from './claude/gateway';
import { gateway as codex } from './codex/gateway';
import { gateway as dsh } from './dsh/gateway';
import { gateway as gemini } from './gemini/gateway';
import { gateway as grok } from './grok/gateway';
import type { CliGatewayEntry } from './shared/gatewaySpec';

export const BUILTIN_GATEWAY_ENTRIES: readonly CliGatewayEntry[] = [
  claude,
  codex,
  grok,
  dsh,
  gemini,
];

export type { CliGatewayEntry, GatewayClientSpec } from './shared/gatewaySpec';
