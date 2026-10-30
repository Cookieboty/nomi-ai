/**
 * 每条助手消息记下产生它的模型（界面在消息元信息里展示）：
 * 第三方 = 这一轮发给网关的模型；官方 = CLI 上报的实际模型 → 标签选的模型 → 目录默认；都不知道就不记。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { testGateway } from '../../helpers/gateway';
import { CliHarnessService } from '../helpers/harness';

const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ENV_KEYS = ['NOMI_CODEX_BIN', 'NOMI_CLAUDE_BIN', 'NOMI_USE_MOCK_CLI'];

/** 不报告模型的 codex exec 替身 */
function silentCodex(dir: string): string {
  const bin = path.join(dir, 'silent-codex.mjs');
  fs.writeFileSync(
    bin,
    [
      "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "emit({ type: 'thread.started', thread_id: 't1' });",
      "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } });",
      "emit({ type: 'turn.completed', usage: {} });",
    ].join('\n'),
  );
  return bin;
}

describe('助手消息上的模型', () => {
  let saved: Record<string, string | undefined> = {};
  const made: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    delete process.env.NOMI_USE_MOCK_CLI;
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (gw: ReturnType<typeof testGateway>) => {
    const root = tmp('harness-msgmodel-');
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      home: root,
      gateway: gw,
      prewarmClaude: false,
      codexAppServer: false,
    });
    made.push(h);
    return h;
  };
  const lastAssistant = (h: CliHarnessService, id: string) =>
    h
      .tabMessages(id)
      .filter((m) => m.role === 'assistant')
      .at(-1);

  it('第三方：记这一轮发给网关的模型（不是 CLI 报的名字）；换模型后下一条记新模型', async () => {
    const gw = testGateway({
      source: 'thirdParty',
      tabTokens: true,
      models: ['gw/main', 'gw/other'],
    });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'claude', source: 'thirdParty' });
    await h.sendTab(tab.id, 'hi');
    expect(lastAssistant(h, tab.id)?.model).toBe('gw/main');
    h.setTabModel(tab.id, 'gw/other');
    await h.sendTab(tab.id, 'again');
    expect(lastAssistant(h, tab.id)?.model).toBe('gw/other');
  }, 20_000);

  it('官方：用 CLI 上报的实际模型；选了模型时是 CLI 按所选模型报的名字', async () => {
    const gw = testGateway({ source: 'official' });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'claude' });
    await h.sendTab(tab.id, 'hi');
    expect(lastAssistant(h, tab.id)?.model).toBe('mock-claude');
    h.setTabModel(tab.id, 'claude-opus-mock');
    await h.sendTab(tab.id, 'again');
    expect(lastAssistant(h, tab.id)?.model).toBe('claude-opus-mock');
  }, 20_000);

  it('官方、CLI 不报模型也没选模型、目录里没有默认：不记（不猜）', async () => {
    process.env.NOMI_CODEX_BIN = silentCodex(tmp('nomi-msgmodel-codex-'));
    const gw = testGateway({ source: 'official' });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'codex' });
    await h.sendTab(tab.id, 'hi');
    const m = lastAssistant(h, tab.id);
    expect(m?.content).toBe('ok');
    expect(m).not.toHaveProperty('model');
  }, 20_000);

  it('官方、CLI 不报模型但选了模型：记所选模型', async () => {
    process.env.NOMI_CODEX_BIN = silentCodex(tmp('nomi-msgmodel-codex2-'));
    const gw = testGateway({ source: 'official' });
    const h = mk(gw);
    const tab = h.createTab({ backend: 'codex' });
    h.setTabModel(tab.id, 'gpt-mock');
    await h.sendTab(tab.id, 'hi');
    expect(lastAssistant(h, tab.id)?.model).toBe('gpt-mock');
  }, 20_000);
});
