/** 素材库的分类（与内核 chatassets.Categories 同序）：生成后自动分，用户可以在查看器里改 */
export const ASSET_CATEGORIES = ['illustration', 'people', 'landscape', 'animal', 'other'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<AssetCategory, string> = {
  illustration: 'ui.media.category-illustration',
  people: 'ui.media.category-people',
  landscape: 'ui.media.category-landscape',
  animal: 'ui.media.category-animal',
  other: 'ui.mascot-theme.role-other',
};

/** 1536 MB → 「1.5 GB」 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 分辨率标签：长边 ≥ 3840 写 4K、≥ 2048 写 2K，否则写像素 */
export function resolutionLabel(w?: number, h?: number): string | null {
  if (!w || !h) return null;
  const long = Math.max(w, h);
  if (long >= 3840) return '4K';
  if (long >= 2048) return '2K';
  return `${w} × ${h}`;
}
