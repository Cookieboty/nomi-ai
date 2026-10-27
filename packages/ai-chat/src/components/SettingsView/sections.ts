import type { LucideIcon } from 'lucide-react';

import { SETTINGS_ICONS } from '../AppIcons';

/** 设置分区（纯数据，App 首屏也要用，不随设置页懒加载）。 */
export type SettingsSection =
  'general' | 'models' | 'coding' | 'usage' | 'knowledge' | 'ext' | 'privacy';

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
    id: 'models',
    icon: SETTINGS_ICONS.models,
    label: 'ui.chat-settings.models-and-providers',
    intro: 'ui.models.one-third-party-provider-can-serve-nomi-chat',
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
    label: 'ui.chat-settings.usage-and-quality',
    intro: 'ui.chat-settings.token-usage-cost-and-how-each-provider-performs',
    wide: true,
  },
  {
    id: 'knowledge',
    icon: SETTINGS_ICONS.knowledge,
    label: 'ui.chat-settings.knowledge-memory',
    intro: 'ui.chat-settings.knowledge-base-long-term-memory-and-schedule-all-local',
  },
  {
    id: 'ext',
    icon: SETTINGS_ICONS.ext,
    label: 'ui.foundation.extensions-mcp',
    intro: 'ui.chat-settings.manage-mcp-servers-plugins-and-skills-to-extend',
  },
  {
    id: 'privacy',
    icon: SETTINGS_ICONS.privacy,
    label: 'ui.chat-settings.privacy-permissions',
    intro: 'ui.chat-settings.how-your-data-is-stored-exported-and-cleared',
  },
];

/**
 * 侧栏分组（只用细分隔线，不加组标题）：基础 / AI 能力与花费 / 数据与扩展。
 * 每个分区恰好出现一次，顺序与 SETTINGS_SECTIONS 一致。
 */
export const SETTINGS_NAV_GROUPS: SettingsSection[][] = [
  ['general'],
  ['models', 'coding', 'usage'],
  ['knowledge', 'ext', 'privacy'],
];

/** 有标签页的分区：标签 id 与显示文案（文案作 i18n key，渲染时过 t()）。 */
export const SECTION_TABS = {
  general: [
    { id: 'basics', label: 'ui.chat-settings.general' },
    { id: 'shortcuts', label: 'ui.chat-settings.shortcuts' },
    { id: 'voice', label: 'ui.chat-settings.voice' },
    { id: 'notify', label: 'ui.mascot-theme.notifications-island' },
  ],
  models: [
    { id: 'providers', label: 'ui.models.third-party-providers' },
    { id: 'local', label: 'ui.knowledge-local.local-models' },
  ],
  usage: [
    { id: 'cost', label: 'ui.usage-tools.usage-cost' },
    { id: 'compare', label: 'ui.model-quality.compare' },
    { id: 'trend', label: 'ui.usage-tools.trend' },
    { id: 'requests', label: 'ui.model-quality.request-details' },
  ],
  knowledge: [
    { id: 'kb', label: 'ui.foundation.knowledge-base' },
    { id: 'memory', label: 'ui.knowledge-local.long-term-memory' },
    { id: 'schedule', label: 'ui.chat-settings.schedule' },
  ],
  privacy: [
    { id: 'data', label: 'ui.chat-settings.privacy-data' },
    // 外发保护：发给模型 / 第三方供应商之前的处理（数据流向），与「数据存在本机」分开
    { id: 'outbound', label: 'ui.chat-settings.outbound-protection' },
    { id: 'desktop', label: 'ui.chat-settings.desktop-permissions' },
    { id: 'export', label: 'ui.knowledge-local.data-export' },
  ],
} as const;

type TabsOf<S extends keyof typeof SECTION_TABS> = (typeof SECTION_TABS)[S][number]['id'];
export type GeneralTab = TabsOf<'general'>;
export type ModelsTab = TabsOf<'models'>;
export type UsageTab = TabsOf<'usage'>;
export type KnowledgeTab = TabsOf<'knowledge'>;
export type PrivacyTab = TabsOf<'privacy'>;

/** 深链接可指定的标签（属于上面有标签页的分区之一）。 */
export type SettingsTab = GeneralTab | ModelsTab | UsageTab | KnowledgeTab | PrivacyTab;

/** 某分区下 `tab` 是否是它自己的标签（用于忽略错配的深链接标签）。 */
export function tabOf<S extends keyof typeof SECTION_TABS>(
  section: S,
  tab: string | undefined,
): TabsOf<S> | undefined {
  return SECTION_TABS[section].find((x) => x.id === tab)?.id;
}
