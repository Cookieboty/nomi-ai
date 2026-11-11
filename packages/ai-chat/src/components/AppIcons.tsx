/**
 * 通用 UI 图标：lucide-react（ISC），统一走 @nomi-ai/ui 的 `Icon`（尺寸 / 线宽 / currentColor 规范）。
 * 供应商品牌仍用 @nomi-ai/ui BrandIcon / EndpointIcon（lobehub 静态 SVG）。
 * 不引入完整 @lobehub/icons React 包（体积大、且品牌已覆盖）。
 *
 * 规范：导航 18、内联 16、空状态 22；strokeWidth 1.75；颜色跟随主题 token，激活项用强调色。
 * 不要在界面里使用 emoji / 字符图形 / 手绘 SVG 当图标。
 */
import { Icon, type ICON_SIZE } from '@nomi-ai/ui';
import {
  Bug,
  AudioLines,
  Bell,
  Link2,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Coins,
  Cpu,
  Info,
  Puzzle,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
  type LucideProps,
  Paperclip,
  AtSign,
  Forward,
  MonitorCog,
  MousePointerClick,
  ListChecks,
  GraduationCap,
  Zap,
  Scale,
} from 'lucide-react';
import React from 'react';

export function AppIcon({
  icon,
  size = 'inline',
  className,
}: {
  icon: LucideIcon;
  /** 数字（px）或预设 nav(18) / inline(16) / empty(22)；默认 16 */
  size?: number | keyof typeof ICON_SIZE;
  className?: string;
}) {
  // 装饰性图标默认 aria-hidden（由 Icon 处理）；需要朗读时请在外层容器加 aria-label
  return <Icon icon={icon} size={size} className={className} />;
}

/** 设置页分区图标（导航 18px；语义见各项注释） */
export const SETTINGS_ICONS = {
  /** 通用：偏好调节 */
  general: SlidersHorizontal,
  /** Nomi：Nomi 自己怎么做事（权限、委派、工具） */
  nomi: Sparkles,
  /** 模型与供应商：第三方供应商、模型分配与本机模型 */
  models: Boxes,
  /** 编程助手：终端 */
  coding: SquareTerminal,
  /** 用量与分析：硬币 */
  usage: Coins,
  /** 知识与记忆：大脑 */
  knowledge: Brain,
  /** 扩展 / MCP：拼图块（插件的通用隐喻） */
  ext: Puzzle,
  /** 应用与账号（GitHub 等账号、本机应用）：链接 */
  connections: Link2,
  /** Computer Use（操作本机应用）：鼠标点击 */
  computer: MousePointerClick,
  /** 隐私与权限：盾牌 */
  privacy: ShieldCheck,
  /** 关于：版本、更新与项目信息 */
  about: Info,
  /** 调试（只在开发版）：虫子 */
  debug: Bug,
} as const;

/** 输入框「更多」菜单等功能入口 */
export const FEATURE_ICONS = {
  kb: BookOpen,
  /** 供应商与模型：与设置「模型与供应商」同一个 */
  model: SETTINGS_ICONS.models,
  settings: Settings,
  voice: AudioLines,
  /** 知识 · 记忆 · 日程 快速视图：大脑（与设置「知识与记忆」一致） */
  hub: Brain,
  /** 扩展 / MCP：与设置分区同一个图标 */
  ext: SETTINGS_ICONS.ext,
  /** 编程助手自己的命令 / Skills / 插件 / MCP / 子代理（只读） */
  cliPlugins: SquareTerminal,
  /** 「+」：添加图片或文件 */
  attach: Paperclip,
  /** 「+」：引用工作区里的文件（@） */
  mention: AtSign,
  /** 「+」：下一条交给编程助手 */
  delegate: Forward,
  /** 桌面能力（让 Nomi 操作电脑）：屏幕 + 齿轮，不和「隐私」的盾牌混用 */
  desktop: MonitorCog,
  local: Cpu,
  notify: Bell,
  /** Agents 看板：派出去的编程助手 */
  agents: Bot,
  /** 任务（对话窗口侧栏、桌面角色工具栏的任务看板） */
  tasks: ListChecks,
  /** 长期记忆 */
  memory: Brain,
  /** 技能（SKILL.md）：学会的本事 */
  skills: GraduationCap,
  /** 权限「自动」模式 */
  autoMode: Zap,
  /** 模型对比 */
  compare: Scale,
} as const;

export type { LucideIcon, LucideProps };
