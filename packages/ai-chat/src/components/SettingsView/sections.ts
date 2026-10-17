import type { LucideIcon } from 'lucide-react';

import { SETTINGS_ICONS } from '../AppIcons';

/** 设置分区（纯数据，App 首屏也要用，不随设置页懒加载）。 */
export type SettingsSection =
  | 'general'
  | 'shortcuts'
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
}> = [
  { id: 'general', icon: SETTINGS_ICONS.general, label: '通用' },
  { id: 'shortcuts', icon: SETTINGS_ICONS.shortcuts, label: '快捷键' },
  { id: 'coding', icon: SETTINGS_ICONS.coding, label: '编程助手' },
  { id: 'usage', icon: SETTINGS_ICONS.usage, label: '用量与费用' },
  { id: 'senses', icon: SETTINGS_ICONS.senses, label: '语音与屏幕' },
  { id: 'knowledge', icon: SETTINGS_ICONS.knowledge, label: '知识与记忆' },
  { id: 'schedule', icon: SETTINGS_ICONS.schedule, label: '日程与日历' },
  { id: 'notify', icon: SETTINGS_ICONS.notify, label: '通知 / 灵动岛' },
  { id: 'ext', icon: SETTINGS_ICONS.ext, label: '扩展 / MCP' },
  { id: 'local', icon: SETTINGS_ICONS.local, label: '本机管理' },
  { id: 'privacy', icon: SETTINGS_ICONS.privacy, label: '隐私与权限' },
];

/** 有标签页的分区：标签 id 与显示文案（文案作 i18n key，渲染时过 t()）。 */
export const SECTION_TABS = {
  senses: [
    { id: 'voice', label: '语音' },
    { id: 'screen', label: '屏幕' },
  ],
  knowledge: [
    { id: 'kb', label: '知识库' },
    { id: 'memory', label: '长期记忆' },
    { id: 'notes', label: '笔记' },
  ],
  schedule: [
    { id: 'reminders', label: '日程提醒' },
    { id: 'calendar', label: '日历接入' },
  ],
  privacy: [
    { id: 'data', label: '隐私与数据' },
    { id: 'desktop', label: '桌面权限' },
  ],
} as const;

export type SensesTab = (typeof SECTION_TABS.senses)[number]['id'];
export type KnowledgeTab = (typeof SECTION_TABS.knowledge)[number]['id'];
export type ScheduleSectionTab = (typeof SECTION_TABS.schedule)[number]['id'];
export type PrivacyTab = (typeof SECTION_TABS.privacy)[number]['id'];

/** 深链接可指定的标签（属于上面四个有标签页的分区之一）。 */
export type SettingsTab = SensesTab | KnowledgeTab | ScheduleSectionTab | PrivacyTab;

/** 某分区下 `tab` 是否是它自己的标签（用于忽略错配的深链接标签）。 */
export function tabOf<S extends keyof typeof SECTION_TABS>(
  section: S,
  tab: string | undefined,
): (typeof SECTION_TABS)[S][number]['id'] | undefined {
  return SECTION_TABS[section].find((x) => x.id === tab)?.id;
}

/** 「本机管理」（设置分区与顶栏抽屉共用）显示的 LocalPanel 标签：不含「日历」，日历在「日程与日历」里 */
export const LOCAL_MANAGE_TABS = ['clipboard', 'export', 'models', 'ollama'] as const;
