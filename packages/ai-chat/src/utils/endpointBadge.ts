import { BUILTIN_CLI_ORDER, byCli, cliName } from '@nomi-ai/cli-catalog';
/**
 * 端点徽标：短标签 + 与灵动岛一致的色调（claude 橙、codex 蓝、dsh 蓝紫、grok 黑、nomi 珊瑚）。
 */
import { brand } from '@nomi-ai/types';

import type { ConversationBackend } from '../types/chat';

/** 图标与名称用的端点：对话后端，加上「other」（舰队等处认出的非内置编程助手，统称 CLI、画通用终端图标） */
export type EndpointKey = ConversationBackend | 'other';

/** 端点名称：统一为 Nomi / Claude Code / Codex / dsh / Grok / Gemini（专有名词不翻译） */
export const ENDPOINT_NAME: Record<EndpointKey, string> = {
  nomi: brand.appName,
  ...byCli(cliName),
  other: 'CLI',
};

export const ENDPOINT_FULL: Record<ConversationBackend, () => string> = {
  nomi: () => brand.appName,
  ...byCli((id) => () => cliName(id)),
};

/** CSS 变量友好的 data-ep 值，样式见 Sidebar */
export const ENDPOINT_CSS: Record<ConversationBackend, string> = {
  nomi: 'nomi',
  ...byCli((id) => id),
};

export const CLI_BACKENDS: readonly ConversationBackend[] = BUILTIN_CLI_ORDER;

export function isCliBackend(b: ConversationBackend): boolean {
  return b !== 'nomi';
}
