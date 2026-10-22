jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService, type HarnessGateway } from '../../../src/cli/CliHarnessService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');

/**
 * 标签级模型 / 思考深度覆盖（官方账号路径）：
 * 校验、互斥、各后端 argv 注入（codex -c / grok -m / claude --model）、
 * Claude 长驻进程随覆盖重启复用、跨重启持久化与后端切换清除。
 */
describe('CliHarnessService model / effort overrides', () => {
  const saved = { ...process.env };
  let root: string;
  let argvLog: string;
  beforeEach(() => {
    process.env.NOMI_CODEX_BIN = path.join(mockDir, 'mock-codex.mjs');
    process.env.NOMI_GROK_BIN = path.join(mockDir, 'mock-grok.mjs');
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
    delete process.env.NOMI_USE_MOCK_CLI;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-model-'));
    argvLog = path.join(root, 'argv.jsonl');
    process.env.NOMI_MOCK_ARGV_LOG = argvLog;
  });
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });
  const mk = (o: { gateway?: HarnessGateway } = {}) => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      // 不读真实的 ~/.codex/config.toml
      home: root,
      ...o,
    });
    made.push(h);
    return h;
  };
  const readArgv = (): string[][] =>
    fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);

  it('模型目录从 CLI 读取（claude initialize / codex debug models / grok ACP）', async () => {
    const h = mk();
    const claude = (await h.modelCatalogFor('claude'))!;
    expect(claude.error).toBeUndefined();
    expect(claude.defaultModel?.label).toBe('Opus Mock');
    expect(claude.models.map((m) => m.id)).toEqual([
      'opus',
      'sonnet',
      'claude-haiku-old',
      'claude-opus-old',
    ]);
    expect(claude.models.find((m) => m.id === 'claude-haiku-old')?.reasoning).toBe(false);

    const codex = (await h.modelCatalogFor('codex'))!;
    // 只列 visibility=list，按 priority 排序；档位以 CLI 为准（含 ultra）
    expect(codex.models.map((m) => m.id)).toEqual(['mock-mini', 'mock-pro', 'mock-plain']);
    expect(codex.models[1]!.efforts).toContain('ultra');

    const grok = (await h.modelCatalogFor('grok'))!;
    expect(grok.defaultModel?.id).toBe('grok-mock');
    expect(grok.models[0]!.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);

    expect(await h.modelCatalogFor('dsh')).toBeNull();
    expect(await h.modelCatalogFor('gemini')).toBeNull();
  }, 20_000);

  it('目录按后端缓存；refresh 重读；读取失败不缓存并带 error', async () => {
    const h = mk();
    const a = await h.modelCatalogFor('codex');
    expect(await h.modelCatalogFor('codex')).toBe(a);
    expect(await h.modelCatalogFor('codex', { refresh: true })).not.toBe(a);

    process.env.NOMI_MOCK_MODELS_FAIL = '1';
    h.recycleBackend('codex');
    const failed = (await h.modelCatalogFor('codex'))!;
    expect(failed.models).toEqual([]);
    expect(failed.error).toContain('failed to refresh models');
    delete process.env.NOMI_MOCK_MODELS_FAIL;
    expect((await h.modelCatalogFor('codex'))!.error).toBeUndefined();
  }, 20_000);

  it('Codex 默认模型 / 档位取 config.toml', async () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      'model = "mock-pro"\nmodel_reasoning_effort = "ultra"\n',
    );
    const c = (await mk().modelCatalogFor('codex'))!;
    expect(c.defaultModel?.id).toBe('mock-pro');
    expect(c.defaultModel?.defaultEffort).toBe('ultra');
  });

  it('设置 / 清除模型覆盖；切到不支持思考深度的模型会清掉档位', async () => {
    const h = mk();
    await h.modelCatalogFor('codex');
    const tab = h.createTab({ backend: 'codex' });

    expect(h.setTabModel(tab.id, 'mock-pro').modelOverride).toBe('mock-pro');
    expect(h.setTabReasoningEffort(tab.id, 'ultra').reasoningEffort).toBe('ultra');

    // 换到不支持该档位的模型：档位清掉（回到 CLI 默认）
    expect(h.setTabModel(tab.id, 'mock-mini').reasoningEffort).toBeNull();
    expect(() => h.setTabReasoningEffort(tab.id, 'ultra')).toThrow();

    // CLI 说不支持思考深度的模型
    h.setTabReasoningEffort(tab.id, 'high');
    const plain = h.setTabModel(tab.id, 'mock-plain');
    expect(plain.reasoningEffort).toBeNull();
    expect(() => h.setTabReasoningEffort(tab.id, 'high')).toThrow();

    // 空串清除覆盖
    const cleared = h.setTabModel(tab.id, '');
    expect(cleared.modelOverride).toBeNull();
    expect(cleared.reasoningEffort).toBeNull();
  }, 20_000);

  it('沿用默认模型（不选模型）时也允许只调思考深度', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    const r = h.setTabReasoningEffort(tab.id, 'low');
    expect(r.modelOverride).toBeFalsy();
    expect(r.reasoningEffort).toBe('low');
    expect(h.setTabReasoningEffort(tab.id, null).reasoningEffort).toBeNull();
  });

  it('拒绝非法模型名 / 非法档位 / 无目录后端', () => {
    const h = mk();
    const codex = h.createTab({ backend: 'codex' });
    expect(() => h.setTabModel(codex.id, 'a b; rm -rf /')).toThrow();
    expect(() => h.setTabModel(codex.id, '--unknown')).toThrow();
    expect(() => h.setTabReasoningEffort(codex.id, 'ULTRA')).toThrow();

    const dsh = h.createTab({ backend: 'dsh' });
    expect(() => h.setTabModel(dsh.id, 'some-model')).toThrow();
    expect(() => h.setTabReasoningEffort(dsh.id, 'high')).toThrow();
  });

  it('档位按 CLI 返回的目录校验：Claude 默认模型无 minimal，旧模型无 xhigh', async () => {
    const h = mk();
    await h.modelCatalogFor('claude');
    const claude = h.createTab({ backend: 'claude' });
    expect(() => h.setTabReasoningEffort(claude.id, 'minimal')).toThrow();
    expect(h.setTabReasoningEffort(claude.id, 'max').reasoningEffort).toBe('max');
    h.setTabModel(claude.id, 'claude-opus-old');
    expect(() => h.setTabReasoningEffort(claude.id, 'xhigh')).toThrow();
    // 目录外的合法 id 走自定义兜底，档位用目录并集
    expect(h.setTabModel(claude.id, 'claude-opus-9').modelOverride).toBe('claude-opus-9');
    expect(h.setTabReasoningEffort(claude.id, 'xhigh').reasoningEffort).toBe('xhigh');
  }, 20_000);

  it('目录还没读到时只校验枚举，由 CLI 自己报错', () => {
    const h = mk();
    const grok = h.createTab({ backend: 'grok' });
    expect(h.setTabModel(grok.id, 'grok-anything').modelOverride).toBe('grok-anything');
    expect(h.setTabReasoningEffort(grok.id, 'max').reasoningEffort).toBe('max');
  });

  it('允许合法的自定义模型 id（官方新模型兜底）', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    expect(h.setTabModel(tab.id, 'Tifa-6-astra').modelOverride).toBe('Tifa-6-astra');
  });

  it('发送时把模型 / 档位以 -c 进程级参数传给 codex exec', async () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    h.setTabModel(tab.id, 'gpt-5.6-sol');
    h.setTabReasoningEffort(tab.id, 'high');

    await h.sendTab(tab.id, '做个事');
    const last = readArgv().at(-1)!;
    expect(last).toContain('-c');
    expect(last).toContain('model="gpt-5.6-sol"');
    expect(last).toContain('model_reasoning_effort="high"');
    // 不能改写用户全局配置：参数必须是每轮进程级的（出现一次成对 -c）
    expect(last.filter((x) => x === '-c').length).toBeGreaterThanOrEqual(2);
  });

  it('发送时把模型 / 档位以 -m / --reasoning-effort 传给 grok -p', async () => {
    const h = mk();
    const tab = h.createTab({ backend: 'grok' });
    h.setTabModel(tab.id, 'grok-4.6');
    h.setTabReasoningEffort(tab.id, 'max');

    await h.sendTab(tab.id, '做个事');
    const last = readArgv().at(-1)!;
    const mIdx = last.indexOf('-m');
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(last[mIdx + 1]).toBe('grok-4.6');
    const eIdx = last.indexOf('--reasoning-effort');
    expect(eIdx).toBeGreaterThanOrEqual(0);
    expect(last[eIdx + 1]).toBe('max');
  });

  it('Claude 空闲时切换覆盖会回收长驻进程，下一轮带新参数 --resume 重启', async () => {
    const boot = path.join(root, 'claude-boot.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });

    await h.sendTab(tab.id, '第一轮');
    const sid = h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId;
    expect(sid).toBeTruthy();

    // 模型 + 思考深度一起换：思考深度没有原地切换，按新参数重启
    h.setTabModel(tab.id, 'claude-sonnet-5-5');
    h.setTabReasoningEffort(tab.id, 'high');

    await h.sendTab(tab.id, '第二轮');
    // 会话续接，不丢上下文
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)!.cliSessionId).toBe(sid);

    const boots = fs
      .readFileSync(boot, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^\d+\s+/, ''));
    expect(boots).toHaveLength(2);
    expect(boots[0]).not.toContain('--model');
    const second = boots[1].split(' ');
    expect(second).toContain('--model');
    expect(second[second.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(second).toContain('--effort');
    expect(second[second.indexOf('--effort') + 1]).toBe('high');
    expect(second).toContain('--resume');
  }, 20_000);

  it('切换后端会清掉模型 / 思考深度覆盖', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    h.setTabModel(tab.id, 'gpt-5.6-sol');
    h.setTabReasoningEffort(tab.id, 'low');
    h.setTabBackend(tab.id, 'claude');
    const moved = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(moved.modelOverride).toBeNull();
    expect(moved.reasoningEffort).toBeNull();

    // 反向同理：claude 覆盖切到 grok 也清掉
    h.setTabModel(tab.id, 'claude-sonnet-5-5');
    h.setTabReasoningEffort(tab.id, 'high');
    h.setTabBackend(tab.id, 'grok');
    const moved2 = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(moved2.modelOverride).toBeNull();
    expect(moved2.reasoningEffort).toBeNull();
  });

  it('覆盖跨重启持久化（tabs.json）并做合法性还原', () => {
    const h1 = mk();
    const tab = h1.createTab({ backend: 'codex' });
    h1.setTabModel(tab.id, 'gpt-5.6-sol');
    h1.setTabReasoningEffort(tab.id, 'high');
    h1.dispose();

    const h2 = mk();
    const restored = h2.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(restored.modelOverride).toBe('gpt-5.6-sol');
    expect(restored.reasoningEffort).toBe('high');
  });

  it('grok / claude 覆盖同样跨重启持久化', () => {
    const h1 = mk();
    const grok = h1.createTab({ backend: 'grok' });
    h1.setTabModel(grok.id, 'grok-4.7');
    h1.setTabReasoningEffort(grok.id, 'xhigh');
    const claude = h1.createTab({ backend: 'claude' });
    h1.setTabModel(claude.id, 'claude-opus-5-5');
    h1.setTabReasoningEffort(claude.id, 'max');
    h1.dispose();

    const h2 = mk();
    const g2 = h2.listTabs().tabs.find((x) => x.id === grok.id)!;
    expect(g2.modelOverride).toBe('grok-4.7');
    expect(g2.reasoningEffort).toBe('xhigh');
    const c2 = h2.listTabs().tabs.find((x) => x.id === claude.id)!;
    expect(c2.modelOverride).toBe('claude-opus-5-5');
    expect(c2.reasoningEffort).toBe('max');
  });

  it('主标签的「仅思考深度」组合跨重启保留（state.json）', () => {
    const h1 = mk();
    h1.setTabBackend('main', 'codex');
    h1.setTabReasoningEffort('main', 'xhigh');
    h1.dispose();

    const h2 = mk();
    expect(h2.listTabs().tabs.find((x) => x.id === 'main')?.reasoningEffort).toBe('xhigh');
  });

  it('持久化还原时丢弃不认识的档位（目录要等 CLI 读回来，届时再校验）', () => {
    const h1 = mk();
    const tab = h1.createTab({ backend: 'codex' });
    h1.setTabModel(tab.id, 'mock-pro');
    h1.dispose();
    const file = path.join(root, 'tabs.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const target = (raw.tabs as Array<{ id: string; reasoningEffort?: string }>).find(
      (x) => x.id === tab.id,
    )!;
    target.reasoningEffort = 'bogus';
    fs.writeFileSync(file, JSON.stringify(raw));
    const restored = mk()
      .listTabs()
      .tabs.find((x) => x.id === tab.id)!;
    expect(restored.modelOverride).toBe('mock-pro');
    expect(restored.reasoningEffort).toBeNull();
  });

  describe('第三方来源（经统一网关，§12）', () => {
    const fakeGateway = (
      o: { source?: 'official' | 'thirdParty'; main?: string | null; running?: boolean } = {},
    ) => {
      const launches: Array<[string, string, string]> = [];
      const gateway: HarnessGateway = {
        defaults: () => ({
          source: o.source ?? 'official',
          model: o.main === undefined ? 'gw/a' : o.main,
        }),
        launch: (kind, tabId, model) => {
          launches.push([kind, tabId, model]);
          return o.running === false
            ? null
            : {
                env: { NOMI_GATEWAY_KEY: 'nomi-gw-codex-test' },
                args: ['-c', 'model_provider="nomi_gateway"'],
                strip: ['OPENAI_API_KEY'],
              };
        },
        officialEnv: (env) => env,
        models: () => [
          { ref: 'gw/a', provider: 'GW', label: 'a' },
          { ref: 'gw/b', provider: 'GW', label: 'b' },
        ],
        releaseAgent: () => undefined,
      };
      return { gateway, launches };
    };

    it('第三方的模型目录来自网关，默认是「模型」页给这个编程助手分配的，没有思考深度', async () => {
      const h = mk({ gateway: fakeGateway().gateway } as never);
      const c = (await h.modelCatalogFor('codex', { source: 'thirdParty' }))!;
      expect(c.provider).toEqual({ id: 'gateway', name: '第三方模型' });
      expect(c.defaultModel?.id).toBe('gw/a');
      expect(c.models.map((m) => [m.id, m.label])).toEqual([
        ['gw/a', 'GW / a'],
        ['gw/b', 'GW / b'],
      ]);
      expect(c.models.every((m) => !m.reasoning && m.efforts.length === 0)).toBe(true);
    });

    it('切到第三方：注入网关参数、按标签模型下发、不带思考深度；切回官方取回之前的选择', async () => {
      const { gateway, launches } = fakeGateway();
      const h = mk({ gateway } as never);
      const tab = h.createTab({ backend: 'codex' });
      expect(tab.source).toBe('official');
      h.setTabModel(tab.id, 'gpt-5.6-sol');
      h.setTabReasoningEffort(tab.id, 'high');
      expect(h.setTabSource(tab.id, 'thirdParty', 'gw/b')).toMatchObject({
        source: 'thirdParty',
        modelOverride: 'gw/b',
        modelScope: 'gateway',
        reasoningEffort: null,
      });
      expect(() => h.setTabReasoningEffort(tab.id, 'high')).toThrow();
      await h.sendTab(tab.id, 'third party');
      const third = readArgv().at(-1)!;
      expect(third).toContain('model_provider="nomi_gateway"');
      expect(third).toContain('model="gw/b"');
      expect(third.some((x) => x.startsWith('model_reasoning_effort='))).toBe(false);
      expect(launches.at(-1)).toEqual(['codex', tab.id, 'gw/b']);
      // 第三方 → 官方：带上下文的新会话（第三方的推理内容不能发给官方）
      const back = h.setTabSource(tab.id, 'official');
      expect(back).toMatchObject({
        source: 'official',
        modelOverride: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      });
      expect(back.cliSessionId).toBeNull();
      expect(back.carriedMessages).toBeGreaterThan(0);
      await h.sendTab(tab.id, 'official again');
      const official = readArgv().at(-1)!;
      expect(official).toContain('model="gpt-5.6-sol"');
      expect(official.some((x) => x.includes('nomi_gateway'))).toBe(false);
      // 跨重启保留各来源的选择
      h.dispose();
      expect(
        mk({ gateway } as never)
          .listTabs()
          .tabs.find((x) => x.id === tab.id)?.modelByScope,
      ).toEqual({
        gateway: { model: 'gw/b', effort: null },
      });
    });

    it('新标签按「新标签默认用」：第三方时没选模型就用分配的模型', async () => {
      const h = mk({
        gateway: fakeGateway({ source: 'thirdParty', main: 'gw/a' }).gateway,
      } as never);
      const tab = h.createTab({ backend: 'codex' });
      expect(tab.source).toBe('thirdParty');
      await h.sendTab(tab.id, 'hi');
      expect(readArgv().at(-1)!).toContain('model="gw/a"');
      // 没分配模型：新标签仍是官方
      const none = mk({
        gateway: fakeGateway({ source: 'thirdParty', main: null }).gateway,
      } as never);
      expect(none.createTab({ backend: 'codex' }).source).toBe('official');
      expect(() =>
        none.setTabSource(none.createTab({ backend: 'codex' }).id, 'thirdParty'),
      ).toThrow(/模型/);
    });

    it('网关没在运行：第三方标签明确报错，不悄悄走官方', async () => {
      const h = mk({
        gateway: fakeGateway({ source: 'thirdParty', running: false }).gateway,
      } as never);
      const tab = h.createTab({ backend: 'codex' });
      await expect(h.sendTab(tab.id, 'hi')).rejects.toThrow(/网关/);
    });

    it('新会话只沿用同一来源下的模型', async () => {
      const h = mk({ gateway: fakeGateway({ source: 'thirdParty' }).gateway } as never);
      const a = h.createTab({ backend: 'codex' });
      h.setTabModel(a.id, 'gw/b');
      expect(h.createTab({ backend: 'codex' }).modelOverride).toBe('gw/b');
    });
  });

  it('Claude 有后台任务时切换思考深度不拆进程，后台结束后的下一轮才按新参数重启', async () => {
    const boot = path.join(root, 'claude-boot.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, '第一轮');

    const lives = (h as unknown as { claudeLive: Map<string, { bgTasks: Set<string> }> })
      .claudeLive;
    const live = lives.get(tab.id)!;
    live.bgTasks.add('task-1');

    h.setTabReasoningEffort(tab.id, 'high');
    expect(lives.get(tab.id)).toBe(live);
    await h.sendTab(tab.id, '第二轮');
    expect(lives.get(tab.id)).toBe(live);

    live.bgTasks.clear();
    await h.sendTab(tab.id, '第三轮');
    const boots = fs.readFileSync(boot, 'utf8').trim().split('\n').filter(Boolean);
    expect(boots).toHaveLength(2);
    expect(boots[1]).toContain('--effort high');
  }, 20_000);

  it('Claude 只换模型：下一轮前 set_model 原地切换，不重启进程', async () => {
    const boot = path.join(root, 'claude-boot.log');
    const control = path.join(root, 'claude-control.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    process.env.NOMI_MOCK_CLAUDE_CONTROL_LOG = control;
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, '第一轮');
    const lives = (h as unknown as { claudeLive: Map<string, unknown> }).claudeLive;
    const live = lives.get(tab.id);

    h.setTabModel(tab.id, 'claude-sonnet-5-5');
    expect(lives.get(tab.id)).toBe(live);
    await h.sendTab(tab.id, '第二轮');
    h.setTabModel(tab.id, '');
    await h.sendTab(tab.id, '第三轮');

    expect(lives.get(tab.id)).toBe(live);
    expect(fs.readFileSync(boot, 'utf8').trim().split('\n')).toHaveLength(1);
    const sent = fs
      .readFileSync(control, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.replace(/^\d+\s+/, ''));
    expect(sent).toEqual(['set_model claude-sonnet-5-5', 'set_model default']);
  }, 20_000);

  it('Claude set_model 被拒：拆进程，下一轮带新 --model 重启', async () => {
    const boot = path.join(root, 'claude-boot.log');
    process.env.NOMI_MOCK_CLAUDE_BOOT_LOG = boot;
    process.env.NOMI_MOCK_CLAUDE_MODEL_ACK = 'error';
    const h = mk();
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, '第一轮');
    h.setTabModel(tab.id, 'claude-sonnet-5-5');
    await h.sendTab(tab.id, '第二轮');
    const boots = fs.readFileSync(boot, 'utf8').trim().split('\n');
    expect(boots).toHaveLength(2);
    expect(boots[1]).toContain('--model claude-sonnet-5-5');
    expect(boots[1]).toContain('--resume');
  }, 20_000);
});
