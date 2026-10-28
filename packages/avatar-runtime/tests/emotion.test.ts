import { afterEach, describe, expect, it, vi } from 'vitest';

import { analyzeEmotion, motionForEmotion, StreamEmotionTracker } from '../src/emotion';
import { directiveForEvent, expressionForText } from '../src/expressionDirector';
import { mascotRegistry, type MascotBackend } from '../src/MascotBackend';
import { applyDirective, resetMoodForTests } from '../src/mood';

describe('analyzeEmotion', () => {
  it('detects emotions with intensity', () => {
    expect(analyzeEmotion('太好了！！恭喜你成功了🎉')).toMatchObject({ emotion: 'happy' });
    expect(analyzeEmotion('太好了！！恭喜你成功了🎉').intensity).toBeGreaterThanOrEqual(0.7);
    expect(analyzeEmotion('好的').intensity).toBeLessThan(0.35);
    expect(analyzeEmotion('呜呜，好难过').emotion).toBe('sad');
    expect(analyzeEmotion('气死我了，太过分了！').emotion).toBe('angry');
    expect(analyzeEmotion('天哪，竟然是这样').emotion).toBe('surprised');
    expect(analyzeEmotion('').emotion).toBe('neutral');
    expect(analyzeEmotion('文件已保存在桌面。').emotion).toBe('neutral');
  });

  it('flips negated positive words', () => {
    const r = analyzeEmotion('我今天不开心');
    expect(r).toMatchObject({ emotion: 'sad', negated: true });
    expect(expressionForText('我今天不开心')).toBe('sad');
  });

  it('weights the last sentence more', () => {
    expect(analyzeEmotion('抱歉刚才弄错了。现在修好啦，太棒了！').emotion).toBe('happy');
  });

  it('maps intensity to motions', () => {
    expect(motionForEmotion({ emotion: 'happy', intensity: 0.9, negated: false })).toBe('cheer');
    expect(motionForEmotion({ emotion: 'happy', intensity: 0.5, negated: false })).toBe('clap');
    expect(motionForEmotion({ emotion: 'happy', intensity: 0.2, negated: false })).toBe('nod');
    expect(motionForEmotion({ emotion: 'sad', intensity: 0.9, negated: false })).toBe('bow');
    expect(motionForEmotion({ emotion: 'surprised', intensity: 0.5, negated: false })).toBe(
      'flinch',
    );
    expect(motionForEmotion({ emotion: 'neutral', intensity: 0, negated: false })).toBeUndefined();
  });
});

describe('StreamEmotionTracker', () => {
  it('reacts early once per reply', () => {
    const t = new StreamEmotionTracker();
    expect(t.push('我来')).toBeNull();
    expect(t.push('看看……')).toBeNull();
    expect(t.push('哇！太好了！！')?.emotion).toBe('happy');
    expect(t.push('真的太棒了！')).toBeNull();
    expect(t.finish()?.emotion).toBe('happy');
    expect(t.push('好的')).toBeNull();
  });
});

describe('directives', () => {
  it('strong replies upgrade the motion', () => {
    const d = directiveForEvent({ kind: 'message:complete', text: '成功啦！！太棒了！！🎉' });
    expect(d).toMatchObject({ expression: 'happy', motion: 'cheer' });
  });
  it('interrupt reactions', () => {
    expect(directiveForEvent({ kind: 'barge-in' })).toMatchObject({
      expression: 'surprised',
      motion: 'flinch',
      force: true,
    });
    expect(directiveForEvent({ kind: 'stopped-by-user' })).toMatchObject({
      motion: 'nod',
      force: true,
    });
    expect(directiveForEvent({ kind: 'confirm-required' })?.motion).toBe('interact');
  });
});

describe('applyDirective force', () => {
  afterEach(() => resetMoodForTests());
  it('barge-in bypasses the auto-motion cooldown', () => {
    const playMotion = vi.fn(() => true);
    const detach = mascotRegistry.attach({
      setExpression: vi.fn(),
      playMotion,
    } as unknown as MascotBackend);
    applyDirective({ expression: 'happy', holdMs: 0, motion: 'nod' }, 10_000);
    applyDirective({ expression: 'happy', holdMs: 0, motion: 'clap' }, 11_000);
    applyDirective(directiveForEvent({ kind: 'barge-in' }), 11_500);
    expect(playMotion.mock.calls.map((c: unknown[]) => c[0])).toEqual(['nod', 'flinch']);
    detach();
  });
});
