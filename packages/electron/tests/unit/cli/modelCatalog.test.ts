/**
 * 官方账号模型目录：后端可用性、模型名合法性、推理模型 / 思考档位、
 * 各后端无头模式覆盖参数（codex -c / grok -m / claude --model）。
 */
import {
  REASONING_EFFORTS,
  catalogModel,
  effortsForModel,
  isAllowedModelId,
  isReasoningEffort,
  modelCatalog,
  overrideArgs,
  sanitizeEffort,
} from '../../../src/cli/modelCatalog';

/** Codex 覆盖参数（统一入口 overrideArgs 的 codex 形态） */
const codexOverrideArgs = (o: { model?: string | null; effort?: string | null }) =>
  overrideArgs('codex', o);

describe('modelCatalog', () => {
  it('有无头覆盖参数的后端有目录（codex / claude / grok）；gemini / dsh 没有', () => {
    expect(modelCatalog('codex')?.backend).toBe('codex');
    expect(modelCatalog('claude')?.backend).toBe('claude');
    expect(modelCatalog('grok')?.backend).toBe('grok');
    expect(modelCatalog('gemini')).toBeNull();
    expect(modelCatalog('dsh')).toBeNull();
  });

  it('各后端档位集不同；顺序由浅到深', () => {
    expect(modelCatalog('codex')!.efforts).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(modelCatalog('claude')!.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelCatalog('grok')!.efforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('目录内模型可查；非推理模型显式标记', () => {
    expect(catalogModel('codex', 'gpt-5.6-sol')?.reasoning).toBe(true);
    expect(catalogModel('codex', 'gpt-4.1')?.reasoning).toBe(false);
    expect(catalogModel('claude', 'sonnet')?.reasoning).toBe(true);
    expect(catalogModel('grok', 'grok-4-1-fast-non-reasoning')?.reasoning).toBe(false);
    expect(catalogModel('codex', 'not-a-real-model')).toBeNull();
  });

  it('isReasoningEffort 接受全部六档枚举', () => {
    for (const e of REASONING_EFFORTS) expect(isReasoningEffort(e)).toBe(true);
    expect(isReasoningEffort('HIGH')).toBe(false);
    expect(isReasoningEffort('')).toBe(false);
    expect(isReasoningEffort(null)).toBe(false);
    expect(isReasoningEffort(42)).toBe(false);
  });

  describe('isAllowedModelId', () => {
    it('接受目录内模型（含各后端）', () => {
      expect(isAllowedModelId('codex', 'gpt-5.3-codex')).toBe(true);
      expect(isAllowedModelId('claude', 'opus')).toBe(true);
      expect(isAllowedModelId('grok', 'grok-4.6')).toBe(true);
      expect(isAllowedModelId('grok', ' grok-4.6 ')).toBe(true);
    });

    it('接受厂商风格的自定义模型 id（兜底官方新模型）', () => {
      expect(isAllowedModelId('codex', 'gpt-7-codex-preview')).toBe(true);
      expect(isAllowedModelId('grok', 'org/model:2026-01')).toBe(true);
    });

    it('拒绝空、过长、带空白 / 引号 / 以 - 开头的名字（argv/配置注入面）', () => {
      for (const backend of ['codex', 'claude', 'grok'] as const) {
        expect(isAllowedModelId(backend, '')).toBe(false);
        expect(isAllowedModelId(backend, '   ')).toBe(false);
        expect(isAllowedModelId(backend, 'a b')).toBe(false);
        expect(isAllowedModelId(backend, '-x')).toBe(false);
        expect(isAllowedModelId(backend, 'a"b')).toBe(false);
        expect(isAllowedModelId(backend, "a'b")).toBe(false);
        expect(isAllowedModelId(backend, `a${'x'.repeat(128)}`)).toBe(false);
        expect(isAllowedModelId(backend, 'a;rm -rf /')).toBe(false);
      }
    });

    it('无目录的后端一律拒绝', () => {
      expect(isAllowedModelId('dsh', 'some-model')).toBe(false);
      expect(isAllowedModelId('gemini', 'some-model')).toBe(false);
    });
  });

  describe('effortsForModel', () => {
    it('推理模型返回该后端档位集；非推理模型返回 null', () => {
      expect(effortsForModel('codex', 'gpt-5.6-sol')).toEqual(modelCatalog('codex')!.efforts);
      expect(effortsForModel('codex', 'gpt-4.1')).toBeNull();
      expect(effortsForModel('claude', 'sonnet')).toEqual(modelCatalog('claude')!.efforts);
      expect(effortsForModel('grok', 'grok-4-1-fast-non-reasoning')).toBeNull();
    });

    it('Claude 档位不含 minimal；未选模型时给后端档位集', () => {
      expect(effortsForModel('claude', 'fable')).not.toContain('minimal');
      expect(effortsForModel('claude', 'fable')).toContain('max');
    });

    it('未知自定义模型默认给全档位（官方新推理模型在目录更新前仍可调）', () => {
      expect(effortsForModel('codex', 'gpt-7-codex')).toEqual(modelCatalog('codex')!.efforts);
      expect(effortsForModel('grok', 'grok-9')).toEqual(modelCatalog('grok')!.efforts);
    });
  });

  describe('sanitizeEffort', () => {
    it('合法档位原样返回', () => {
      expect(sanitizeEffort('codex', 'gpt-5.6-sol', 'high')).toBe('high');
      expect(sanitizeEffort('grok', 'grok-4.6', 'max')).toBe('max');
    });

    it('不属于该后端档位集的值回落 null', () => {
      // codex 不支持 max
      expect(sanitizeEffort('codex', 'gpt-5.6-sol', 'max')).toBeNull();
      // claude 不支持 minimal
      expect(sanitizeEffort('claude', 'sonnet', 'minimal')).toBeNull();
      expect(sanitizeEffort('codex', 'gpt-5.6-sol', 'ULTRA')).toBeNull();
    });

    it('非推理模型一律 null', () => {
      expect(sanitizeEffort('codex', 'gpt-4.1', 'high')).toBeNull();
      expect(sanitizeEffort('grok', 'grok-4-1-fast-non-reasoning', 'high')).toBeNull();
    });
  });

  describe('codexOverrideArgs', () => {
    it('空覆盖不产生参数（沿用 CLI 自身配置）', () => {
      expect(codexOverrideArgs({})).toEqual([]);
      expect(codexOverrideArgs({ model: '', effort: null })).toEqual([]);
      expect(codexOverrideArgs({ model: '   ' })).toEqual([]);
    });

    it('模型与档位各自生成带引号的 TOML 标量 -c', () => {
      expect(codexOverrideArgs({ model: 'gpt-5.4', effort: 'high' })).toEqual([
        '-c',
        'model="gpt-5.4"',
        '-c',
        'model_reasoning_effort="high"',
      ]);
    });

    it('只有模型 / 只有档位都可独立存在（沿用默认模型时也能调思考深度）', () => {
      expect(codexOverrideArgs({ effort: 'low' })).toEqual(['-c', 'model_reasoning_effort="low"']);
      expect(codexOverrideArgs({ model: 'gpt-5.4' })).toEqual(['-c', 'model="gpt-5.4"']);
    });

    it('非法档位直接忽略，不发出无效配置', () => {
      expect(codexOverrideArgs({ model: 'gpt-5.4', effort: 'ULTRA' })).toEqual([
        '-c',
        'model="gpt-5.4"',
      ]);
    });
  });

  describe('overrideArgs 各后端形态', () => {
    it('codex：成对 -c TOML 标量', () => {
      expect(overrideArgs('codex', { model: 'gpt-5.4', effort: 'high' })).toEqual([
        '-c',
        'model="gpt-5.4"',
        '-c',
        'model_reasoning_effort="high"',
      ]);
    });

    it('grok：-m <id> --reasoning-effort <level>，裸值不加引号', () => {
      expect(overrideArgs('grok', { model: 'grok-4.6', effort: 'max' })).toEqual([
        '-m',
        'grok-4.6',
        '--reasoning-effort',
        'max',
      ]);
      expect(overrideArgs('grok', { effort: 'low' })).toEqual(['--reasoning-effort', 'low']);
      expect(overrideArgs('grok', { model: 'grok-4.6' })).toEqual(['-m', 'grok-4.6']);
    });

    it('claude：--model <id> --effort <level>', () => {
      expect(overrideArgs('claude', { model: 'sonnet', effort: 'high' })).toEqual([
        '--model',
        'sonnet',
        '--effort',
        'high',
      ]);
      expect(overrideArgs('claude', { effort: 'max' })).toEqual(['--effort', 'max']);
      // claude 档位不含 minimal：非法档位不发出
      expect(overrideArgs('claude', { effort: 'minimal' })).toEqual([]);
    });

    it('空覆盖 / 无头不支持覆盖的后端返回空数组', () => {
      expect(overrideArgs('grok', {})).toEqual([]);
      expect(overrideArgs('gemini', { model: 'x' })).toEqual([]);
      expect(overrideArgs('dsh', { effort: 'high' })).toEqual([]);
    });
  });
});
