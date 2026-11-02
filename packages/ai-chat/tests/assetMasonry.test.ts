import { describe, expect, it } from 'vitest';

import { columnCount, layoutMasonry, ratioOf } from '../src/components/AssetLibrary/masonry';

describe('asset library masonry', () => {
  it('parses aspect hints', () => {
    expect(ratioOf('3:2')).toBe(1.5);
    expect(ratioOf('9:16')).toBeCloseTo(0.5625);
    expect(ratioOf('auto')).toBeNull();
    expect(ratioOf(undefined)).toBeNull();
    expect(ratioOf('0:1')).toBeNull();
  });

  it('fits as many columns as the minimum width allows', () => {
    expect(columnCount(0, 12)).toBe(1);
    expect(columnCount(199, 12)).toBe(1);
    expect(columnCount(412, 12)).toBe(2);
    expect(columnCount(1000, 12)).toBe(4);
  });

  it('keeps each image ratio and fills the shortest column in order', () => {
    // 两列，每列宽 200：竖图 1:2 高 400，横图 2:1 高 100
    const { items, height, columnWidth } = layoutMasonry([0.5, 2, 2, 1], 412, 12);
    expect(columnWidth).toBe(200);
    expect(items[0]).toEqual({ left: 0, top: 0, width: 200, height: 400 });
    expect(items[1]).toEqual({ left: 212, top: 0, width: 200, height: 100 });
    // 第三、四张都进更矮的右列
    expect(items[2]).toMatchObject({ left: 212, top: 112, height: 100 });
    expect(items[3]).toMatchObject({ left: 212, top: 224, height: 200 });
    expect(height).toBe(424);
  });

  it('clamps extreme ratios and adds the caption height', () => {
    const { items } = layoutMasonry([0.05, Number.NaN], 200, 12, 20);
    expect(items[0]!.height).toBe(600 + 20);
    expect(items[1]).toMatchObject({ top: 632, height: 220 });
  });

  it('is empty without items', () => {
    expect(layoutMasonry([], 800, 12).height).toBe(0);
  });
});
