import { presetEntry, resolveModelMeta } from '../../../src/gateway/modelMeta';

describe('resolveModelMeta (§12.7.2)', () => {
  it('picks each field from the highest layer that has it', () => {
    // 用户只填了上下文：输出上限仍按预设
    const r = resolveModelMeta(
      { id: 'glm-5.3', enabled: true, ctx: 50_000, metaSource: 'user' },
      'glm-5.3',
      { id: 'glm-5.3', ctx: 1_000_000, maxOutput: 131_072, reasoning: true },
    );
    expect(r).toMatchObject({
      ctx: 50_000,
      source: 'user',
      maxOutput: 131_072,
      maxOutputSource: 'preset',
      reasoning: true,
    });
  });

  it('a live preset beats values saved from an older preset or the model list', () => {
    const r = resolveModelMeta(
      { id: 'kimi-k3', enabled: true, ctx: 256_000, metaSource: 'preset' },
      'kimi-k3',
      { id: 'kimi-k3', ctx: 1_000_000 },
    );
    expect(r).toMatchObject({ ctx: 1_000_000, source: 'preset' });
    const listed = resolveModelMeta(
      { id: 'x/model', enabled: true, ctx: 256_000, metaSource: 'listed' },
      'x/model',
    );
    expect(listed).toMatchObject({ ctx: 256_000, source: 'listed' });
  });

  it('falls back to the built-in catalog by bare id, ignoring relay tags', () => {
    expect(resolveModelMeta(undefined, 'openai/gpt-6-astra')).toMatchObject({
      ctx: 1_050_000,
      maxOutput: 128_000,
      vision: true,
      source: 'catalog',
    });
    expect(resolveModelMeta(undefined, 'anthropic/claude-haiku-4-5:free')).toMatchObject({
      ctx: 200_000,
      source: 'catalog',
    });
  });

  it('unknown models get conservative defaults and say so', () => {
    expect(resolveModelMeta(undefined, 'acme/mystery')).toMatchObject({
      ctx: 128_000,
      maxOutput: 32_000,
      source: 'default',
      maxOutputSource: 'default',
    });
  });

  it('presetEntry matches the exact id first, then the bare id', () => {
    const list = [
      { id: 'glm-5.3', ctx: 1 },
      { id: 'z-ai/glm-5.3', ctx: 2 },
    ];
    expect(presetEntry(list, 'z-ai/glm-5.3')?.ctx).toBe(2);
    expect(presetEntry(list, 'other/GLM-5.3')?.ctx).toBe(1);
    expect(presetEntry(undefined, 'glm-5.3')).toBeUndefined();
  });
});
