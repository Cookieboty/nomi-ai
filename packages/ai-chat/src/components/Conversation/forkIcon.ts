/**
 * 「分叉」图标：lucide 的 Split 顺时针转 90°——从左边进来，分成右上、右下两支箭头。
 * 路径按 (x, y) → (24 − y, x) 换算，线宽、尺寸与其他 lucide 图标一致。
 */
import { createLucideIcon } from 'lucide-react';

export const ForkRight = createLucideIcon('fork-right', [
  ['path', { d: 'M21 16v5h-5', key: 'fr1' }],
  ['path', { d: 'M21 8V3h-5', key: 'fr2' }],
  ['path', { d: 'M2 12h8.3a4 4 0 0 0 2.872-1.172L21 3', key: 'fr3' }],
  ['path', { d: 'm15 15 6 6', key: 'fr4' }],
]);
