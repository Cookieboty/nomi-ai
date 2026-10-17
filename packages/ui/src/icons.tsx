/**
 * 通用 UI 图标规范：lucide-react（ISC）。供应商 / 模型厂商图标仍用 BrandIcon / EndpointIcon（lobehub 静态 SVG）。
 *
 * - 尺寸：导航 18、内联（按钮 / 标签 / 菜单项）16、空状态 22；
 * - 线宽统一 1.75；颜色一律 currentColor（跟随主题 token，激活项由容器切换为强调色）；
 * - 不再使用 emoji、字符图形（✕ ⚠ ✓ ▸ …）和手绘 SVG 充当图标。
 */
import type { LucideIcon } from 'lucide-react';
import React from 'react';

export const ICON_SIZE = { nav: 18, inline: 16, empty: 22 } as const;
export const ICON_STROKE = 1.75;

export interface IconProps {
  icon: LucideIcon;
  /** 数字（px）或预设 `nav` / `inline` / `empty`；默认 inline(16) */
  size?: number | keyof typeof ICON_SIZE;
  className?: string;
  /** 默认装饰性（aria-hidden）；传 label 则作为独立图标暴露给读屏 */
  label?: string;
}

export function Icon({ icon: Glyph, size = 'inline', className, label }: IconProps) {
  const px = typeof size === 'number' ? size : ICON_SIZE[size];
  return (
    <Glyph
      width={px}
      height={px}
      strokeWidth={ICON_STROKE}
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    />
  );
}
