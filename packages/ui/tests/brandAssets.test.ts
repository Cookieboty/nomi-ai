import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { ENDPOINT_GLYPHS } from '../src/brand/endpointGlyphs';
import { BRAND_ICONS } from '../src/brand/icons';

describe('shared brand assets', () => {
  it('covers every provider preset that declares a brand icon', () => {
    const presets = JSON.parse(
      fs.readFileSync(repoPath('apps/desktop-go/internal/ai/providers/presets_gen.json'), 'utf8'),
    ) as { icon?: string }[];
    for (const preset of presets) {
      if (preset.icon) expect(BRAND_ICONS[preset.icon]?.svg).toContain('<svg');
    }
  });

  it('ships the same product artwork in the chat and standalone island', () => {
    const html = fs.readFileSync(
      repoPath('apps/desktop-go/internal/core/island/island.html'),
      'utf8',
    );
    const island = JSON.parse(html.match(/const EP = JSON\.parse\(\s*String\.raw`([^`]+)`/)![1]!);
    for (const [endpoint, glyph] of Object.entries(ENDPOINT_GLYPHS)) {
      if (glyph.brand)
        expect(island[endpoint]).toEqual(BRAND_ICONS[glyph.colorBrand ?? glyph.brand]);
    }
    expect(BRAND_ICONS.claudecode!.svg).not.toBe(BRAND_ICONS.claude!.svg);
    expect(BRAND_ICONS.codex!.svg).not.toBe(BRAND_ICONS.openai!.svg);
    expect(BRAND_ICONS.grok!.svg).not.toBe(BRAND_ICONS.xai!.svg);
    expect(BRAND_ICONS.geminicli!.svg).not.toBe(BRAND_ICONS.gemini!.svg);
  });

  it('keeps brand gradients and has no active or remote SVG content', () => {
    expect(BRAND_ICONS.gemini!.svg).toContain('<linearGradient');
    expect(BRAND_ICONS.minimax!.svg).toContain('<linearGradient');
    for (const icon of Object.values(BRAND_ICONS)) {
      expect(icon.svg).not.toMatch(/<(script|foreignObject)|\bon\w+=|https?:\/\/(?!www\.w3\.org)/i);
    }
  });
});
