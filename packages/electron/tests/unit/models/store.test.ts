// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import { existsSync, readdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';

import { downloadVerified } from '../../../src/models/download';
import { ModelStore } from '../../../src/models/ModelStore';
import { makeTinyVrm, solidPng } from '../../fixtures/tinyVrm';

import { mockServer, sha, tmp, type MockServer } from './helpers';

const policy = { allowLoopbackHttp: true };

describe('downloadVerified', () => {
  let srv: MockServer;
  beforeEach(async () => {
    srv = await mockServer();
  });
  afterEach(() => srv.close());

  it('resumes an interrupted download with Range and verifies sha256', async () => {
    const body = makeTinyVrm({ padBytes: 200_000 });
    srv.routes.set('/m.vrm', { body, cutAfter: 50_000 });
    const dest = path.join(tmp(), 'm.vrm');
    const seen: number[] = [];
    await downloadVerified(
      { urls: [`${srv.url}/m.vrm`], sha256: sha(body), size: body.length },
      dest,
      {
        policy,
        onProgress: (p) => seen.push(p.received),
      },
    );
    expect(sha(await fsp.readFile(dest))).toBe(sha(body));
    expect(
      srv.hits
        .filter((h) => h.path === '/m.vrm')
        .some((h) => /^bytes=\d+-$/.test(String(h.headers.range))),
    ).toBe(true);
    expect(seen.at(-1)).toBe(body.length);
  });

  it('idleTimeoutMs aborts a connection that never sends data (#33)', async () => {
    const body = makeTinyVrm();
    srv.routes.set('/hang.vrm', { body, hang: true });
    const t0 = Date.now();
    await expect(
      downloadVerified(
        { urls: [`${srv.url}/hang.vrm`], sha256: sha(body), size: body.length },
        path.join(tmp(), 'm.vrm'),
        { policy, attemptsPerUrl: 1, idleTimeoutMs: 150 },
      ),
    ).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('rejects a sha256 mismatch and leaves no file behind', async () => {
    const body = makeTinyVrm();
    srv.routes.set('/m.vrm', { body });
    const dest = path.join(tmp(), 'm.vrm');
    await expect(
      downloadVerified(
        { urls: [`${srv.url}/m.vrm`], sha256: 'b'.repeat(64), size: body.length },
        dest,
        { policy },
      ),
    ).rejects.toThrow(/sha256/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('aborts when the server sends more than the declared size', async () => {
    const body = makeTinyVrm({ padBytes: 10_000 });
    srv.routes.set('/m.vrm', { body });
    await expect(
      downloadVerified(
        { urls: [`${srv.url}/m.vrm`], sha256: sha(body), size: 100 },
        path.join(tmp(), 'x'),
        { policy },
      ),
    ).rejects.toThrow(/大小/);
  });

  it('falls back to the next mirror', async () => {
    const body = makeTinyVrm();
    srv.routes.set('/ok.vrm', { body });
    const dest = path.join(tmp(), 'm.vrm');
    await downloadVerified(
      {
        urls: [`${srv.url}/missing.vrm`, `${srv.url}/ok.vrm`],
        sha256: sha(body),
        size: body.length,
      },
      dest,
      { policy },
    );
    expect(existsSync(dest)).toBe(true);
  });

  it('refuses plain http without the loopback test policy', async () => {
    await expect(
      downloadVerified(
        { urls: ['http://127.0.0.1:1/x'], sha256: 'a'.repeat(64), size: 1 },
        path.join(tmp(), 'x'),
      ),
    ).rejects.toThrow();
  });
});

describe('ModelStore', () => {
  let srv: MockServer;
  let root: string;
  const vrm = makeTinyVrm({ title: 'Store Girl' });
  const thumb = solidPng(4, 4, [1, 2, 3]);
  const catalog = (version = '1.0.0', body = vrm) => ({
    schemaVersion: 1,
    models: [
      {
        id: 'store-girl',
        name: 'Store Girl',
        author: 'tests',
        license: 'CC0-1.0',
        source: 'https://example.com',
        version,
        vrmVersion: '0.x',
        tags: [],
        credit: 'Store Girl (CC0)',
        vrm: { urls: [`${srv.url}/v/${version}.vrm`], sha256: sha(body), size: body.length },
        thumbnail: { urls: [`${srv.url}/t.png`], sha256: sha(thumb), size: thumb.length },
      },
      {
        id: 'proprietary',
        name: 'Nope',
        author: 'x',
        license: 'LicenseRef-Proprietary',
        source: 'https://example.com',
        version: '1.0.0',
        vrmVersion: '0.x',
        tags: [],
        credit: 'x',
        vrm: { urls: [`${srv.url}/v/1.0.0.vrm`], sha256: sha(body), size: body.length },
        thumbnail: { urls: [`${srv.url}/t.png`], sha256: sha(thumb), size: thumb.length },
      },
    ],
  });

  beforeEach(async () => {
    srv = await mockServer();
    root = tmp();
    srv.routes.set('/catalog.json', { body: JSON.stringify(catalog()), etag: '"v1"' });
    srv.routes.set('/v/1.0.0.vrm', { body: vrm });
    srv.routes.set('/t.png', { body: thumb });
  });
  afterEach(() => srv.close());

  const store = () => new ModelStore({ root, catalogUrls: [`${srv.url}/catalog.json`], policy });

  it('fetches, filters non-open licences, caches thumbnails', async () => {
    const s = await store().getState(true);
    expect(s.offline).toBe(false);
    expect(s.entries.map((e) => e.id)).toEqual(['store-girl']);
    expect(s.rejected).toEqual([expect.objectContaining({ id: 'proprietary' })]);
    expect(s.entries[0]?.thumbnailUrl).toMatch(/^cdmodel:\/\/cache\/thumbs\//);
  });

  it('uses ETag (304) and works offline from cache', async () => {
    await store().getState(true);
    const second = await store().getState(true);
    expect(
      srv.hits.filter((h) => h.path === '/catalog.json').at(-1)?.headers['if-none-match'],
    ).toBe('"v1"');
    expect(second.entries).toHaveLength(1);
    await srv.close();
    const offline = await store().getState(true);
    expect(offline.offline).toBe(true);
    expect(offline.entries).toHaveLength(1);
    srv = await mockServer(); // afterEach 关闭
  });

  it('installs, detects updates, removes', async () => {
    const st = store();
    await st.getState(true);
    const rec = await st.install('store-girl');
    expect(rec.version).toBe('1.0.0');
    expect(await st.verifyInstalled('store-girl')).toBe(true);
    expect(existsSync(path.join(st.remoteDir, 'store-girl', 'thumb.png'))).toBe(true);

    const v2 = makeTinyVrm({ title: 'Store Girl v2', color: [9, 9, 9] });
    srv.routes.set('/catalog.json', { body: JSON.stringify(catalog('1.1.0', v2)), etag: '"v2"' });
    srv.routes.set('/v/1.1.0.vrm', { body: v2 });
    const s2 = await st.getState(true);
    expect(s2.entries[0]).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true });
    await st.install('store-girl');
    expect((await st.listInstalled())[0]?.version).toBe('1.1.0');

    await st.remove('store-girl');
    expect(await st.listInstalled()).toEqual([]);
  });

  it('refuses to install a file that is not a VRM even if the hash matches', async () => {
    const junk = Buffer.from('definitely not a vrm');
    const c = catalog('1.0.0', junk);
    srv.routes.set('/catalog.json', { body: JSON.stringify(c) });
    srv.routes.set('/v/1.0.0.vrm', { body: junk });
    const st = store();
    await st.getState(true);
    await expect(st.install('store-girl')).rejects.toThrow();
    expect(await st.listInstalled()).toEqual([]);
  });

  describe('optional thumbnail never blocks or outlives the core install (#33)', () => {
    const fast = { thumbIdleMs: 200, thumbTotalMs: 1000, listBudgetMs: 300 };
    const fastStore = () =>
      new ModelStore({
        root,
        catalogUrls: [`${srv.url}/catalog.json`],
        policy,
        timeouts: fast,
      });
    const waitHit = async (p: string) => {
      for (let i = 0; i < 100 && !srv.hits.some((h) => h.path === p); i++)
        await new Promise((r) => setTimeout(r, 30));
      expect(srv.hits.some((h) => h.path === p)).toBe(true);
    };

    it('install completes without a thumbnail when the thumbnail request hangs', async () => {
      srv.routes.set('/t.png', { body: thumb, hang: true });
      const st = fastStore();
      await st.getState(true);
      const t0 = Date.now();
      const rec = await st.install('store-girl');
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(rec.version).toBe('1.0.0');
      expect(await st.verifyInstalled('store-girl')).toBe(true);
      expect(existsSync(path.join(st.remoteDir, 'store-girl', 'thumb.png'))).toBe(false);
      expect(st.isDownloading('store-girl')).toBe(false);
    }, 15_000);

    it('cancel during the thumbnail stage aborts the request, reports no success and keeps the old version', async () => {
      const st = fastStore();
      await st.getState(true);
      await st.install('store-girl'); // 旧版本 1.0.0（缩略图正常）
      const oldSha = sha(vrm);

      const v2 = makeTinyVrm({ title: 'Store Girl v2', color: [9, 9, 9] });
      srv.routes.set('/catalog.json', { body: JSON.stringify(catalog('1.1.0', v2)), etag: '"v2"' });
      srv.routes.set('/v/1.1.0.vrm', { body: v2 });
      srv.routes.set('/t.png', { body: thumb, hang: true });
      await st.getState(true);
      // 长时限：证明是取消（而不是超时）结束了缩略图阶段
      const slow = new ModelStore({
        root,
        catalogUrls: [`${srv.url}/catalog.json`],
        policy,
        timeouts: { thumbIdleMs: 60_000, thumbTotalMs: 60_000, listBudgetMs: 300 },
      });
      await slow.getState(false);
      const before = srv.hits.filter((h) => h.path === '/t.png').length;
      const run = slow.install('store-girl').then(
        () => 'ok',
        (e: Error) => e.message,
      );
      for (let i = 0; i < 100 && srv.hits.filter((h) => h.path === '/t.png').length <= before; i++)
        await new Promise((r) => setTimeout(r, 30));
      slow.cancel('store-girl');
      const result = await run;
      expect(result).not.toBe('ok');
      expect(slow.isDownloading('store-girl')).toBe(false);
      const installed = await slow.listInstalled();
      expect(installed[0]?.version).toBe('1.0.0');
      expect(sha(await fsp.readFile(path.join(slow.remoteDir, 'store-girl', 'model.vrm')))).toBe(
        oldSha,
      );
      expect(
        existsSync(path.join(slow.remoteDir, 'store-girl', 'download-thumb.png')) ||
          existsSync(path.join(slow.remoteDir, 'store-girl', 'installed.json.tmp')),
      ).toBe(false);
      // 已下完并校验过的新版本暂存 VRM 也要删掉，不能留一整份在磁盘上（#33）
      const left = readdirSync(path.join(slow.remoteDir, 'store-girl')).filter((f) =>
        /^download-.*\.vrm/.test(f),
      );
      expect(left).toEqual([]);
    }, 20_000);

    it('a slow thumbnail does not hold up the store list; it arrives from cache later', async () => {
      srv.routes.set('/t.png', { body: thumb, hang: true });
      const st = fastStore();
      const t0 = Date.now();
      const s = await st.getState(true);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(s.entries).toHaveLength(1);
      expect(s.entries[0]?.thumbnailUrl).toBeUndefined();
      await waitHit('/t.png');
      srv.routes.set('/t.png', { body: thumb });
      await new Promise((r) => setTimeout(r, 1500)); // 后台那一次按空闲超时结束
      const again = await st.getState(false);
      expect(again.entries[0]?.thumbnailUrl).toMatch(/^cdmodel:\/\/cache\/thumbs\//);
    }, 15_000);
  });
});
