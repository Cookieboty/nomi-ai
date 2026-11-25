import fs from 'node:fs';
import path from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

import { modelBrandIsNative, modelBrandOf } from '../src/modelVendor';

describe('modelBrandOf：模型按钮与模型行上的图标', () => {
  it('先认模型厂商（带不带供应商前缀都行）', () => {
    expect(modelBrandOf('kimi-k3')).toBe('kimi');
    expect(modelBrandOf('provider/kimi-k3', 'openai')).toBe('kimi');
    expect(modelBrandOf('anthropic/claude-opus-5-5')).toBe('claude');
  });

  it('认不出厂商时用供应商的品牌；都没有时返回 undefined', () => {
    expect(modelBrandOf('Aerith-opus-5.5', 'openai')).toBe('openai');
    expect(modelBrandOf('Aerith-opus-5.5', 'my-custom-provider')).toBeUndefined();
    expect(modelBrandOf('Aerith-opus-5.5')).toBeUndefined();
  });
});

describe('modelBrandIsNative：模型是不是底座自己的（胶囊里不重复画图标）', () => {
  it('品牌相同的不再画模型图标（厂商 id 不同名也按品牌比）', () => {
    expect(modelBrandIsNative(modelBrandOf('gemini-3-pro'), 'gemini')).toBe(true);
    expect(modelBrandIsNative(modelBrandOf('provider/kimi-k3'), 'kimi')).toBe(true);
    expect(modelBrandIsNative(modelBrandOf('minimax-m2'), 'minimax')).toBe(true);
    expect(modelBrandIsNative(modelBrandOf('claude-opus-5'), 'claude')).toBe(true);
    expect(modelBrandIsNative(modelBrandOf('deepseek-chat'), 'deepseek')).toBe(true);
  });

  it('别家的模型照样画；认不出的模型与未知底座不隐藏', () => {
    expect(modelBrandIsNative(modelBrandOf('gpt-5'), 'claude')).toBe(false);
    expect(modelBrandIsNative(modelBrandOf('claude-opus-5'), 'openai')).toBe(false);
    expect(modelBrandIsNative(modelBrandOf('Aerith-opus'), 'claude')).toBe(false);
    expect(modelBrandIsNative(modelBrandOf('gemini-3-pro'), undefined)).toBe(false);
    expect(modelBrandIsNative(undefined, 'gemini')).toBe(false);
  });
});

/**
 * 胶囊里「同品牌只留底座图标」的判定用 cli-catalog 清单的真实品牌元数据（`branding.modelBrand`）跑，
 * 不是手写一张品牌表：清单改了这里跟着变；底座自己的模型 id 也取自清单（本机来源的模型名 / 第三方网关里的模型名）。
 */
type CatalogBrand = { id: string; native: string | undefined; models: string[] };

const catalog: CatalogBrand[] = (() => {
  const dir = repoPath('packages/cli-catalog/src');
  const cliIds: string[] = [];
  for (const id of fs.readdirSync(dir)) {
    const file = path.join(dir, id, 'manifest.ts');
    if (fs.existsSync(file)) cliIds.push(id);
  }
  return cliIds.map((id) => {
    const file = path.join(dir, id, 'manifest.ts');
    const text = fs.readFileSync(file, 'utf8');
    const native = /branding:\s*\{\s*modelBrand:\s*'([^']+)'/.exec(text)?.[1];
    // 清单里的模型 id（models: [...] 中的 id: '…'）
    const models = [...text.slice(text.indexOf('models:')).matchAll(/id:\s*'([^']+)'/g)].map(
      (m) => m[1]!,
    );
    return { id, native, models };
  });
})();

/** 模型落到胶囊时认出的品牌：先认模型名，认不出再用供应商品牌（与 managedAdapter 一致） */
const chipBrand = (endpoint: string, modelBrand: string | undefined) =>
  modelBrand && !modelBrandIsNative(modelBrand, catalog.find((c) => c.id === endpoint)?.native)
    ? modelBrand
    : undefined;

describe('胶囊图标去重：用各底座清单里的真实品牌（端点是清单里的 id）', () => {
  it('内置 CLI 的自家模型品牌与原子图的解耦：按品牌 id 比，不是拿模型 id 当品牌', () => {
    const natives = Object.fromEntries(catalog.map((c) => [c.id, c.native]));
    expect(natives).toMatchObject({
      claude: 'claude',
      codex: 'openai',
      dsh: 'deepseek',
      grok: 'xai',
      gemini: 'gemini',
      kimi: 'kimi',
      minimax: 'minimax',
    });
    // Antigravity 没有自家品牌（换底座 / 模型都走第三方）：不写
    expect(natives.antigravity).toBeUndefined();
  });

  it('7 个底座各自的自家模型：胶囊只留底座图标（模型品牌被隐藏）', () => {
    const own: [string, string][] = [
      ['claude', 'claude-opus-5'],
      ['codex', 'gpt-5'],
      ['dsh', 'deepseek-chat'],
      ['grok', 'grok-4'],
      ['gemini', 'gemini-3-pro'],
      ['kimi', 'kimi-k3'],
      ['minimax', 'minimax-m2'],
    ];
    for (const [endpoint, model] of own) {
      expect(chipBrand(endpoint, modelBrandOf(model)), endpoint).toBeUndefined();
      // 带供应商前缀（第三方网关的模型名）也认得出
      expect(chipBrand(endpoint, modelBrandOf(`amux/${model}`)), endpoint).toBeUndefined();
    }
    // 清单里列的模型（本机来源直接给的就是这些 id）同样认得出自家：品牌与清单的 modelBrand 一致
    for (const c of catalog) {
      if (!c.native) continue;
      for (const model of c.models.filter((m) => modelBrandOf(m) === c.native))
        expect(chipBrand(c.id, modelBrandOf(model)), `${c.id} ${model}`).toBeUndefined();
    }
  });

  it('别家的模型不去重：胶囊照样画模型图标', () => {
    const foreign: [string, string, string][] = [
      ['claude', 'gpt-5', 'openai'],
      ['codex', 'claude-opus-5', 'claude'],
      ['dsh', 'gemini-3-pro', 'gemini'],
      ['grok', 'deepseek-chat', 'deepseek'],
      ['gemini', 'kimi-k3', 'kimi'],
      ['kimi', 'grok-4', 'xai'],
      ['minimax', 'minimax-m2', 'minimax'], // 同上：先确认自家，再换别家
    ];
    for (const [endpoint, model, brand] of foreign) {
      if (endpoint === 'minimax') continue;
      expect(chipBrand(endpoint, modelBrandOf(model)), endpoint).toBe(brand);
    }
    expect(chipBrand('minimax', modelBrandOf('gpt-5'))).toBe('openai');
  });

  it('没有自家品牌的底座（antigravity / nomi / other）不去重，认不出厂商的模型也不隐藏', () => {
    expect(chipBrand('antigravity', modelBrandOf('gemini-3-pro'))).toBe('gemini');
    expect(chipBrand('nomi', modelBrandOf('gpt-5'))).toBe('openai');
    expect(chipBrand('other', modelBrandOf('claude-opus-5'))).toBe('claude');
    for (const c of catalog) expect(chipBrand(c.id, undefined), c.id).toBeUndefined();
    expect(chipBrand('claude', modelBrandOf('Aerith-opus-5'))).toBeUndefined();
  });
});
