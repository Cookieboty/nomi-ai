import { describe, expect, it } from 'vitest';

import { createSpriteBackend, type SpriteManifest } from '../src/backends/sprite';

const manifest: SpriteManifest = {
  id: 'test',
  displayName: 'Test',
  style: 'pixel',
  license: 'CC0-1.0',
  author: 'test',
  expressions: {
    neutral: 'neutral.png',
    happy: 'happy.png',
    sad: 'sad.png',
  },
  blink: 'blink.png',
  mouthOpen: 'mouth.png',
  idleBobPx: 2,
  tags: ['sprite', 'pixel'],
};

describe('sprite backend', () => {
  it('swaps expressions and reports caps', () => {
    const b = createSpriteBackend(manifest, 'https://example.test/sprite/');
    expect(b.kind).toBe('sprite');
    b.setExpression('happy');
    const snap = b.snapshot();
    expect(snap.expressionUrl).toContain('happy.png');
    expect(b.capabilities().lipSync).toBe(true);
    expect(b.capabilities().expressions).toContain('happy');
    b.playMotion('wave');
    expect(b.snapshot().expressionUrl).toContain('happy.png');
    b.setMouthOpen(1);
    b.setTalking(true);
    b.update(1 / 30, 1);
    expect(b.snapshot().mouthOpacity).toBeGreaterThan(0.1);
    b.dispose();
  });
});
