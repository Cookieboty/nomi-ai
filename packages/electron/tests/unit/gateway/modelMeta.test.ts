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
      maxOutput: 128_000,
      vision: true,
      source: 'catalog',
    });
    expect(resolveModelMeta(undefined, 'anthropic/claude-haiku-4-5:free')).toMatchObject({
      ctx: 200_000,
      source: 'catalog',
    });
  });

  it('400K-class GPT models inject the 272K input limit Codex itself uses, not the 400K total', () => {
    expect(resolveModelMeta(undefined, 'relay/gpt-5.2')).toMatchObject({ ctx: 272_000 });
  });

  it('tiered-price models default to the standard window; long context opens the full input', () => {
    // gpt-6-astra：超过 272K 加价，最大输入 922K（总窗口 1.05M 减去输出预留）
    const std = resolveModelMeta(undefined, 'openai/gpt-6-astra');
    expect(std).toMatchObject({
      ctx: 272_000,
      longContext: { standard: 272_000, full: 922_000, on: false },
    });
    // 标签开启
    expect(
      resolveModelMeta(undefined, 'openai/gpt-6-astra', undefined, { longContext: true }),
    ).toMatchObject({
      ctx: 922_000,
      longContext: { on: true },
    });
    // 模型默认开启；标签可以单独关掉
    const byDefault = { id: 'openai/gpt-6-astra', enabled: true, longContext: true };
    expect(resolveModelMeta(byDefault, byDefault.id)).toMatchObject({ ctx: 922_000 });
    expect(
      resolveModelMeta(byDefault, byDefault.id, undefined, { longContext: false }),
    ).toMatchObject({
      ctx: 272_000,
    });
    // 用户手填了上下文：按手填的，没有标准 / 长之分
    const manual = resolveModelMeta(
      { id: 'gpt-6-astra', enabled: true, ctx: 500_000, metaSource: 'user' },
      'gpt-6-astra',
    );
    expect(manual).toMatchObject({ ctx: 500_000, source: 'user' });
    expect(manual.longContext).toBeUndefined();
    // 没有加价档的模型没有长上下文
    expect(resolveModelMeta(undefined, 'relay/gpt-5.2').longContext).toBeUndefined();
  });

  it('models the vendor entry lags on are filled from OpenRouter (deepseek-v4.1-flash)', () => {
    expect(resolveModelMeta(undefined, 'amux/deepseek/deepseek-v4.1-flash')).toMatchObject({
      ctx: 1_048_576,
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
