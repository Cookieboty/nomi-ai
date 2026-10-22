/**
 * CLI 版本检测的缓存：本机探测（路径 + --version）短期缓存且并发共用；
 * 「最新版本」过期时先返回旧值、后台刷新，网络失败不冲掉已知值。
 */
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('../../../src/cli/detect', () => ({
  ...jest.requireActual('../../../src/cli/detect'),
  resolveCliBinAsync: jest.fn(async (kind: string) => (kind === 'claude' ? '/bin/claude' : null)),
  readVersionAsync: jest.fn(async () => '1.0.0'),
  fetchNpmLatest: jest.fn(async () => '2.0.0'),
}));

import { CliUpdateService } from '../../../src/cli/CliUpdateService';
import * as detect from '../../../src/cli/detect';
import type { CliInstallInfo } from '../../../src/cli/types';

const resolveBin = detect.resolveCliBinAsync as jest.Mock;
const fetchLatest = detect.fetchNpmLatest as jest.Mock;

let tmp = '';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-inspect-'));
  resolveBin.mockClear();
  fetchLatest.mockClear();
  fetchLatest.mockImplementation(async () => '2.0.0');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const make = () =>
  new CliUpdateService({
    root: tmp,
    logger: { info: jest.fn(), warn: jest.fn() } as never,
    silent: true,
  });
const claude = (rows: CliInstallInfo[]) => rows.find((r) => r.kind === 'claude')!;
const writeCache = (checkedAt: number, latest: string) =>
  fs.writeFileSync(
    path.join(tmp, 'cache.json'),
    JSON.stringify({
      checkedAt,
      latest: { claude: latest, codex: latest, dsh: latest, grok: latest, gemini: latest },
    }),
  );

describe('inspect caching', () => {
  it('本机探测并发共用一次，之后在有效期内直接复用；显式检查会重新探测', async () => {
    writeCache(Date.now(), '2.0.0');
    const s = make();
    await Promise.all([s.inspect(), s.inspect()]);
    const once = resolveBin.mock.calls.length;
    expect(once).toBe(6); // 6 个端点各探测一次
    await s.inspect();
    expect(resolveBin.mock.calls.length).toBe(once);
    await s.inspect(true);
    expect(resolveBin.mock.calls.length).toBe(once * 2);
  });

  it('最新版本过期时先返回旧值，不等网络；后台刷新后下次拿到新值', async () => {
    writeCache(Date.now() - 7 * 60 * 60_000, '1.5.0');
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    fetchLatest.mockImplementation(async () => {
      await gate;
      return '2.0.0';
    });
    const s = make();
    expect(claude(await s.inspect()).latest).toBe('1.5.0');
    expect(fetchLatest).toHaveBeenCalledTimes(5);
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(claude(await s.inspect()).latest).toBe('2.0.0');
    // 刷新过：不再重复查询
    expect(fetchLatest).toHaveBeenCalledTimes(5);
  });

  it('网络失败（null）不冲掉已知的最新版本', async () => {
    writeCache(Date.now(), '1.5.0');
    fetchLatest.mockImplementation(async () => null);
    const s = make();
    expect(claude(await s.inspect(true)).latest).toBe('1.5.0');
  });
});
