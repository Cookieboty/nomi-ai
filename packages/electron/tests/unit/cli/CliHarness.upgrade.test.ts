/**
 * CLI 升级策略（P9.6）：升级后空闲的长驻进程立刻拆、进行中的这一轮结束后再拆，官方与第三方标签都算；
 * 不动标签的来源、模型与账号，下一条消息用新版本续接。
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

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('restartForUpgrade', () => {
  const saved = { ...process.env };
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });

  const mkHarness = () => {
    process.env.NOMI_CLAUDE_BIN = path.resolve(
      __dirname,
      '../../../scripts/mock-cli/mock-claude.mjs',
    );
    delete process.env.NOMI_USE_MOCK_CLI;
    const h = new CliHarnessService({
      root: tmp('nomi-upgrade-'),
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      gateway: testGateway(),
      prewarmClaude: true,
    });
    made.push(h);
    const live = (
      h as unknown as {
        claudeLive: Map<string, { turn: unknown; recycleAfterTurn?: boolean }>;
      }
    ).claudeLive;
    return { h, live };
  };

  it('空闲的进程立刻拆（官方与第三方都算），不动来源与模型', () => {
    const { h, live } = mkHarness();
    const official = h.createTab({ backend: 'claude', modelOverride: 'claude-opus-x' });
    const third = h.createTab({ backend: 'claude', source: 'thirdParty' });
    expect(live.has(official.id)).toBe(true);
    expect(live.has(third.id)).toBe(true);
    const pick = () =>
      h
        .listTabs()
        .tabs.filter((x) => x.id === official.id || x.id === third.id)
        .map((x) => [x.id, x.source, x.modelOverride ?? null, x.accountId ?? null]);
    const before = pick();
    expect(before.find((x) => x[0] === official.id)?.[2]).toBe('claude-opus-x');
    expect(h.restartForUpgrade('claude')).toEqual({ restarted: 2, deferred: 0 });
    expect(live.size).toBe(0);
    expect(pick()).toEqual(before);
  });

  it('进行中的轮次不打断：这一轮结束后再拆', () => {
    const { h, live } = mkHarness();
    const tab = h.createTab({ backend: 'claude' });
    const l = live.get(tab.id)!;
    l.turn = { settled: false };
    expect(h.restartForUpgrade('claude')).toEqual({ restarted: 0, deferred: 1 });
    expect(live.get(tab.id)).toBe(l);
    expect(l.recycleAfterTurn).toBe(true);
    l.turn = null;
  });

  it('其它 CLI 的进程不受影响；busyTurns 只数这个 CLI 正在进行的轮次', () => {
    const { h, live } = mkHarness();
    const tab = h.createTab({ backend: 'claude' });
    expect(h.restartForUpgrade('codex')).toEqual({ restarted: 0, deferred: 0 });
    expect(live.has(tab.id)).toBe(true);
    expect(h.busyTurns('claude')).toBe(0);
  });
});
