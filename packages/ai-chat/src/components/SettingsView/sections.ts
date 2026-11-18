import type { TablerIcon as IconGlyph } from '@tabler/icons-react';

import { SETTINGS_ICONS } from '../AppIcons';

/** 设置分区（纯数据，App 首屏也要用，不随设置页懒加载）。 */
export type SettingsSection =
  | 'general'
  | 'nomi'
  | 'ai'
  /** Computer Use：让 Nomi 和 agent 操作本机应用（执行器 agent-desktop） */
  | 'computer'
  | 'usage'
  | 'knowledge'
  | 'ext'
  | 'connections'
  | 'privacy'
  | 'about'
  /** 调试：只在开发版（pnpm dev）出现，看灵动岛的各种样式等（DebugSection） */
  | 'debug';

export type LegacySettingsSection = 'models' | 'coding';
export type SettingsSectionInput = SettingsSection | LegacySettingsSection;

/** 开发版才有的分区（Vite 开发服务器提供视图时 import.meta.env.DEV 为 true；打包版里整段被去掉） */
export const DEV_SECTIONS = import.meta.env.DEV && import.meta.env.MODE !== 'test';
const DEV = DEV_SECTIONS;

export const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  icon: IconGlyph;
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
    id: 'nomi',
    icon: SETTINGS_ICONS.nomi,
    label: 'ui.chat-settings.nomi-section',
    intro: 'ui.chat-settings.nomi-section-intro',
  },
  {
    id: 'ai',
    icon: SETTINGS_ICONS.ai,
    label: 'ui.chat-settings.models-and-coding',
    intro: 'ui.chat-settings.models-and-coding-intro',
  },
  {
    id: 'usage',
    icon: SETTINGS_ICONS.usage,
    label: 'ui.chat-settings.usage-and-analytics',
    intro: 'ui.chat-settings.token-usage-cost-and-how-each-provider-performs',
    wide: true,
  },
  {
    id: 'computer',
    icon: SETTINGS_ICONS.computer,
    label: 'ui.chat-settings.computer-section',
    intro: 'ui.chat-settings.computer-section-intro',
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
    id: 'connections',
    icon: SETTINGS_ICONS.connections,
    label: 'ui.providers-schedule.connections',
    intro: 'ui.providers-schedule.connections-intro',
  },
  {
    id: 'privacy',
    icon: SETTINGS_ICONS.privacy,
    label: 'ui.chat-settings.privacy-permissions',
    intro: 'ui.chat-settings.how-your-data-is-stored-exported-and-cleared',
  },
  {
    id: 'about',
    icon: SETTINGS_ICONS.about,
    label: 'ui.chat-settings.about-section',
    intro: 'ui.chat-settings.about-section-intro',
  },
  ...(DEV
    ? [
        {
          id: 'debug' as const,
          icon: SETTINGS_ICONS.debug,
          label: 'ui.mascot-theme.island-debug-section',
          intro: 'ui.mascot-theme.island-debug-section-intro',
        },
      ]
    : []),
];

/**
 * 侧栏分组（只用细分隔线，不加组标题）：基础 / AI 能力与花费 / 数据与扩展 / 关于（开发版下面多一个调试）。
 * 每个分区恰好出现一次，顺序与 SETTINGS_SECTIONS 一致。
 */
export const SETTINGS_NAV_GROUPS: SettingsSection[][] = [
  ['general', 'nomi'],
  ['ai', 'usage', 'computer'],
  ['knowledge', 'ext', 'connections', 'privacy'],
  DEV ? ['about', 'debug'] : ['about'],
];

/** 有标签页的分区：标签 id 与显示文案（文案作 i18n key，渲染时过 t()）。 */
export const SECTION_TABS = {
  general: [
    { id: 'basics', label: 'ui.chat-settings.general' },
    { id: 'shortcuts', label: 'ui.chat-settings.shortcuts' },
    { id: 'voice', label: 'ui.chat-settings.voice' },
    { id: 'notify', label: 'ui.mascot-theme.notifications-island' },
  ],
  nomi: [
    // 权限与委派合在一个标签下（Nomi 自己做事要不要先问你、派给 agent 怎么派）
    { id: 'permissions', label: 'ui.chat-settings.permissions-and-handoff' },
    { id: 'tools', label: 'ui.chat-settings.desktop-permissions' },
    // 归档的是 Nomi 对话：放在「Nomi」里（以前在「通用」）
    { id: 'archived', label: 'ui.chat-settings.archived-chats' },
  ],
  ai: [
    { id: 'routing', label: 'ui.models.tab-routing' },
    { id: 'assistants', label: 'ui.models.tab-assistants' },
    // 三方供应商与本地模型分成两个标签（合在一页太长）
    { id: 'providers', label: 'ui.models.tab-providers' },
    { id: 'local', label: 'ui.models.tab-local' },
    { id: 'monitor', label: 'ui.cli-monitor.monitor-sessions' },
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
  computer: [
    // 安装、权限、紧急停止、agents、视觉兜底放一页；打码、禁止的应用、隔离模式放一页；安全说明在右侧「配置说明」
    { id: 'setup', label: 'ui.chat-settings.computer-tab-setup' },
    { id: 'privacy', label: 'ui.chat-settings.computer-tab-privacy' },
  ],
  privacy: [
    { id: 'data', label: 'ui.chat-settings.privacy-data' },
    // 外发保护：发给模型 / 第三方供应商之前的处理（数据流向），与「数据存在本机」分开
    { id: 'outbound', label: 'ui.chat-settings.outbound-protection' },
    { id: 'export', label: 'ui.knowledge-local.data-export' },
  ],
} as const;

type TabsOf<S extends keyof typeof SECTION_TABS> = (typeof SECTION_TABS)[S][number]['id'];
export type GeneralTab = TabsOf<'general'>;
export type NomiTab = TabsOf<'nomi'>;
export type AiTab = TabsOf<'ai'>;
export type UsageTab = TabsOf<'usage'>;
export type KnowledgeTab = TabsOf<'knowledge'>;
export type PrivacyTab = TabsOf<'privacy'>;
export type ComputerTab = TabsOf<'computer'>;

/** 深链接可指定的标签（属于上面有标签页的分区之一；旧 models 分区的 local 现在也是 ai 的标签）。 */
export type SettingsTab =
  GeneralTab | NomiTab | AiTab | UsageTab | KnowledgeTab | PrivacyTab | ComputerTab;

/** 将旧设置分区名（models / coding）归一化到合并后的 ai 分区对应标签。 */
export function normalizeSettingsTarget(
  section: SettingsSectionInput,
  tab?: string,
): { section: SettingsSection; tab?: SettingsTab } {
  if (section === 'coding') {
    return { section: 'ai', tab: tab === 'monitor' ? 'monitor' : 'assistants' };
  }
  if (section === 'models') {
    return {
      section: 'ai',
      tab: tab === 'routing' || tab === 'assistants' || tab === 'local' ? tab : 'providers',
    };
  }
  return { section, tab: tab as SettingsTab | undefined };
}

/** 某分区下 `tab` 是否是它自己的标签（用于忽略错配的深链接标签）。 */
export function tabOf<S extends keyof typeof SECTION_TABS>(
  section: S,
  tab: string | undefined,
): TabsOf<S> | undefined {
  return SECTION_TABS[section].find((x) => x.id === tab)?.id;
}
