import { describe, expect, it } from 'vitest';

import { modelBrandOf } from '../src/modelVendor';

describe('modelBrandOf：模型按钮与模型行上的图标', () => {
  it('先认模型厂商（带不带供应商前缀都行）', () => {
    expect(modelBrandOf('kimi-k3')).toBe('kimi');
    expect(modelBrandOf('provider/kimi-k3', 'openai')).toBe('kimi');
    expect(modelBrandOf('anthropic/claude-opus-5-5')).toBe('anthropic');
  });

  it('认不出厂商时用供应商的品牌；都没有时返回 undefined', () => {
    expect(modelBrandOf('Aerith-opus-5.5', 'openai')).toBe('openai');
    expect(modelBrandOf('Aerith-opus-5.5', 'my-custom-provider')).toBeUndefined();
    expect(modelBrandOf('Aerith-opus-5.5')).toBeUndefined();
  });
});
