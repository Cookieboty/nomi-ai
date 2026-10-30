// Parity cases for apps/desktop-electron/internal/gateway/src/models/* and models.ts (batch 4c).
export async function recordModels({ gw }) {
  const fam = await gw('src/models/families.ts');
  const cat = await gw('src/models/catalog.ts');
  const eff = await gw('src/models/effective.ts');
  const build = await gw('src/models/buildCatalog.ts');
  const list = await gw('src/models.ts');
  const prov = await gw('src/providers/index.ts');

  prov.registerProviderSpec({
    id: 'parity-models',
    models: [
      { match: ['foo-*'], spec: { limits: { context: 1234 }, tools: { calling: false } } },
      { match: ['claude-x*'], spec: { reasoning: { control: 'effort', efforts: ['low'] } } },
    ],
  });

  const ids = [
    'claude-sonnet-4-5',
    'anthropic/claude-opus-4-1-20250805',
    'gpt-5',
    'GPT-5.1-codex',
    'o3-mini',
    'codex-mini-latest',
    'gemini-2.5-pro',
    'deepseek-chat',
    'deepseek-v3.2:free',
    'kimi-k2',
    'moonshot-v1',
    'glm-4.6',
    'qwen3-coder',
    'minimax-m2',
    'grok-4',
    'foo-bar',
    'claude-x1',
    'unknown-model',
    'constructor',
    'toString',
    '__proto__',
    'valueOf',
    'prototype',
    'a/b/gpt-4o',
    'gpt-4o-latest',
    'Claude-3-7-Sonnet-20250219',
    'qwen',
    'x:y',
    '',
  ];
  const providers = [
    { id: 'p1', name: 'P1', enabled: true, urls: {}, keys: [], models: [] },
    {
      id: 'p2',
      name: 'P2',
      enabled: true,
      urls: {},
      keys: [],
      spec: 'parity-models',
      models: [
        { id: 'foo-bar', enabled: true, ctx: 9999, vision: true, efforts: ['high'] },
        { id: 'claude-x1', enabled: true, reasoning: false, strict: false, toolCalling: true },
        { id: 'gpt-5', enabled: true, maxOutput: 77, strict: true },
        { id: 'deepseek-chat', enabled: true, efforts: ['low', 'high'] },
      ],
    },
  ];
  const NOW = 1_800_000_000_000;
  const learneds = [
    null,
    { models: {} },
    {
      models: {
        'gpt-5': { at: NOW - 1000, efforts: ['low'], temperature: false },
        'foo-bar': { at: NOW - 1000, efforts: ['minimal'] },
        'deepseek-chat': { at: NOW - 8 * 24 * 3600_000, efforts: ['low'] },
        'grok-4': { at: NOW, catalogVersion: 'old' },
        'kimi-k2': { at: NOW, catalogVersion: cat.CATALOG_VERSION, temperature: false },
      },
    },
  ];
  const effective = [];
  providers.forEach((p, pi) =>
    learneds.forEach((l, li) =>
      [undefined, true].forEach((strict) =>
        ids.forEach((id) =>
          effective.push({
            provider: pi,
            learned: li,
            strict: strict ?? null,
            model: id,
            output: JSON.stringify(eff.effectiveModel(p, id, l ?? undefined, { strict, now: NOW })),
          }),
        ),
      ),
    ),
  );

  const api = {
    openai: {
      models: {
        'GPT-Z': {
          id: 'gpt-z',
          type: 'chat',
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'bogus'] }],
          limit: { context: 400000, input: 272000, output: 128000 },
          modalities: { input: ['text', 'image', 'pdf'] },
          tool_call: true,
          temperature: false,
          cost: {
            tiers: [
              { tier: { type: 'context', size: 200000 } },
              { tier: { size: 100000 } },
              { tier: { type: 'other', size: 300000 } },
            ],
          },
        },
        emb: { type: 'embedding' },
        __proto__x: { family: 'f' },
        Constructor: { family: 'nope' },
        10: { family: 'num' },
        'a-b': {},
        a_b: {},
        'a.b': {},
        ab: {},
        a1: {},
        A2: {},
        'a~': {},
        a$: {},
      },
    },
    anthropic: {
      models: {
        'claude-q': {
          family: 'claude-q',
          reasoning: true,
          reasoning_options: [
            { type: 'effort', values: ['low', 'max'] },
            { type: 'budget_tokens', min: 1024, max: 1.5 },
          ],
          interleaved: { field: 'reasoning_details' },
          limit: { context: 0, output: -1 },
        },
        'claude-r': {
          reasoning: true,
          reasoning_options: [{ type: 'budget_tokens' }, { type: 'toggle' }],
        },
        'gpt-z': { family: 'dup' },
      },
    },
    google: {
      models: {
        'g-t': { reasoning: 1, reasoning_options: [{ type: 'toggle' }, 'x', null], tool_call: 0 },
        bad: 'x',
      },
    },
    openrouter: {
      models: {
        'x-ai/grok-new': { family: 'grok', limit: { input: 1000 } },
        '~openai/gpt-y': {},
        'other/zzz': {},
        '/lead': {},
        'openai/gpt-z': { family: 'dup2' },
        'qwen/q-emb': { type: 'embedding' },
        'z-ai/glm-9': { type: 'chat' },
      },
    },
  };
  const builds = [
    { api, version: 'v1', output: JSON.stringify(build.buildCatalog(api, 'v1')) },
    { api: null, version: '', output: JSON.stringify(build.buildCatalog(null, '')) },
    { api: [], version: 'x', output: JSON.stringify(build.buildCatalog([], 'x')) },
  ];
  const sortKeys = [
    'a-b',
    'a_b',
    'a.b',
    'ab',
    'a1',
    'a2',
    'a~',
    'a$',
    'a',
    'b',
    'gpt-4',
    'gpt4',
    'gpt-4o',
    'gpt-4.1',
    'gpt-4-1',
    'z',
    '0',
    '9',
    'a b',
    'a/b',
    'a:b',
    'a@b',
    'a+b',
    'a=b',
    'a(b',
    'a!b',
    'a?b',
    "a'b",
    'a,b',
    'a;b',
    'aa',
    'a-',
    'a-a',
  ];
  const sorted = [...sortKeys].sort((a, b) => a.localeCompare(b));

  const cfg = {
    providers: [
      {
        id: 'p',
        name: 'Prov',
        enabled: true,
        models: [
          { id: 'm1', enabled: true, label: 'M One', ctx: 100, maxOutput: 0 },
          { id: 'm2', enabled: false },
          { id: 'x/m3', enabled: true, maxOutput: 5 },
        ],
      },
      { id: 'off', name: 'Off', enabled: false, models: [{ id: 'z', enabled: true }] },
    ],
  };
  const listing = ['openai', 'anthropic', 'gemini'].flatMap((f) => [
    { format: f, cfg, output: JSON.stringify(list.modelsBody(cfg, f)) },
    {
      format: f,
      cfg: { providers: [] },
      output: JSON.stringify(list.modelsBody({ providers: [] }, f)),
    },
  ]);

  return {
    families: JSON.stringify(fam.FAMILIES),
    familyOf: ids.map((id) => ({ id, family: fam.familyOf(cat.bareModelId(id))?.family ?? null })),
    catalog: ids.map((id) => ({
      id,
      bare: cat.bareModelId(id),
      entry: JSON.stringify(cat.catalogEntry(id) ?? null),
    })),
    catalogVersion: cat.CATALOG_VERSION,
    catalogSize: cat.catalogSize(),
    providers,
    learneds,
    now: NOW,
    effective,
    builds,
    sortKeys,
    sorted,
    listing,
  };
}
