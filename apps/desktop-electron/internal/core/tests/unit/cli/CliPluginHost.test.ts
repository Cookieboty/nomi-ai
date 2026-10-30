/**
 * 插件宿主（P9.3）与内置插件契约（P9.7，带主进程补上的转录解析与历史版本夹具）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import path from 'node:path';

import { BUILTIN_PLUGINS } from '@nomi-ai/cli-plugins/main';
import type { CliPlugin } from '@nomi-ai/cli-sdk';
import { checkPlugin, type HistoryFixture } from '@nomi-ai/cli-sdk/testing';
import { repoPath } from '@nomi-ai/repo-paths';

import { CliPluginHost, inRange } from '../../../src/cli/CliPluginHost';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

const FIXTURES = repoPath('packages/cli-plugins/fixtures/history');

function fixturesOf(id: string): HistoryFixture[] {
  const dir = path.join(FIXTURES, id);
  const out: HistoryFixture[] = [];
  for (const version of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const expect = JSON.parse(fs.readFileSync(path.join(dir, version, 'expect.json'), 'utf8'));
    for (const [file, e] of Object.entries(expect as Record<string, HistoryFixture['expect']>))
      out.push({
        name: `${id}/${version}/${file}`,
        path: path.join(dir, version, file),
        text: fs.readFileSync(path.join(dir, version, file), 'utf8'),
        expect: e,
      });
  }
  return out;
}

const logger = { info: jest.fn(), warn: jest.fn() };

describe('内置插件契约（主进程补上转录解析后）', () => {
  for (const [id, plugin] of Object.entries(BUILTIN_PLUGINS))
    it(`${id}：契约全部通过，历史版本夹具都能解析`, async () => {
      const fixtures = fixturesOf(id);
      expect(fixtures.length).toBeGreaterThan(0);
      expect(
        await checkPlugin(plugin, {
          historyFixtures: fixtures,
        }),
      ).toEqual([]);
    });
});

describe('CliPluginHost', () => {
  const good = BUILTIN_PLUGINS.grok;

  it('清单校验失败的不注册；工厂抛错只影响这一个插件（出错隔离）', async () => {
    const broken: CliPlugin = {
      manifest: { ...good.manifest, id: 'Bad Id' },
      main: () => ({}) as never,
    };
    const throws: CliPlugin = {
      manifest: { ...good.manifest, id: 'throws' },
      main: () => {
        throw new Error('boom');
      },
    };
    const sent: unknown[] = [];
    const host = new CliPluginHost({
      logger,
      root: '/tmp/nomi-plugins',
      plugins: { grok: good, broken, throws },
      events: { publish: (_c, p) => sent.push(p) },
    });
    await host.start();
    const snap = host.snapshot();
    const by = (id: string) => snap.plugins.find((p) => p.id === id)!;
    expect(by('grok')).toMatchObject({ status: 'ready', errors: [] });
    expect(by('Bad Id').status).toBe('invalid');
    expect(by('Bad Id').errors.join()).toMatch(/id must match/);
    expect(by('throws')).toMatchObject({ status: 'failed', errors: ['boom'] });
    expect(host.impl('grok')?.history).toBeDefined();
    expect(host.impl('throws')).toBeUndefined();
    expect(sent.length).toBeGreaterThan(0);
  });

  it('有效能力 = 清单 ∩ 版本开关 ∩ 握手；版本变了重新算', async () => {
    const gated: CliPlugin = {
      manifest: {
        ...good.manifest,
        id: 'gated',
        versionGates: [{ range: '>=2.0.0', capabilities: { fork: true } }],
      },
      main: good.main,
    };
    let version = '1.9.0';
    const changes: string[] = [];
    const host = new CliPluginHost({
      logger,
      root: '/tmp/nomi-plugins',
      plugins: { gated },
      version: async () => version,
      events: createRecordingAppEvents(),
      onVersionChange: (id, from, to) => changes.push(`${id}:${from}->${to}`),
    });
    await host.start();
    await host.refreshVersions();
    expect(host.capabilities('gated')).toMatchObject({ fork: false, images: 'native' });
    version = '2.1.0';
    await host.refreshVersions();
    expect(host.capabilities('gated')?.fork).toBe(true);
    host.setHandshake('gated', { images: false, subagents: false });
    expect(host.capabilities('gated')).toMatchObject({ images: 'none', subagents: false });
    expect(host.snapshot().plugins[0]!.version).toBe('2.1.0');
    // 第一次读到版本不算「换了版本」；之后的变化通知编排层（P9.6）
    expect(changes).toEqual(['gated:1.9.0->2.1.0']);
  });

  it('默认加载全部内置插件；注册表快照给界面（契约 cli.registry）', async () => {
    const host = new CliPluginHost({
      logger,
      root: '/tmp/nomi-plugins',
      events: createRecordingAppEvents(),
    });
    await host.start();
    const snap = host.snapshot();
    expect(snap.plugins.map((p) => p.id).sort()).toEqual([
      'claude',
      'codex',
      'dsh',
      'gemini',
      'grok',
    ]);
    expect(snap.plugins.every((p) => p.builtin && p.status === 'ready')).toBe(true);
    // 快照里没有主进程实现
    expect(JSON.stringify(snap)).not.toMatch(/function/);
    host.stop();
    expect(host.snapshot().plugins).toEqual([]);
  });

  it('inRange：空格分隔的比较式全部满足才算', () => {
    expect(inRange('1.0.67', '>=1.0.60')).toBe(true);
    expect(inRange('1.0.59', '>=1.0.60')).toBe(false);
    expect(inRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(inRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(inRange('1.2.3', '1.2.3')).toBe(true);
    expect(inRange('1.2.3', 'garbage')).toBe(false);
  });
});
