/**
 * 模型质量的多级对比表（docs/design/model-quality.md §3、§5）：模型族 → 供应商 → Key 的树、
 * 计数列按尝试 / 其余按请求、客户端错误、输入长度分位数、厂商与显示名、筛选项。
 */
import type { QualityRecord } from '@nomi-ai/types';

import { facetsOf, listRequests, queryQuality } from '../../../src/usage/quality/aggregate';
import { officialProviderName, prettyModel, vendorOf } from '../../../src/usage/quality/modelNames';

const T0 = new Date(2026, 9, 24, 10, 0, 0).getTime();
let seq = 0;
function rec(o: Partial<QualityRecord> = {}): QualityRecord {
  return {
    id: `t${++seq}`,
    layer: 'gateway',
    ts: T0 + seq * 1000,
    client: 'claude',
    source: 'thirdParty',
    provider: 'amux',
    keyId: 'k1',
    model: 'amux/openai/gpt-6.1-sol',
    stream: true,
    outcome: 'ok',
    status: 200,
    timing: { headersMs: 200, firstContentMs: 1000, lastContentMs: 2000, endMs: 2100 },
    tokens: { input: 100, output: 101, cacheRead: 300 },
    ...o,
  };
}
const q = (o: Partial<Parameters<typeof queryQuality>[1]> = {}) => ({
  from: T0,
  to: T0 + 86_400_000,
  ...o,
});

