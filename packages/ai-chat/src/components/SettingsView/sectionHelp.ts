import {
  Activity,
  AppWindow,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  CalendarDays,
  ClipboardList,
  Cpu,
  Download,
  FolderLock,
  Gauge,
  Globe,
  Keyboard,
  Layers,
  Mic,
  MonitorSmartphone,
  NotebookPen,
  Plug,
  ReceiptText,
  Shield,
  Sparkles,
  SquareTerminal,
  Timer,
  Wallet,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';

import type { SettingsSection } from './sections';

/** 右侧「配置说明」：每个分区里有哪些卡片 / 标签、各自做什么（文案为 i18n key）。 */
export interface HelpItem {
  icon: LucideIcon;
  title: string;
  desc: string;
}

export const SECTION_HELP: Record<Exclude<SettingsSection, 'general'>, HelpItem[]> = {
  shortcuts: [
    {
      icon: Keyboard,
      title: 'ui.chat-settings.in-app-shortcuts',
      desc: 'ui.chat-settings.key-combos-in-the-chat-window-rebindable-with',
    },
    {
      icon: Globe,
      title: 'ui.chat-settings.global-shortcuts',
      desc: 'ui.chat-settings.system-wide-hotkeys-that-work-even-when-nomi',
    },
  ],
  models: [
    {
      icon: Waypoints,
      title: 'ui.models.assignments',
      desc: 'ui.chat-settings.choose-the-models-for-nomi-chat-tool-calls',
    },
    {
      icon: SquareTerminal,
      title: 'ui.providers-schedule.coding-agents',
      desc: 'ui.chat-settings.models-each-coding-assistant-uses-in-third-party',
    },
    {
      icon: Boxes,
      title: 'ui.models.third-party-providers',
      desc: 'ui.chat-settings.add-providers-and-keys-nomi-converts-protocols-automatically',
    },
    {
      icon: SquareTerminal,
      title: 'ui.models.terminal-commands',
      desc: 'ui.chat-settings.launch-coding-assistants-with-third-party-models-from',
    },
  ],
  quality: [
    {
      icon: Gauge,
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
  coding: [
    {
      icon: AppWindow,
      title: 'ui.providers-schedule.assistants',
      desc: 'ui.providers-schedule.pick-the-coding-assistant-to-view-the-picker',
    },
    {
      icon: Download,
      title: 'ui.chat-settings.version-accounts',
      desc: 'ui.chat-settings.detect-install-or-update-clis-and-manage-official',
    },
    {
      icon: Activity,
      title: 'ui.cli-monitor.monitor-sessions',
      desc: 'ui.chat-settings.progress-monitoring-and-active-sessions-of-local-coding',
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
  ],
  senses: [
    {
      icon: Mic,
      title: 'ui.chat-settings.voice',
      desc: 'ui.chat-settings.voice-input-read-aloud-voice-and-hands-free',
    },
    {
      icon: MonitorSmartphone,
      title: 'ui.chat-settings.screen',
      desc: 'ui.chat-settings.screenshot-questions-the-screenshot-hotkey-and-screen-memory',
    },
  ],
  knowledge: [
    {
      icon: BookOpen,
      title: 'ui.foundation.knowledge-base',
      desc: 'ui.chat-settings.add-folders-and-notes-they-are-searched-and',
    },
    {
      icon: Sparkles,
      title: 'ui.knowledge-local.long-term-memory',
      desc: 'ui.chat-settings.preferences-and-facts-remembered-from-chats-view-and',
    },
    {
      icon: NotebookPen,
      title: 'ui.foundation.notes',
      desc: 'ui.chat-settings.your-local-markdown-notes',
    },
  ],
  schedule: [
    {
      icon: Timer,
      title: 'ui.mascot-theme.schedule-reminders',
      desc: 'ui.chat-settings.reminders-scheduled-tasks-and-proactive-chat',
    },
    {
      icon: CalendarDays,
      title: 'ui.chat-settings.calendar-sources',
      desc: 'ui.chat-settings.system-calendar-ics-and-caldav-events-feed-the',
    },
  ],
  notify: [
    {
      icon: Bell,
      title: 'ui.mascot-theme.dynamic-island-notifications',
      desc: 'ui.chat-settings.how-you-are-alerted-when-a-coding-assistant',
    },
  ],
  ext: [
    {
      icon: Plug,
      title: 'ui.foundation.mcp-servers-label',
      desc: 'ui.chat-settings.connect-tool-servers-via-local-commands-or-remote',
    },
    {
      icon: Layers,
      title: 'ui.foundation.skills-label',
      desc: 'ui.chat-settings.manage-skill-packs-the-assistant-can-use',
    },
  ],
  local: [
    {
      icon: ClipboardList,
      title: 'ui.knowledge-local.clipboard',
      desc: 'ui.chat-settings.clipboard-history-on-this-machine',
    },
    {
      icon: Download,
      title: 'ui.knowledge-local.data-export',
      desc: 'ui.chat-settings.export-chats-memory-schedules-and-more-to-local',
    },
    {
      icon: Cpu,
      title: 'ui.knowledge-local.local-models',
      desc: 'ui.knowledge-local.built-in-llama-cpp-local-models-plus-optional',
    },
  ],
  privacy: [
    {
      icon: Shield,
      title: 'ui.chat-settings.privacy-data',
      desc: 'ui.chat-settings.how-data-is-stored-exported-and-cleared',
    },
    {
      icon: FolderLock,
      title: 'ui.chat-settings.desktop-permissions',
      desc: 'ui.chat-settings.accessible-folders-available-tools-and-the-action-log',
    },
  ],
};
