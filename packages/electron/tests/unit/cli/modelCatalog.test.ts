/**
 * 模型目录一律从 CLI 读取：这里用各 CLI 真实输出的形状（2026-10 实测）校验解析，
 * 以及基于读到的目录做的档位校验与进程级参数。
 */
import {
  effortsForModel,
  isAllowedModelId,
  isReasoningEffort,
  normalizeEfforts,
  overrideArgs,
  parseClaudeModels,
  parseCodexModels,
  parseGrokModels,
  readCodexConfigDefaults,
  sanitizeEffort,
  supportsModelOverride,
  type BackendModelCatalog,
} from '../../../src/cli/modelCatalog';

describe('modelCatalog', () => {
  describe('parseClaudeModels（initialize 响应的 models）', () => {
    const response = {
      models: [
        {
          value: 'default',
          resolvedModel: 'claude-opus-5-5',
          displayName: 'Default (recommended)',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'high',
        },
        {
          value: 'opus',
          resolvedModel: 'claude-opus-5-5',
          displayName: 'Opus 5.5',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        {
          value: 'claude-haiku-4-5-20251001',
          resolvedModel: 'claude-haiku-4-5-20251001',
          displayName: 'Haiku 4.5',
        },
        {
          value: 'claude-opus-4-6',
          resolvedModel: 'claude-opus-4-6',
          displayName: 'Opus 4.6',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'max'],
        },
      ],
    };

    it('default 项作为默认模型，显示名换成它解析到的模型', () => {
      const c = parseClaudeModels(response);
      expect(c.defaultModel?.id).toBe('default');
      expect(c.defaultModel?.label).toBe('Opus 5.5');
      expect(c.defaultModel?.defaultEffort).toBe('high');
      expect(c.models.map((m) => m.id)).toEqual([
        'opus',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-6',
      ]);
    });

    it('档位按模型取；不支持思考深度的模型标为非推理', () => {
      const c = parseClaudeModels(response);
      expect(c.models.find((m) => m.id === 'claude-opus-4-6')?.efforts).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
      const haiku = c.models.find((m) => m.id === 'claude-haiku-4-5-20251001')!;
      expect(haiku.reasoning).toBe(false);
      expect(haiku.efforts).toEqual([]);
    });

    it('没有 models 时返回空目录', () => {
      expect(parseClaudeModels({}).models).toEqual([]);
      expect(parseClaudeModels(null).defaultModel).toBeNull();
    });
  });

  describe('parseCodexModels（codex debug models）', () => {
    const json = {
      models: [
        {
          slug: 'b',
          display_name: 'B',
          visibility: 'list',
          priority: 2,
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'max' }],
        },
        {
          slug: 'a',
          display_name: 'A',
          visibility: 'list',
          priority: 1,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'xhigh' }],
        },
        { slug: 'hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [] },
      ],
    };

    it('只列 visibility=list，按 priority 排序，档位由浅到深（含 ultra）', () => {
      const c = parseCodexModels(json);
      expect(c.models.map((m) => m.id)).toEqual(['a', 'b']);
      expect(c.models[1]!.efforts).toEqual(['low', 'max', 'ultra']);
      expect(c.models[0]!.defaultEffort).toBe('medium');
    });

    it('默认模型 / 档位取 config.toml；config 的档位优先于目录默认', () => {
      const c = parseCodexModels(json, { model: 'a', effort: 'xhigh' });
      expect(c.defaultModel?.id).toBe('a');
      expect(c.defaultModel?.defaultEffort).toBe('xhigh');
      // config 写了目录里没有的模型：不认默认模型
      expect(parseCodexModels(json, { model: 'nope' }).defaultModel).toBeNull();
    });

    it('readCodexConfigDefaults 只读顶层（第一个表头之前）', () => {
      const toml = [
        'model_provider = "custom"',
        "model_reasoning_effort = 'xhigh'",
        'model = "Tifa-6-astra"',
        '[model_providers.custom]',
        'model = "inner"',
      ].join('\n');
      expect(readCodexConfigDefaults(toml)).toEqual({ model: 'Tifa-6-astra', effort: 'xhigh' });
      expect(readCodexConfigDefaults('[x]\nmodel = "y"')).toEqual({ model: null, effort: null });
    });
  });

  describe('parseGrokModels（ACP session/new）', () => {
    const result = {
      sessionId: 's',
      models: {
        currentModelId: 'grok-4.7',
        availableModels: [
          {
            modelId: 'grok-4.7',
            name: 'Grok 4.7',
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: [
                { value: 'xhigh', default: false },
                { value: 'high', default: true },
                { value: 'medium', default: false },
                { value: 'low', default: false },
              ],
            },
          },
          { modelId: 'grok-x', name: 'X', _meta: { supportsReasoningEffort: false } },
        ],
      },
    };

    it('currentModelId 为默认模型；档位排成由浅到深并带默认档位', () => {
      const c = parseGrokModels(result);
      expect(c.defaultModel?.id).toBe('grok-4.7');
      expect(c.models[0]!.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(c.models[0]!.defaultEffort).toBe('high');
      expect(c.models[1]!.reasoning).toBe(false);
    });

    it('兼容 Grok models_cache.json 的 map 结构与 snake_case 元数据', () => {
      const c = parseGrokModels({
        default_model: 'grok-4.7',
        models: {
          'grok-4.7': {
            info: {
              id: 'grok-4.7',
              name: 'Grok 4.7',
              supports_reasoning_effort: true,
              reasoning_efforts: [
                { id: 'xhigh', value: 'xhigh', default: false },
                { id: 'high', value: 'high', default: true },
                { id: 'low', value: 'low', default: false },
              ],
              reasoning_effort: 'high',
            },
          },
          'grok-4.7-build-fast': {
            info: { id: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast' },
          },
        },
      });
      expect(c.models.map((m) => m.id)).toEqual(['grok-4.7', 'grok-4.7-build-fast']);
      expect(c.defaultModel?.id).toBe('grok-4.7');
      expect(c.models[0]!.efforts).toEqual(['low', 'high', 'xhigh']);
      expect(c.models[0]!.defaultEffort).toBe('high');
    });
  });

  describe('基于读到的目录做校验', () => {
    const catalog: BackendModelCatalog = parseCodexModels(
      {
        models: [
          {
            slug: 'r',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
          },
          { slug: 'plain', visibility: 'list', supported_reasoning_levels: [] },
        ],
      },
      { model: 'r' },
    );

    it('effortsForModel：目录内模型 / 默认模型 / 不支持 / 未知', () => {
      expect(effortsForModel(catalog, 'r')).toEqual(['low', 'high']);
      expect(effortsForModel(catalog, null)).toEqual(['low', 'high']);
      expect(effortsForModel(catalog, 'plain')).toBeNull();
      // 自定义的未知模型：目录并集
      expect(effortsForModel(catalog, 'custom-x')).toEqual(['low', 'high']);
      // 还没读到 / 读失败：不知道
      expect(effortsForModel(null, 'r')).toBeUndefined();
      expect(effortsForModel({ ...catalog, error: 'x' }, 'r')).toBeUndefined();
    });

    it('sanitizeEffort：不支持的档位 / 模型清掉；未设置保持未设置；目录未知时原样保留', () => {
      expect(sanitizeEffort(catalog, 'r', 'high')).toBe('high');
      expect(sanitizeEffort(catalog, 'r', 'max')).toBeNull();
      expect(sanitizeEffort(catalog, 'plain', 'high')).toBeNull();
      expect(sanitizeEffort(catalog, 'r', null)).toBeNull();
      expect(sanitizeEffort(null, 'r', 'max')).toBe('max');
    });
  });

  it('normalizeEfforts 去掉不认识的值（如 none）并排序', () => {
    expect(normalizeEfforts(['high', 'none', 'low', 'high', 7])).toEqual(['low', 'high']);
    expect(isReasoningEffort('ultra')).toBe(true);
    expect(isReasoningEffort('none')).toBe(false);
  });

  it('只有 claude / codex / grok 支持覆盖；模型名只做字符集校验', () => {
    expect(supportsModelOverride('claude')).toBe(true);
    expect(supportsModelOverride('gemini')).toBe(false);
    expect(supportsModelOverride('dsh')).toBe(false);
    expect(isAllowedModelId('codex', 'Tifa-6-astra')).toBe(true);
    expect(isAllowedModelId('claude', 'claude-opus-5-5[1m]')).toBe(true);
    expect(isAllowedModelId('codex', '--evil')).toBe(false);
    expect(isAllowedModelId('codex', 'a b')).toBe(false);
    expect(isAllowedModelId('codex', 'a"b')).toBe(false);
    expect(isAllowedModelId('dsh', 'x')).toBe(false);
  });

  describe('overrideArgs', () => {
    it('codex：-c model / model_reasoning_effort', () => {
      expect(overrideArgs('codex', { model: 'm', effort: 'ultra' })).toEqual([
        '-c',
        'model="m"',
        '-c',
        'model_reasoning_effort="ultra"',
      ]);
    });
    it('grok：-m / --reasoning-effort', () => {
      expect(overrideArgs('grok', { model: 'grok-4.7', effort: 'xhigh' })).toEqual([
        '-m',
        'grok-4.7',
        '--reasoning-effort',
        'xhigh',
      ]);
    });
    it('claude：--model / --effort；不认识的档位不发', () => {
      expect(overrideArgs('claude', { model: 'opus', effort: 'max' })).toEqual([
        '--model',
        'opus',
        '--effort',
        'max',
      ]);
      expect(overrideArgs('claude', { effort: 'none' })).toEqual([]);
    });
  });
});
