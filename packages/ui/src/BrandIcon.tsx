import type { LucideIcon } from 'lucide-react';
import React from 'react';

import { BRAND_ICONS } from './brand/icons';
import { cx } from './cx';
import { Icon } from './icons';

export interface BrandIconProps {
  /** 品牌 id（见 brand/icons.ts）；未知时回退为首字母 */
  brand?: string;
  /** 回退首字母的来源 */
  name: string;
  size?: number;
  className?: string;
  /** 没有品牌图标时用 lucide 图标代替首字母（如「自定义」） */
  fallbackIcon?: LucideIcon;
  /**
   * 跟文字 / lucide 图标排在一起的小图标（按钮里的「图标 + 模型名」、厂商栏）：不画白底方块，图形与同尺寸的
   * lucide 图标一样大；默认（方块头像）在小尺寸下图形只剩 6 成，看着偏小、和文字对不齐。原色里有黑 / 白的
   * 品牌（inlineMono）按单色跟随文字颜色，换主题也看得见
   */
  inline?: boolean;
}

function initials(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  const cjk = t.match(/[\u4e00-\u9fff]/);
  if (cjk && t.indexOf(cjk[0]) === 0) return cjk[0];
  const words = t.split(/[\s\-_/]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : t.slice(0, 2)).toUpperCase();
}

export function hasBrandIcon(brand?: string): boolean {
  return !!brand && brand in BRAND_ICONS;
}

/**
 * 供应商品牌图标。SVG 来自 @lobehub/icons-static-svg（MIT），以 data URI 渲染（不使用 innerHTML）；
 * 单色图标用 CSS mask 跟随 currentColor。没有图标时显示首字母头像。
 */
export function BrandIcon({
  brand,
  name,
  size = 28,
  className,
  fallbackIcon,
  inline,
}: BrandIconProps) {
  const icon = brand ? BRAND_ICONS[brand] : undefined;
  const box: React.CSSProperties = { width: size, height: size };
  if (!icon && fallbackIcon) {
    return (
      <span
        className={cx('cd-brand', inline ? 'cd-brand--inline' : 'cd-brand--initials', className)}
        style={box}
        aria-hidden
        data-brand="fallback-icon"
      >
        <Icon icon={fallbackIcon} size={inline ? size : Math.round(size * 0.55)} />
      </span>
    );
  }
  if (!icon) {
    return (
      <span
        className={cx('cd-brand cd-brand--initials', className)}
        style={{ ...box, fontSize: Math.round(size * (inline ? 0.56 : 0.42)) }}
        aria-hidden
        data-brand="initials"
      >
        {initials(name)}
      </span>
    );
  }
  const uri = `url("data:image/svg+xml;utf8,${encodeURIComponent(icon.svg)}")`;
  // 行内：与 lucide 图标同样的留白（24 格里画 20 格），同尺寸时看起来一样大
  const inner = Math.round(size * (inline ? 20 / 24 : 0.62));
  const mono = icon.mono || (inline && icon.inlineMono);
  return (
    <span
      className={cx('cd-brand', inline && 'cd-brand--inline', className)}
      style={box}
      aria-hidden
      data-brand={brand}
    >
      <span
        className="cd-brand__glyph"
        style={
          mono
            ? { width: inner, height: inner, maskImage: uri, WebkitMaskImage: uri }
            : { width: inner, height: inner, backgroundImage: uri, backgroundColor: 'transparent' }
        }
      />
    </span>
  );
}
