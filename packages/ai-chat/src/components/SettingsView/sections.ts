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
    label: '通用',
    intro: '配置 Nomi 的基础行为与外观设置。',
  },
  {
    id: 'shortcuts',
    icon: SETTINGS_ICONS.shortcuts,
    label: '快捷键',
    intro: '配置 Nomi 的全局快捷键与应用内快捷键，提升你的工作效率。',
  },
  {
    id: 'models',
    icon: SETTINGS_ICONS.models,
    label: '模型',
    intro:
      '一个第三方供应商就能同时给 Nomi 对话和各编程助手用，协议由 Nomi 自动转换。官方账号的登录与切换仍在「编程助手」页。',
  },
  {
    id: 'quality',
    icon: SETTINGS_ICONS.quality,
    label: '模型质量',
    intro:
      '各供应商、模型、Key 的成功率、延迟、输出速度与缓存命中率，可按维度对比。只记录元数据，全部只存本机。',
    wide: true,
  },
  {
    id: 'coding',
    icon: SETTINGS_ICONS.coding,
    label: '编程助手',
    intro:
      '管理 Claude Code / Codex / dsh / Grok / Gemini 的版本与官方账号，以及本机编程助手的进度监视。Nomi 自己和各助手的第三方模型都在「模型」页设置。',
  },
  {
    id: 'usage',
    icon: SETTINGS_ICONS.usage,
    label: '用量与费用',
    intro: '查看 Token 使用、成本统计与费用趋势。',
  },
  {
    id: 'senses',
    icon: SETTINGS_ICONS.senses,
    label: '语音与屏幕',
    intro: '语音输入与朗读，以及截图提问、屏幕记忆：Nomi 听你说、看你屏幕的方式都在这里设置。',
  },
  {
    id: 'knowledge',
    icon: SETTINGS_ICONS.knowledge,
    label: '知识与记忆',
    intro:
      '知识库来自你加入的文件夹和笔记，长期记忆来自你和 Nomi 的对话，笔记是你的本地 Markdown 笔记库；提问时它们会一起被检索，并在回答里标出引用。都只保存在本机。',
  },
  {
    id: 'schedule',
    icon: SETTINGS_ICONS.schedule,
    label: '日程与日历',
    intro:
      '提醒、定时任务和主动聊天在「日程提醒」；系统日历、.ics 与 CalDAV 在「日历接入」。读到的日程会进入每日简报，AI 也能通过日历工具查看。',
  },
  {
    id: 'notify',
    icon: SETTINGS_ICONS.notify,
    label: '通知 / 灵动岛',
    intro: '编程助手完成、需要确认或出错时，在灵动岛与系统通知里提醒你。',
  },
  {
    id: 'ext',
    icon: SETTINGS_ICONS.ext,
    label: '扩展 / MCP',
    intro: '管理 MCP 服务器、插件与技能，扩展 Nomi 能调用的工具。',
  },
  {
    id: 'local',
    icon: SETTINGS_ICONS.local,
    label: '本机管理',
    intro: '管理本机的剪贴板历史、数据导出、本地模型与 Ollama。',
  },
  {
    id: 'privacy',
    icon: SETTINGS_ICONS.privacy,
    label: '隐私与权限',
    intro:
      '数据怎么存、怎么导出和清除，以及 Nomi 能访问哪些文件夹、用哪些工具。所有内容都只保存在本机。',
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
  quality: [
    { id: 'compare', label: '对比' },
    { id: 'trend', label: '趋势' },
    { id: 'requests', label: '请求明细' },
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
