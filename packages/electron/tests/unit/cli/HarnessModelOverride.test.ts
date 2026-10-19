jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../../../src/cli/CliHarnessService';

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
  const mk = () => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
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

  it('modelCatalogFor 对支持的后端（codex / claude / grok）返回目录', () => {
    const h = mk();
    expect(h.modelCatalogFor('codex')?.backend).toBe('codex');
    expect(h.modelCatalogFor('claude')?.backend).toBe('claude');
    expect(h.modelCatalogFor('grok')?.backend).toBe('grok');
    expect(h.modelCatalogFor('dsh')).toBeNull();
    expect(h.modelCatalogFor('gemini')).toBeNull();
  });

  it('设置 / 清除模型覆盖；切到非推理模型会清掉思考深度', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });

    const a = h.setTabModel(tab.id, 'gpt-5.6-sol');
    expect(a.modelOverride).toBe('gpt-5.6-sol');

    const withEffort = h.setTabReasoningEffort(tab.id, 'high');
    expect(withEffort.reasoningEffort).toBe('high');

    // 非推理模型：思考深度被清除
    const nonReasoning = h.setTabModel(tab.id, 'gpt-4.1');
    expect(nonReasoning.modelOverride).toBe('gpt-4.1');
    expect(nonReasoning.reasoningEffort).toBeNull();

    // 非推理模型上拒绝设置档位
    expect(() => h.setTabReasoningEffort(tab.id, 'high')).toThrow();

    // 空串清除覆盖
    const cleared = h.setTabModel(tab.id, '');
    expect(cleared.modelOverride).toBeNull();
    expect(cleared.reasoningEffort).toBeNull();
  });

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

  it('档位必须属于该后端：codex 拒绝 max；claude 拒绝 minimal', () => {
    const h = mk();
    const codex = h.createTab({ backend: 'codex' });
    expect(() => h.setTabReasoningEffort(codex.id, 'max')).toThrow();

    const claude = h.createTab({ backend: 'claude' });
    expect(() => h.setTabReasoningEffort(claude.id, 'minimal')).toThrow();
    expect(h.setTabReasoningEffort(claude.id, 'max').reasoningEffort).toBe('max');

    const grok = h.createTab({ backend: 'grok' });
    expect(h.setTabReasoningEffort(grok.id, 'max').reasoningEffort).toBe('max');
  });

  it('claude / grok 接受各自目录模型与合法自定义模型 id', () => {
    const h = mk();
    const claude = h.createTab({ backend: 'claude' });
    expect(h.setTabModel(claude.id, 'sonnet').modelOverride).toBe('sonnet');
    expect(h.setTabModel(claude.id, 'claude-opus-4-8').modelOverride).toBe('claude-opus-4-8');

    const grok = h.createTab({ backend: 'grok' });
    expect(h.setTabModel(grok.id, 'grok-4.6').modelOverride).toBe('grok-4.6');
    // grok 非推理模型：档位被清掉
    const nonReasoning = h.setTabModel(grok.id, 'grok-4-1-fast-non-reasoning');
    expect(nonReasoning.modelOverride).toBe('grok-4-1-fast-non-reasoning');
    expect(nonReasoning.reasoningEffort).toBeNull();
  });

  it('允许合法的自定义模型 id（官方新模型兜底）', () => {
    const h = mk();
    const tab = h.createTab({ backend: 'codex' });
    expect(h.setTabModel(tab.id, 'gpt-7-codex-preview').modelOverride).toBe('gpt-7-codex-preview');
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

    h.setTabModel(tab.id, 'sonnet');
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
    expect(second[second.indexOf('--model') + 1]).toBe('sonnet');
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
    h.setTabModel(tab.id, 'sonnet');
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
    h1.setTabModel(claude.id, 'opus');
    h1.setTabReasoningEffort(claude.id, 'max');
    h1.dispose();

    const h2 = mk();
    const g2 = h2.listTabs().tabs.find((x) => x.id === grok.id)!;
    expect(g2.modelOverride).toBe('grok-4.7');
    expect(g2.reasoningEffort).toBe('xhigh');
    const c2 = h2.listTabs().tabs.find((x) => x.id === claude.id)!;
    expect(c2.modelOverride).toBe('opus');
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

  it('持久化还原时按目标后端档位集校正（codex 的 max 被丢弃）', () => {
    const h1 = mk();
    const tab = h1.createTab({ backend: 'codex' });
    h1.setTabModel(tab.id, 'gpt-5.6-sol');
    h1.dispose();
    // 手动写入一个对 codex 不合法的档位，模拟旧版本 / 脏数据（tab 元数据在 tabs.json）
    const file = path.join(root, 'tabs.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const target = (raw.tabs as Array<{ id: string; reasoningEffort?: string }>).find(
      (x) => x.id === tab.id,
    )!;
    target.reasoningEffort = 'max';
    fs.writeFileSync(file, JSON.stringify(raw));
    const h2 = mk();
    const restored = h2.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(restored.modelOverride).toBe('gpt-5.6-sol');
    expect(restored.reasoningEffort).toBeNull();
  });
});
