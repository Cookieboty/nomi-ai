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
export function BrandIcon({ brand, name, size = 28, className, fallbackIcon }: BrandIconProps) {
  const icon = brand ? BRAND_ICONS[brand] : undefined;
  const box: React.CSSProperties = { width: size, height: size };
  if (!icon && fallbackIcon) {
    return (
      <span
        className={cx('cd-brand cd-brand--initials', className)}
        style={box}
        aria-hidden
        data-brand="fallback-icon"
      >
        <Icon icon={fallbackIcon} size={Math.round(size * 0.55)} />
      </span>
    );
  }
  if (!icon) {
    return (
      <span
        className={cx('cd-brand cd-brand--initials', className)}
        style={{ ...box, fontSize: Math.round(size * 0.42) }}
        aria-hidden
        data-brand="initials"
      >
        {initials(name)}
      </span>
    );
  }
  const uri = `url("data:image/svg+xml;utf8,${encodeURIComponent(icon.svg)}")`;
  const inner = Math.round(size * 0.62);
  return (
    <span className={cx('cd-brand', className)} style={box} aria-hidden data-brand={brand}>
      <span
        className="cd-brand__glyph"
        style={
          icon.mono
            ? { width: inner, height: inner, maskImage: uri, WebkitMaskImage: uri }
            : { width: inner, height: inner, backgroundImage: uri, backgroundColor: 'transparent' }
        }
      />
    </span>
  );
}
