import { IMAGE_MODEL_SPECS, layoutProperties, initialParams } from '@nomi-ai/gateway/media';
import { describe, expect, it } from 'vitest';

import {
  applyStyle,
  DRAFT_KEY,
  estimateProgress,
  hasStyleParam,
  loadDraft,
  queueView,
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

  it('Seedream n (API 1-15) declares segmented with uiMax 4 → 1/2/3/4', () => {
    const sd = IMAGE_MODEL_SPECS.find((s) => s.id === 'seedream-4')!;
    const n = layoutProperties(sd, initialParams(sd), 'studio').basic.find((f) => f.key === 'n')!;
    expect(n.maximum).toBe(15);
    expect(segmentOptions(n)).toEqual([1, 2, 3, 4]);
  });

  it('integer range ≤ 6 segments, larger range stays a slider unless declared', () => {
    const field = (maximum: number, ui: Record<string, unknown> = {}) =>
      ({
        key: 'n',
        type: 'integer',
        minimum: 1,
        maximum,
        'x-ui': { control: 'stepper', label: 'x', order: 1, ...ui },
      }) as unknown as Parameters<typeof segmentOptions>[0];
    expect(segmentOptions(field(6))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(segmentOptions(field(7))).toBeNull();
    expect(segmentOptions(field(15))).toBeNull();
    expect(segmentOptions(field(15, { widget: 'segmented' }))).toBeNull();
    expect(segmentOptions(field(15, { widget: 'segmented', uiMax: 3 }))).toEqual([1, 2, 3]);
    expect(segmentOptions(field(2, { widget: 'segmented', uiMax: 4 }))).toEqual([1, 2]);
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

describe('queueView', () => {
  const task = (
    id: string,
    status: 'queued' | 'running' | 'succeeded' | 'failed',
    createdAt: number,
  ) => ({
    id,
    status,
    createdAt,
  });
  it('生成中、排队中按提交顺序在前，再接最近结束的任务，总数受限', () => {
    // 新的在前
    const tasks = [
      task('q2', 'queued', 6),
      task('q1', 'queued', 5),
      task('r2', 'running', 4),
      task('r1', 'running', 3),
      task('f', 'failed', 2),
      task('d', 'succeeded', 1),
      task('old', 'succeeded', 0),
    ];
    expect(queueView(tasks).map((x) => x.id)).toEqual(['r1', 'r2', 'q1', 'q2', 'f', 'd']);
    expect(queueView(tasks, 3).map((x) => x.id)).toEqual(['r1', 'r2', 'q1', 'q2']);
    expect(queueView([])).toEqual([]);
  });
});
