/**
 * 端点图标：Nomi 自有图形，其余使用 LobeHub 中对应的产品标识。
 * 产品与供应商共用 BrandIcon 的静态 SVG 数据，保留原色、渐变及深浅主题适配。
 * 名称通过 aria-label + 悬停提示给出。颜色与灵动岛（apps/desktop-go/internal/core/island/island.html）保持一致。
 */
import { BrandIcon, ENDPOINT_BRAND_COLOR, ENDPOINT_GLYPHS, t } from '@nomi-ai/ui';
import React from 'react';

import { ENDPOINT_NAME, type EndpointKey } from '../../utils/endpointBadge';

/** other（非内置的 agent）用通用终端图标 */
const glyphKey = (b: EndpointKey) => (b === 'other' ? 'external' : b);

export const ENDPOINT_COLOR: Record<EndpointKey, string> = {
  ...ENDPOINT_BRAND_COLOR,
  other: ENDPOINT_BRAND_COLOR.external,
};

export const EndpointIcon: React.FC<{
  backend: EndpointKey;
  size?: number;
  /** 旁边已有文字名称时设为 true：不再重复朗读 / 提示 */
  decorative?: boolean;
  className?: string;
  /** mark：透明图形；color：优先彩色品牌图形，同样不加背景。 */
  variant?: 'tile' | 'mark' | 'color';
}> = ({ backend, size = 16, decorative = false, className, variant = 'color' }) => {
  const name = t(ENDPOINT_NAME[backend]);
  const glyph = ENDPOINT_GLYPHS[glyphKey(backend)];
  const mark = variant !== 'tile';
  if (glyph.brand) {
    return (
      <span
        className={className}
        data-testid={`endpoint-icon-${backend}`}
        data-endpoint={backend}
        style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }}
        {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
      >
        <BrandIcon brand={glyph.colorBrand ?? glyph.brand} name={name} size={size} inline={mark} />
      </span>
    );
  }
  const ink = (color: string | undefined) => {
    if (!mark) return color;
    if (color === '#fff' || color === '#ffffff') {
      return glyph.markInk ?? 'currentColor';
    }
    return backend === 'nomi' && color === '#33291F' ? 'currentColor' : color;
  };
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={mark ? '2 2 12 12' : '0 0 16 16'}
      data-testid={`endpoint-icon-${backend}`}
      data-endpoint={backend}
      style={{ flexShrink: 0 }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {!decorative && <title>{name}</title>}
      {!mark && (
        <rect
          width="16"
          height="16"
          rx="4"
          fill={glyph.tile}
          {...(glyph.tileStroke
            ? {
                stroke: glyph.tileStroke,
                strokeWidth: 0.6,
                width: 15.4,
                height: 15.4,
                x: 0.3,
                y: 0.3,
              }
            : {})}
        />
      )}
      {glyph.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          transform={p.transform}
          fill={ink(p.fill) ?? 'none'}
          {...(p.stroke
            ? {
                stroke: ink(p.stroke),
                strokeWidth: p.strokeWidth,
                strokeLinecap: 'round' as const,
                strokeLinejoin: 'round' as const,
              }
            : {})}
        />
      ))}
    </svg>
  );
};
