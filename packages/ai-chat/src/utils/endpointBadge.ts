/**
 * 端点徽标：短标签 + 与灵动岛一致的色调（claude 橙、codex 蓝、dsh 蓝紫、grok 黑、nomi 珊瑚）。
 */
import { brand } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';

import type { ConversationBackend } from '../types/chat';

/** 端点名称：统一为 Nomi / Claude Code / Codex / dsh / Grok / Gemini（专有名词不翻译） */
export const ENDPOINT_NAME: Record<ConversationBackend, string> = {
  nomi: brand.appName,
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'dsh',
  grok: 'Grok',
  gemini: 'Gemini',
  // 外部 CLI 的名字来自它的清单（标签标题）；这里是没有清单时的统称
  external: 'CLI',
};

export const ENDPOINT_FULL: Record<ConversationBackend, () => string> = {
  nomi: () => brand.appName,
  claude: () => t('Claude Code'),
  codex: () => t('Codex'),
  dsh: () => 'dsh',
  grok: () => 'Grok',
  gemini: () => 'Gemini',
  external: () => t('ui.providers-schedule.external-cli'),
};

/** CSS 变量友好的 data-ep 值，样式见 Sidebar / ChatModeSwitch */
export const ENDPOINT_CSS: Record<ConversationBackend, string> = {
  nomi: 'nomi',
  claude: 'claude',
  codex: 'codex',
  dsh: 'dsh',
  grok: 'grok',
  gemini: 'gemini',
  external: 'external',
};

export const CLI_BACKENDS: ConversationBackend[] = ['claude', 'codex', 'dsh', 'grok', 'gemini'];

export function isCliBackend(b: ConversationBackend): boolean {
  return b !== 'nomi';
}
