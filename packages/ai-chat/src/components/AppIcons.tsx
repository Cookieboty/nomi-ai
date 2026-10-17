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
  AudioLines,
  Bell,
  BellRing,
  BookOpen,
  Bot,
  Blocks,
  Brain,
  Coins,
  Cpu,
  Crop,
  Eye,
  Keyboard,
  LibraryBig,
  Monitor,
  PanelTop,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
  type LucideProps,
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
  shortcuts: Keyboard,
  /** 编程助手：终端 */
  coding: SquareTerminal,
  /** 用量与费用：硬币 */
  usage: Coins,
  /** 语音与屏幕：眼睛（Nomi 听你说、看你的屏幕） */
  senses: Eye,
  /** 知识与记忆：大脑 */
  knowledge: Brain,
  /** 日程与日历：响铃 */
  schedule: BellRing,
  /** 通知 / 灵动岛：顶部面板 */
  notify: PanelTop,
  /** 扩展 / MCP：积木模块 */
  ext: Blocks,
  /** 本机管理：芯片（剪贴板 / 数据导出 / 本机小模型） */
  local: Cpu,
  /** 隐私与权限：盾牌 */
  privacy: ShieldCheck,
} as const;

/** 输入框「更多」菜单等功能入口 */
export const FEATURE_ICONS = {
  kb: BookOpen,
  snip: Crop,
  model: Bot,
  settings: Settings,
  voice: AudioLines,
  /** 知识 · 记忆 · 日程 快速视图 */
  hub: LibraryBig,
  screen: Monitor,
  ext: Blocks,
  desktop: ShieldCheck,
  local: Cpu,
  notify: Bell,
} as const;

export type { LucideIcon, LucideProps };
