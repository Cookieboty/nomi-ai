import type { LucideIcon } from 'lucide-react';

import { SETTINGS_ICONS } from '../AppIcons';

/** 设置分区（纯数据，App 首屏也要用，不随设置页懒加载）。 */
export type SettingsSection =
  | 'general'
  | 'shortcuts'
  | 'models'
  | 'quality'
  | 'coding'
  | 'usage'
  | 'senses'
  | 'knowledge'
  | 'schedule'
  | 'notify'
  | 'ext'
  | 'local'
  | 'privacy';

export const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  icon: LucideIcon;
  label: string;
  /** 页头说明（i18n key）：设置页统一在右侧顶部渲染「标题 + 说明」 */
  intro: string;
  /**
   * 内容需要整页宽度（宽表格等）：不显示右侧「配置说明」栏，改为页头的「说明」按钮展开在页头下面
   */
  wide?: boolean;
}> = [
  {
    id: 'general',
    icon: SETTINGS_ICONS.general,
    label: 'ui.chat-settings.general',
    intro: 'ui.chat-settings.configure-nomi-s-basic-behavior-and-appearance',
  },
  {
    id: 'shortcuts',
    icon: SETTINGS_ICONS.shortcuts,
    label: 'ui.chat-settings.shortcuts',
    intro: 'ui.chat-settings.configure-nomi-s-global-and-in-app-shortcuts',
  },
  {
    id: 'models',
    icon: SETTINGS_ICONS.models,
    label: 'ui.foundation.model',
    intro: 'ui.models.one-third-party-provider-can-serve-nomi-chat',
  },
  {
    id: 'quality',
    icon: SETTINGS_ICONS.quality,
    label: 'ui.model-quality.model-quality',
    intro: 'ui.model-quality.success-rate-latency-output-speed-and-cache-hit',
    wide: true,
  },
  {
    id: 'coding',
    icon: SETTINGS_ICONS.coding,
    label: 'ui.providers-schedule.coding-agents',
    intro: 'ui.providers-schedule.manage-versions-and-official-accounts-for-claude-code',
  },
  {
    id: 'usage',
    icon: SETTINGS_ICONS.usage,
    label: 'ui.usage-tools.usage-cost',
    intro: 'ui.chat-settings.review-token-usage-cost-statistics-and-spending-trends',
  },
  {
    id: 'senses',
    icon: SETTINGS_ICONS.senses,
    label: 'ui.chat-settings.voice-screen',
    intro: 'ui.chat-settings.voice-input-and-reading-aloud-plus-screenshot-questions',
  },
  {
    id: 'knowledge',
    icon: SETTINGS_ICONS.knowledge,
    label: 'ui.chat-settings.knowledge-memory',
    intro: 'ui.chat-settings.the-knowledge-base-comes-from-the-folders-and',
  },
  {
    id: 'schedule',
    icon: SETTINGS_ICONS.schedule,
    label: 'ui.chat-settings.schedule-calendar',
    intro: 'ui.chat-settings.reminders-scheduled-tasks-and-proactive-chat-are-under',
  },
  {
    id: 'notify',
    icon: SETTINGS_ICONS.notify,
    label: 'ui.mascot-theme.notifications-island',
    intro: 'ui.chat-settings.get-notified-in-the-dynamic-island-and-system',
  },
  {
    id: 'ext',
    icon: SETTINGS_ICONS.ext,
    label: 'ui.foundation.extensions-mcp',
    intro: 'ui.chat-settings.manage-mcp-servers-plugins-and-skills-to-extend',
  },
  {
    id: 'local',
    icon: SETTINGS_ICONS.local,
    label: 'ui.chat-settings.local-tools',
    intro: 'ui.chat-settings.manage-clipboard-history-data-export-local-models-and',
  },
  {
    id: 'privacy',
    icon: SETTINGS_ICONS.privacy,
    label: 'ui.chat-settings.privacy-permissions',
    intro: 'ui.chat-settings.how-your-data-is-stored-exported-and-cleared',
  },
];

/**
 * 侧栏分组（只用细分隔线，不加组标题）：基础 / AI 能力与花费 / 感知与陪伴 / 系统与数据。
 * 每个分区恰好出现一次，顺序与 SETTINGS_SECTIONS 一致。
 */
export const SETTINGS_NAV_GROUPS: SettingsSection[][] = [
  ['general', 'shortcuts'],
  ['models', 'quality', 'coding', 'usage'],
  ['senses', 'knowledge', 'schedule', 'notify'],
  ['ext', 'local', 'privacy'],
];

/** 有标签页的分区：标签 id 与显示文案（文案作 i18n key，渲染时过 t()）。 */
export const SECTION_TABS = {
  senses: [
    { id: 'voice', label: 'ui.chat-settings.voice' },
    { id: 'screen', label: 'ui.chat-settings.screen' },
  ],
  knowledge: [
    { id: 'kb', label: 'ui.foundation.knowledge-base' },
    { id: 'memory', label: 'ui.knowledge-local.long-term-memory' },
    { id: 'notes', label: 'ui.foundation.notes' },
  ],
  schedule: [
    { id: 'reminders', label: 'ui.mascot-theme.schedule-reminders' },
    { id: 'calendar', label: 'ui.chat-settings.calendar-sources' },
  ],
  privacy: [
    { id: 'data', label: 'ui.chat-settings.privacy-data' },
    { id: 'desktop', label: 'ui.chat-settings.desktop-permissions' },
  ],
  quality: [
    { id: 'compare', label: 'ui.model-quality.compare' },
    { id: 'trend', label: 'ui.usage-tools.trend' },
    { id: 'requests', label: 'ui.model-quality.request-details' },
  ],
} as const;

export type SensesTab = (typeof SECTION_TABS.senses)[number]['id'];
export type KnowledgeTab = (typeof SECTION_TABS.knowledge)[number]['id'];
export type ScheduleSectionTab = (typeof SECTION_TABS.schedule)[number]['id'];
export type PrivacyTab = (typeof SECTION_TABS.privacy)[number]['id'];
export type QualitySectionTab = (typeof SECTION_TABS.quality)[number]['id'];

/** 深链接可指定的标签（属于上面有标签页的分区之一）。 */
export type SettingsTab =
  SensesTab | KnowledgeTab | ScheduleSectionTab | PrivacyTab | QualitySectionTab;

/** 某分区下 `tab` 是否是它自己的标签（用于忽略错配的深链接标签）。 */
export function tabOf<S extends keyof typeof SECTION_TABS>(
  section: S,
  tab: string | undefined,
): (typeof SECTION_TABS)[S][number]['id'] | undefined {
  return SECTION_TABS[section].find((x) => x.id === tab)?.id;
}

/** 「本机管理」（设置分区与顶栏抽屉共用）显示的 LocalPanel 标签：不含「日历」，日历在「日程与日历」里 */
export const LOCAL_MANAGE_TABS = ['clipboard', 'export', 'models'] as const;
