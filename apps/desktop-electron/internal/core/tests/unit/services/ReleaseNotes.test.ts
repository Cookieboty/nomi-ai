jest.unmock('fs');
jest.unmock('node:fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReleaseNotes } from '../../../src/services/ReleaseNotes';
import { whenPrivateWritesIdle } from '../../../src/utils/privateFile';

/** 与 Go 版 releasenotes_test.go 同样的场景 */
describe('ReleaseNotes', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  });
  afterEach(async () => {
    await whenPrivateWritesIdle();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const manifests: Record<string, unknown> = {
    '2.0.8': {
      version: '2.0.8',
      releaseDate: '2026-11-02T00:00:00Z',
      releaseNotes: '# Nomi 2.0.8\n\n- 修复 / Fixed',
    },
    // 2.0.8 之前的清单没有 releaseNotes
    '2.0.7': { version: '2.0.7' },
  };
  const fakeFetch = () => {
    const urls: string[] = [];
    let offline = false;
    const fn = jest.fn(async (url: string) => {
      urls.push(url);
      if (offline) throw new TypeError('fetch failed');
      const v = /\/v([^/]+)\/latest-go\.json$/.exec(url)?.[1] ?? '';
      const m = manifests[v];
      return m
        ? new Response(JSON.stringify(m), { status: 200 })
        : new Response('Not Found', { status: 404 });
    });
    return { fn, urls, goOffline: () => (offline = true) };
  };

  it('取当前版本的说明并缓存；之后（离线时）读缓存', async () => {
    const f = fakeFetch();
    const file = path.join(dir, 'release-notes.json');
    const n = new ReleaseNotes({ version: () => '2.0.8', file, fetchImpl: f.fn });
    const got = await n.get();
    expect(got).toEqual({
      version: '2.0.8',
      notes: '# Nomi 2.0.8\n\n- 修复 / Fixed',
      releaseDate: '2026-11-02T00:00:00Z',
    });
    expect(f.urls).toEqual([
      'https://github.com/Cookieboty/nomi-ai/releases/download/v2.0.8/latest-go.json',
    ]);
    await whenPrivateWritesIdle();
    expect(fs.existsSync(file)).toBe(true);

    f.goOffline();
    const again = await new ReleaseNotes({ version: () => '2.0.8', file, fetchImpl: f.fn }).get(
      '2.0.8',
    );
    expect(again).toEqual(got);
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it('旧版本清单没有说明、版本不存在、离线时返回 null；非法版本号不发请求', async () => {
    const f = fakeFetch();
    const n = new ReleaseNotes({ version: () => '0.0.0-dev', file: null, fetchImpl: f.fn });
    expect(await n.get('2.0.7')).toEqual({ version: '2.0.7', notes: null });
    expect(await n.get('9.9.9')).toEqual({ version: '9.9.9', notes: null });
    const calls = f.fn.mock.calls.length;
    for (const v of ['../../etc', 'latest', '2.0.8/../x']) {
      expect((await n.get(v)).notes).toBeNull();
    }
    expect(f.fn).toHaveBeenCalledTimes(calls);
    f.goOffline();
    expect(await n.get('2.0.8')).toEqual({ version: '2.0.8', notes: null });
  });

  it('只缓存最近 5 个版本', async () => {
    const file = path.join(dir, 'release-notes.json');
    let now = 0;
    const n = new ReleaseNotes({
      version: () => '2.0.1',
      file,
      now: () => ++now,
      fetchImpl: async (url) => {
        const v = /\/v([^/]+)\/latest-go\.json$/.exec(url)![1]!;
        return new Response(JSON.stringify({ version: v, releaseNotes: `notes ${v}` }));
      },
    });
    for (let i = 1; i <= 7; i++) await n.get(`2.0.${i}`);
    await whenPrivateWritesIdle();
    const entries = (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: object }).entries;
    expect(Object.keys(entries).sort()).toEqual(['2.0.3', '2.0.4', '2.0.5', '2.0.6', '2.0.7']);
  });
});
