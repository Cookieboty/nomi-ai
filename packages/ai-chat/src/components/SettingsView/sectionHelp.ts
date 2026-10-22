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
    { icon: Keyboard, title: '应用内快捷键', desc: '对话窗里的组合键，可改绑，冲突会提示。' },
    { icon: Globe, title: '全局快捷键', desc: '系统级快捷键，Nomi 不在前台也能触发。' },
  ],
  models: [
    { icon: Waypoints, title: '分配', desc: '选择 Nomi 对话、工具调用和摘要用的模型。' },
    {
      icon: SquareTerminal,
      title: '编程助手',
      desc: '各编程助手选「第三方」时用的模型，以及新标签默认用哪种。',
    },
    { icon: Boxes, title: '第三方供应商', desc: '添加供应商与 Key，Nomi 自动转换协议。' },
    { icon: SquareTerminal, title: '终端启动命令', desc: '在终端里用第三方模型启动编程助手。' },
  ],
  coding: [
    { icon: AppWindow, title: '助手', desc: '选择要查看的编程助手，选择条上显示安装状态。' },
    { icon: Download, title: '版本与账号', desc: '检测、安装或更新 CLI，管理官方账号登录。' },
    { icon: Activity, title: '监视与会话', desc: '本机编程助手的进度监视与活跃会话。' },
  ],
  usage: [
    { icon: BarChart3, title: '概览', desc: 'Token、费用的汇总、趋势、分布和全年热力图。' },
    { icon: ClipboardList, title: '明细与最近请求', desc: '逐条调用记录与网关最近的请求。' },
    { icon: Gauge, title: '订阅额度', desc: '查看各编程助手官方订阅的用量窗口。' },
    { icon: ReceiptText, title: '价格', desc: '为模型设置单价，未定价的模型不计入费用。' },
    { icon: Wallet, title: '预算与隐私', desc: '设置花费提醒线与用量记录相关选项。' },
  ],
  senses: [
    { icon: Mic, title: '语音', desc: '语音输入、朗读声音与免按键对话。' },
    { icon: MonitorSmartphone, title: '屏幕', desc: '截图提问、截图快捷键与屏幕记忆。' },
  ],
  knowledge: [
    { icon: BookOpen, title: '知识库', desc: '加入文件夹和笔记，提问时检索并标出引用。' },
    { icon: Sparkles, title: '长期记忆', desc: '从对话中记住的偏好与事实，可查看与管理。' },
    { icon: NotebookPen, title: '笔记', desc: '本地 Markdown 笔记库。' },
  ],
  schedule: [
    { icon: Timer, title: '日程提醒', desc: '提醒、定时任务和主动聊天。' },
    { icon: CalendarDays, title: '日历接入', desc: '系统日历、.ics 与 CalDAV，日程进入每日简报。' },
  ],
  notify: [{ icon: Bell, title: '灵动岛通知', desc: '编程助手完成、待确认或出错时的提醒方式。' }],
  ext: [
    { icon: Plug, title: 'MCP 服务器', desc: '接入本地命令或远程 HTTP / SSE 的工具服务。' },
    { icon: Layers, title: '技能', desc: '管理可被助手调用的技能包。' },
  ],
  local: [
    { icon: ClipboardList, title: '剪贴板', desc: '本机剪贴板历史。' },
    { icon: Download, title: '数据导出', desc: '把聊天、记忆、日程等导出到本机文件。' },
    { icon: Cpu, title: '本机模型', desc: '内置 llama.cpp 本地模型，以及可选的 Ollama。' },
  ],
  privacy: [
    { icon: Shield, title: '隐私与数据', desc: '数据怎么存、怎么导出和清除。' },
    { icon: FolderLock, title: '桌面权限', desc: '可访问的文件夹、可用的工具与操作记录。' },
  ],
};
