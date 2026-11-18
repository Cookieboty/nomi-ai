import {
  IconActivity as Activity,
  IconAppWindow as AppWindow,
  IconBan as Ban,
  IconChartBar as BarChart3,
  IconBook2 as BookOpen,
  IconPackages as Boxes,
  IconClipboardList as ClipboardList,
  IconCpu as Cpu,
  IconDownload as Download,
  IconFolderLock as FolderLock,
  IconGauge as Gauge,
  IconStack2 as Layers,
  IconPlug as Plug,
  IconReceipt as ReceiptText,
  IconShield as Shield,
  IconShieldCheck as ShieldCheck,
  IconTerminal2 as SquareTerminal,
  IconStopwatch as Timer,
  IconWallet as Wallet,
  IconRoute as Waypoints,
  type TablerIcon as IconGlyph,
} from '@tabler/icons-react';

import { FEATURE_ICONS } from '../AppIcons';

import type { SettingsSection } from './sections';

/** 右侧「配置说明」：每个分区里有哪些卡片 / 标签、各自做什么（文案为 i18n key）。 */
export interface HelpItem {
  icon: IconGlyph;
  title: string;
  desc: string;
}

export const SECTION_HELP: Record<
  Exclude<SettingsSection, 'general' | 'about' | 'debug'>,
  HelpItem[]
> = {
  nomi: [
    {
      icon: Shield,
      title: 'ui.chat-settings.permissions',
      desc: 'ui.chat-settings.nomi-permissions-help',
    },
    {
      icon: FEATURE_ICONS.delegate,
      title: 'ui.chat-settings.handoff',
      desc: 'ui.chat-settings.nomi-handoff-help',
    },
    {
      icon: FolderLock,
      title: 'ui.chat-settings.desktop-permissions',
      desc: 'ui.chat-settings.accessible-folders-available-tools-and-the-action-log',
    },
  ],
  ai: [
    {
      icon: Waypoints,
      title: 'ui.models.tab-routing',
      desc: 'ui.models.ai-help-routing-desc',
    },
    {
      icon: AppWindow,
      title: 'ui.models.tab-assistants',
      desc: 'ui.models.ai-help-assistants-desc',
    },
    {
      icon: Boxes,
      title: 'ui.models.third-party-providers',
      desc: 'ui.chat-settings.add-providers-and-keys-nomi-converts-protocols-automatically',
    },
    {
      icon: Cpu,
      title: 'ui.knowledge-local.local-models',
      desc: 'ui.knowledge-local.built-in-llama-cpp-local-models-plus-optional',
    },
  ],
  computer: [
    {
      icon: Download,
      title: 'ui.chat-settings.computer-executor',
      desc: 'ui.chat-settings.computer-help-executor',
    },
    {
      icon: ShieldCheck,
      title: 'ui.chat-settings.computer-help-confirm',
      desc: 'ui.chat-settings.computer-safety-confirm',
    },
    {
      icon: Ban,
      title: 'ui.chat-settings.computer-blocked-apps',
      desc: 'ui.chat-settings.computer-safety-blocked',
    },
    {
      icon: Shield,
      title: 'ui.chat-settings.computer-help-data',
      desc: 'ui.chat-settings.computer-safety-privacy',
    },
    {
      icon: SquareTerminal,
      title: 'ui.providers-schedule.coding-agents',
      desc: 'ui.chat-settings.computer-help-cli',
    },
  ],
  usage: [
    {
      icon: BarChart3,
      title: 'ui.usage-tools.overview',
      desc: 'ui.chat-settings.token-and-cost-totals-trends-breakdowns-and-a',
    },
    {
      icon: ClipboardList,
      title: 'ui.usage-tools.details',
      desc: 'ui.model-quality.per-call-records-for-gateway-request-quality-see',
    },
    {
      icon: Gauge,
      title: 'ui.usage-tools.subscription-quota',
      desc: 'ui.chat-settings.usage-windows-of-each-coding-assistant-s-official',
    },
    {
      icon: ReceiptText,
      title: 'ui.usage-tools.pricing',
      desc: 'ui.chat-settings.set-model-prices-unpriced-models-are-not-counted',
    },
    {
      icon: Wallet,
      title: 'ui.usage-tools.budget-and-privacy',
      desc: 'ui.chat-settings.spending-alert-thresholds-and-usage-record-options',
    },
    {
      icon: FEATURE_ICONS.compare,
      title: 'ui.model-quality.compare',
      desc: 'ui.model-quality.multi-level-table-how-the-same-model-differs',
    },
    {
      icon: BarChart3,
      title: 'ui.usage-tools.trend',
      desc: 'ui.model-quality.success-rate-latency-and-speed-over-time-by',
    },
    {
      icon: ClipboardList,
      title: 'ui.model-quality.request-details',
      desc: 'ui.model-quality.per-request-timeline-outcome-and-fallbacks-the-former',
    },
    {
      icon: Layers,
      title: 'ui.model-quality.two-measurement-layers',
      desc: 'ui.model-quality.the-gateway-layer-covers-requests-through-the-gateway',
    },
  ],
  knowledge: [
    {
      icon: BookOpen,
      title: 'ui.foundation.knowledge-base',
      desc: 'ui.chat-settings.add-folders-they-are-searched-and-cited',
    },
    {
      icon: FEATURE_ICONS.memory,
      title: 'ui.knowledge-local.long-term-memory',
      desc: 'ui.chat-settings.preferences-and-facts-remembered-from-chats-view-and',
    },
    {
      icon: Timer,
      title: 'ui.mascot-theme.schedule-reminders',
      desc: 'ui.chat-settings.reminders-scheduled-tasks-and-proactive-chat',
    },
  ],
  ext: [
    {
      icon: FEATURE_ICONS.ext,
      title: 'ui.foundation.mcp-servers-label',
      desc: 'ui.chat-settings.connect-tool-servers-via-local-commands-or-remote',
    },
    {
      icon: FEATURE_ICONS.skills,
      title: 'ui.foundation.skills-label',
      desc: 'ui.chat-settings.manage-skill-packs-the-assistant-can-use',
    },
  ],
  connections: [
    {
      icon: Plug,
      title: 'ui.providers-schedule.connection-add-github',
      desc: 'ui.providers-schedule.connections-help-github',
    },
    {
      icon: Shield,
      title: 'ui.providers-schedule.connections-help-scopes-title',
      desc: 'ui.providers-schedule.connections-help-scopes',
    },
  ],
  privacy: [
    {
      icon: Shield,
      title: 'ui.chat-settings.privacy-data',
      desc: 'ui.chat-settings.how-data-is-stored-exported-and-cleared',
    },
    {
      icon: Download,
      title: 'ui.knowledge-local.data-export',
      desc: 'ui.chat-settings.export-chats-memory-schedules-and-more-to-local',
    },
  ],
};