describe('模型名与厂商', () => {
  it('模型族 → 厂商（品牌）与好读的名字', () => {
    expect(vendorOf('gpt-6.1-sol')).toEqual({ name: 'OpenAI', brand: 'openai' });
    expect(vendorOf('o3-mini')?.name).toBe('OpenAI');
    expect(vendorOf('claude-opus-5.5')?.name).toBe('Anthropic');
    expect(vendorOf('gemini-3.8-flash')?.name).toBe('Google');
    expect(vendorOf('deepseek-v4.1-flash')?.name).toBe('DeepSeek');
    expect(vendorOf('glm-5.3-flash')?.name).toBe('Z.ai');
    expect(vendorOf('grok-4.6')?.name).toBe('xAI');
    expect(vendorOf('kimi-k2')?.name).toBe('Moonshot');
    expect(vendorOf('qwen3-coder')?.name).toBe('Qwen');
    expect(vendorOf('minimax-m2')?.name).toBe('MiniMax');
    expect(vendorOf('my-own-model')).toBeUndefined();
    expect(vendorOf(undefined)).toBeUndefined();
    expect(prettyModel('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(prettyModel('deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash');
    expect(prettyModel('claude-opus-5.5')).toBe('Claude Opus 5.5');
    expect(prettyModel('glm-5.3-flash')).toBe('GLM-5.3 Flash');
    expect(prettyModel('gemini-3.8-flash')).toBe('Gemini 3.8 Flash');
    expect(prettyModel('o3-mini')).toBe('o3 mini');
    expect(officialProviderName('anthropic')).toBe('Anthropic');
    expect(officialProviderName('amux')).toBeUndefined();
  });
});

describe('多级分组（groupPath）', () => {
  const data = () => [
    // gpt-6.1-sol：amux 两个 Key + azure 官方
    rec({ keyId: 'k1' }),
    rec({ keyId: 'k1', outcome: 'stream-break' }),
    rec({ keyId: 'k2', outcome: 'request-rejected', status: 400 }),
    rec({ provider: 'azure', keyId: 'az', model: 'azure/gpt-6.1-sol' }),
    // 回退：amux k1 限流 → azure 成功
    rec({
      provider: 'azure',
      keyId: 'az',
      model: 'azure/gpt-6.1-sol',
      attempts: [
        {
          provider: 'amux',
          keyId: 'k1',
          model: 'amux/openai/gpt-6.1-sol',
          outcome: 'rate-limit',
          status: 429,
          ms: 40,
        },
        {
          provider: 'azure',
          keyId: 'az',
          model: 'azure/gpt-6.1-sol',
          outcome: 'ok',
          status: 200,
          ms: 2100,
        },
      ],
    }),
    // 另一个模型
    rec({ model: 'amux/deepseek/deepseek-v4.1-flash', client: 'codex' }),
  ];

  it('树的每一级都按总数降序，子级加起来等于父级；模型行带厂商与显示名', () => {
    const r = queryQuality(
      data(),
      q({ groupPath: ['modelFamily', 'provider', 'key'], countBy: 'attempt' }),
    );
    expect(r.groups.map((g) => g.key)).toEqual(['gpt-6.1-sol', 'deepseek-v4.1-flash']);
    const gpt = r.groups[0]!;
    expect(gpt).toMatchObject({
      dim: 'modelFamily',
      vendor: 'OpenAI',
      display: 'GPT-6.1 Sol',
      // 尝试：k1 ×2 + 回退前 k1 限流 + k2 + azure ×2 = 6
      total: 6,
      requests: 5,
      ok: 3,
      clientErrors: 1,
      // 断流 + 限流；客户端错误不算失败
      failed: 2,
      streamBreak: 1,
    });
    expect(gpt.children!.map((c) => c.key)).toEqual(['amux', 'azure']);
    const amux = gpt.children![0]!;
    expect(amux).toMatchObject({ dim: 'provider', tag: 'thirdParty', total: 4, failed: 2 });
    expect(amux.children!.map((c) => c.label)).toEqual(['k1', 'k2']);
    expect(amux.children![0]).toMatchObject({ dim: 'key', total: 3, ok: 1, failed: 2 });
    for (const node of [gpt, amux])
      expect(node.children!.reduce((a, c) => a + c.total, 0)).toBe(node.total);
    // 成功率：成功 ÷（总数 − 客户端错误）
    expect(gpt.successRate).toBeCloseTo(3 / 5);
  });

  it('按请求计时，回退前失败的 Key 不单独出现；最深只到 3 级', () => {
    const r = queryQuality(
      data(),
      q({ groupPath: ['modelFamily', 'provider', 'key', 'client'] as never }),
    );
    const gpt = r.groups[0]!;
    expect(gpt.total).toBe(5);
    const amux = gpt.children!.find((c) => c.key === 'amux')!;
    expect(amux.children!.find((c) => c.label === 'k1')!.total).toBe(2);
    expect(amux.children![0]!.children).toBeUndefined();
  });

  it('模型 → 客户端 → 供应商：同一模型在不同 CLI 里的差别', () => {
    const r = queryQuality(
      [...data(), rec({ client: 'codex', outcome: 'idle-timeout' }), rec({ client: 'grok' })],
      q({ groupPath: ['modelFamily', 'client', 'provider'] }),
    );
    const gpt = r.groups.find((g) => g.key === 'gpt-6.1-sol')!;
    expect(gpt.children!.map((c) => c.key)).toEqual(['claude', 'codex', 'grok']);
    expect(gpt.children![1]).toMatchObject({ dim: 'client', total: 1, failed: 1 });
  });

  it('输入长度的分位数（含缓存读写）；p95 也有', () => {
    const rs = Array.from({ length: 100 }, (_, i) =>
      rec({ tokens: { input: (i + 1) * 10, cacheRead: 0, output: 5 } }),
    );
    const r = queryQuality(rs, q());
    expect(r.total.inputLen).toMatchObject({ n: 100, p50: 500, p95: 950, p99: 990 });
    expect(r.total.ttft.p95).toBe(1000);
  });

  it('官方账号的供应商标「官方」并有好读的名字（CLI 层）', () => {
    const r = queryQuality(
      [
        rec({
          layer: 'cli',
          source: 'official',
          provider: 'anthropic',
          keyId: undefined,
          model: 'claude-opus-5.5',
        }),
        rec({
          layer: 'cli',
          source: 'thirdParty',
          provider: 'amux',
          keyId: undefined,
          model: 'amux/anthropic/claude-opus-5.5',
        }),
      ],
      q({ layer: 'cli', groupPath: ['modelFamily', 'provider'] }),
    );
    const claude = r.groups[0]!;
    expect(claude).toMatchObject({ vendor: 'Anthropic', display: 'Claude Opus 5.5', total: 2 });
    const official = claude.children!.find((c) => c.key === 'anthropic')!;
    expect(official).toMatchObject({ label: 'Anthropic', tag: 'official' });
  });
});

describe('facetsOf', () => {
  it('这段时间里出现过的客户端 / 供应商 / 模型族 / Key，按次数降序，带显示名', () => {
    const f = facetsOf(
      [
        rec(),
        rec(),
        rec({ client: 'codex', provider: 'azure', keyId: 'az', model: 'azure/gpt-6.1-sol' }),
        rec({ model: 'amux/deepseek/deepseek-v4.1-flash' }),
      ],
      q(),
      (dim, key) => (dim === 'provider' && key === 'amux' ? 'Amux Special' : undefined),
    );
    expect(f.client!.map((x) => [x.key, x.count])).toEqual([
      ['claude', 3],
      ['codex', 1],
    ]);
    expect(f.provider![0]).toMatchObject({ key: 'amux', label: 'Amux Special', count: 3 });
    expect(f.modelFamily![0]).toMatchObject({
      key: 'gpt-6.1-sol',
      label: 'GPT-6.1 Sol',
      vendor: 'OpenAI',
      count: 3,
    });
    expect(f.key!.find((x) => x.key === 'amux\u0000k1')!.label).toBe('Amux Special · k1');
  });
});

describe('请求明细的展示名', () => {
  it('模型「厂商 + 好读的名字」、供应商与 Key 的名字；认不出的不给', () => {
    const { items } = listRequests(
      [
        rec({ provider: 'amux', keyId: 'k1' }),
        rec({ provider: 'anthropic', keyId: undefined, model: 'claude-opus-5.5' }),
        rec({ provider: 'mine', keyId: 'kx', model: 'mine/my-own-model' }),
      ],
      { ...q(), limit: 10 },
      (dim, key) =>
        dim === 'provider' && key === 'amux'
          ? 'Amux'
          : dim === 'key' && key === 'amux\u0000k1'
            ? 'Amux · 主 Key'
            : undefined,
    );
    const [mine, claude, gpt] = items;
    expect(gpt).toMatchObject({
      vendor: 'OpenAI',
      display: 'GPT-6.1 Sol',
      providerName: 'Amux',
      keyName: 'Amux · 主 Key',
    });
    expect(claude).toMatchObject({ vendor: 'Anthropic', display: 'Claude Opus 5.5' });
    expect(claude!.providerName).toBe('Anthropic');
    expect(mine!.vendor).toBeUndefined();
    expect(mine!.providerName).toBeUndefined();
    expect(mine!.keyName).toBeUndefined();
    // 原记录不变
    expect(gpt!.model).toBe('amux/openai/gpt-6.1-sol');
  });
});
