import { IMAGE_MODEL_SPECS, layoutProperties, initialParams } from '@nomi-ai/gateway/media';
import { describe, expect, it } from 'vitest';

import {
  applyStyle,
  DRAFT_KEY,
  estimateProgress,
  hasStyleParam,
  loadDraft,
  saveDraft,
  segmentOptions,
  uploadAllowed,
} from '../src/components/Media/studioModel';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
};

describe('estimateProgress', () => {
  it('queued / running / succeeded', () => {
    expect(estimateProgress({ status: 'queued', createdAt: 0 }, 5000).percent).toBeLessThan(5);
    const early = estimateProgress({ status: 'running', createdAt: 0 }, 500);
    expect(early.stage).toBe(0);
    const mid = estimateProgress({ status: 'running', createdAt: 0 }, 8000);
    expect(mid.stage).toBe(1);
    expect(mid.elapsedSec).toBe(8);
    const late = estimateProgress({ status: 'running', createdAt: 0 }, 600_000);
    expect(late.percent).toBe(95);
    expect(late.stage).toBe(2);
    expect(estimateProgress({ status: 'succeeded', createdAt: 0, finishedAt: 3000 }, 9e9)).toEqual({
      percent: 100,
      stage: 2,
      elapsedSec: 3,
    });
  });
  it('is monotonic while running', () => {
    let prev = 0;
    for (let t = 0; t < 60_000; t += 1000) {
      const p = estimateProgress({ status: 'running', createdAt: 0 }, t).percent;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
});

describe('style template', () => {
  it('appends once, skips empty', () => {
    expect(applyStyle(' 竹林 ', '，水墨')).toBe('竹林，水墨');
    expect(applyStyle('竹林，水墨', '，水墨')).toBe('竹林，水墨');
    expect(applyStyle('竹林', undefined)).toBe('竹林');
    expect(applyStyle('  ', '，水墨')).toBe('');
  });
  it('no built-in spec has a style param (so style is a prompt template)', () => {
    for (const s of IMAGE_MODEL_SPECS) expect(hasStyleParam(s.paramsSchema.properties)).toBe(false);
  });
});

describe('segmentOptions follows the schema', () => {
  it('chips enum and small integer ranges become segments', () => {
    const gpt = IMAGE_MODEL_SPECS.find((s) => s.id === 'gpt-image-1')!;
    const { basic } = layoutProperties(gpt, initialParams(gpt), 'studio');
    const ratio = basic.find((f) => f.key === 'aspect_ratio')!;
    expect(segmentOptions(ratio)).toEqual(ratio.enum);
    const n = basic.find((f) => f.key === 'n')!;
    expect(segmentOptions(n)).toEqual([1, 2, 3, 4]);
    const q = basic.find((f) => f.key === 'quality')!;
    expect(segmentOptions(q)).toBeNull();
  });
});

describe('draft', () => {
  it('round-trips and rejects garbage', () => {
    const s = mem();
    expect(loadDraft(s)).toBeNull();
    saveDraft(
      s,
      { modelId: 'm', providerRef: 'p', prompt: 'x', params: { n: 2 }, style: 'anime' },
      7,
    );
    expect(loadDraft(s)).toEqual({
      modelId: 'm',
      providerRef: 'p',
      prompt: 'x',
      params: { n: 2 },
      style: 'anime',
      savedAt: 7,
    });
    s.setItem(DRAFT_KEY, '{bad');
    expect(loadDraft(s)).toBeNull();
    s.setItem(DRAFT_KEY, JSON.stringify({ modelId: 'm', prompt: 'y', style: 'nope' }));
    expect(loadDraft(s)?.style).toBe('general');
  });
});

it('upload limits', () => {
  expect(uploadAllowed({ type: 'image/png', size: 1 })).toBe(true);
  expect(uploadAllowed({ type: 'image/webp', size: 1 })).toBe(false);
  expect(uploadAllowed({ type: 'image/jpeg', size: 11 * 1024 * 1024 })).toBe(false);
});
