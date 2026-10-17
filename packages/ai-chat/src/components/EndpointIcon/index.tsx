/**
 * 端点图标：Nomi（应用图标）/ Claude Code（星芒）/ Codex（OpenAI 标志）/ dsh（DeepSeek 鲸鱼标志）/ Grok（xAI 标志）。
 * 数据与许可见 @nomi-ai/ui 的 brand/endpointGlyphs.ts（lobe-icons MIT；商标归各自所有者，仅作指示性使用）。
 * 名称通过 aria-label + 悬停提示给出。颜色与灵动岛（electron/src/island/islandPage.ts）保持一致。
 */
import { ENDPOINT_BRAND_COLOR, ENDPOINT_GLYPHS, t } from '@nomi-ai/ui';
import React from 'react';

import type { ConversationBackend } from '../../types/chat';
import { ENDPOINT_NAME } from '../../utils/endpointBadge';

export const ENDPOINT_COLOR: Record<ConversationBackend, string> = ENDPOINT_BRAND_COLOR;

export const EndpointIcon: React.FC<{
  backend: ConversationBackend;
  size?: number;
  /** 旁边已有文字名称时设为 true：不再重复朗读 / 提示 */
  decorative?: boolean;
  className?: string;
}> = ({ backend, size = 16, decorative = false, className }) => {
  const name = t(ENDPOINT_NAME[backend]);
  const glyph = ENDPOINT_GLYPHS[backend];
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      data-testid={`endpoint-icon-${backend}`}
      data-endpoint={backend}
      style={{ flexShrink: 0 }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
    >
      {!decorative && <title>{name}</title>}
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
      {glyph.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          transform={p.transform}
          fill={p.fill ?? 'none'}
          {...(p.stroke
            ? {
                stroke: p.stroke,
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
