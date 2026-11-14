import { IconDots as Ellipsis } from '@tabler/icons-react';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { BrandIcon } from '../src/BrandIcon';

afterEach(cleanup);

const glyph = (c: HTMLElement) => c.querySelector<HTMLElement>('.cd-brand__glyph')!;

describe('BrandIcon inline：和文字排在一行的小图标', () => {
  it('不画方块底，图形占满大部分边长（默认方块里只占 6 成）', () => {
    const { container: tile } = render(<BrandIcon brand="openai" name="OpenAI" size={14} />);
    expect(glyph(tile).style.width).toBe('9px');
    cleanup();
    const { container } = render(<BrandIcon brand="openai" name="OpenAI" size={14} inline />);
    expect(container.querySelector('.cd-brand--inline')).toBeTruthy();
    expect(glyph(container).style.width).toBe('12px');
  });

  it('Kimi 的 K 跟随主题文字色，蓝色圆点保留原色', () => {
    const { container: tile } = render(<BrandIcon brand="kimi" name="Kimi" size={14} />);
    expect(glyph(tile).style.maskImage).toContain('data:image/svg+xml');
    cleanup();
    const { container } = render(<BrandIcon brand="kimi" name="Kimi" size={14} inline />);
    expect(glyph(container).style.backgroundImage).toBe('');
    expect(glyph(container).style.maskImage || glyph(container).style.webkitMaskImage).toContain(
      'data:image/svg+xml',
    );
    const accent = container.querySelectorAll<HTMLElement>('.cd-brand__glyph')[1]!;
    expect(decodeURIComponent(accent.style.backgroundImage)).toContain('#1783FF');
    expect(decodeURIComponent(accent.style.backgroundImage)).toContain('fill="transparent"');
  });

  it('没有品牌图标时：行内的备用 Tabler 图标与尺寸同大，不缩进方块里', () => {
    const { container } = render(
      <BrandIcon name="其他" size={16} inline fallbackIcon={Ellipsis} />,
    );
    expect(container.querySelector('.cd-brand--inline')).toBeTruthy();
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('16');
  });
});
