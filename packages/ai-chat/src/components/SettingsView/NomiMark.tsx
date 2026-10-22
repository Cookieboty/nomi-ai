/**
 * Nomi 品牌标（无底板）：流畅曲线 N + 飘带 + 星光，路径同 docs/brand/nomi-mark.svg。
 * N 用当前文字色（浅色主题为墨色、深色主题为奶油色，见 docs/BRAND.md「Logo」）；飘带与星光保持品牌原色。
 */
import React from 'react';

export const NomiMark: React.FC<{ className?: string; size?: number }> = ({
  className,
  size = 36,
}) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="24 20 216 206"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M84 104 C96 96 112 104 120 128 C128 154 138 188 156 196"
      fill="none"
      stroke="#F7A67C"
      strokeWidth={30}
      strokeLinecap="round"
    />
    <path
      d="M48 200 C48 120 64 70 100 70 C140 70 142 196 180 196 C204 196 214 176 214 150"
      fill="none"
      stroke="currentColor"
      strokeWidth={40}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M200 30 C203 50 210 57 230 60 C210 63 203 70 200 90 C197 70 190 63 170 60 C190 57 197 50 200 30 Z"
      fill="#FB9466"
    />
  </svg>
);
