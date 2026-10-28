/**
 * 回归 #29：撤销文件夹授权后，知识库检索 / 重排 / 问答不能再使用缓存片段；
 * 索引运行中撤权不能写回可检索条目；仍被授权的目录（含交叠）不受影响。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PermissionBroker } from '../../../src/desktop/PermissionBroker';
import type { DocRec } from '../../../src/knowledge/KnowledgeIndex';
import { KnowledgeService } from '../../../src/knowledge/KnowledgeService';
import { until } from '../../helpers/wait';
import { featureDeps } from '../helpers/featureHost';

function setup() {
  // 用 native realpath：与 PermissionBroker / 索引（fs.promises.realpath，libuv）同一口径。
  // Windows 上 os.tmpdir() 常是 8.3 短路径（C:\Users\RUNNER~1\...），JS 版 realpathSync
  // 不展开短文件名，而索引写入的是展开后的长路径，期望值会对不上。
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-revoke-')));
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'plan.md'), 'ALPHA quarterly secret roadmap');
  fs.writeFileSync(path.join(b, 'note.md'), 'BETA quarterly public note');
  const broker = new PermissionBroker(
    path.join(root, 'data', 'settings.json'),
    {
      home: root,
      platform: process.platform,
      realpath: (p) => fs.promises.realpath(p),
      denyRoots: [path.join(root, 'data')],
    },
    { timeoutMs: 500 },
  );
  const scopeA = broker.grant(a, 'read');
  const scopeB = broker.grant(b, 'read');
  const asked: string[] = [];
  const svc = new KnowledgeService({
    root: path.join(root, 'kb'),
    logger: { info() {}, warn() {}, error() {} } as never,
    desktop: {
      broker,
      audit: { append() {} },
      notes: { list: () => [] },
      receiversFor: () => [{ id: 'p', name: 'p', local: true }],
      checkSendAll: async () => 'ok',
    } as never,
    listProviders: () => [],
    credentials: () => null,
    chatProvider: () => ({ id: 'p', name: 'p', baseURL: 'http://localhost:1' }),
    complete: async (m: unknown) => {
      asked.push(JSON.stringify(m));
      return 'answer';
    },
    ...featureDeps(),
  } as never);
  const priv = svc as unknown as {
    settings: { sources: Array<Record<string, unknown>>; embed: unknown };
  };
  const put = (id: string, sourceId: string, file: string, text: string) => {
    const rec: DocRec = {
      id,
      sourceId,
      path: file,
      title: path.basename(file),
      ext: 'md',
      mtime: 1,
      size: 1,
      indexedAt: 1,
      status: 'ok',
      chunks: [{ id: `${id}:0`, text, offset: 0 }],
    };
    svc.index.put(rec);
  };
  priv.settings.sources.push(
    { id: 'sa', kind: 'folder', path: a, addedAt: 1, enabled: true },
    { id: 'sb', kind: 'folder', path: b, addedAt: 1, enabled: true },
  );
  put('da', 'sa', path.join(a, 'plan.md'), 'ALPHA quarterly secret roadmap');
  put('db', 'sb', path.join(b, 'note.md'), 'BETA quarterly public note');
  return { root, a, b, broker, scopeA, scopeB, svc, asked };
}

describe('知识库撤权（#29）', () => {
  it('授权有效时两个来源都可检索', async () => {
    const t = setup();
    const r = await t.svc.search('quarterly');
    expect(r.hits.map((h) => h.docId).sort()).toEqual(['da', 'db']);
  });

  it('撤销文件夹授权后：search 立即不再返回该来源片段，其余来源不受影响', async () => {
    const t = setup();
    t.broker.revoke(t.scopeA.id);
    const r = await t.svc.search('quarterly');
    expect(r.hits.map((h) => h.docId)).toEqual(['db']);
    expect(JSON.stringify(r.hits)).not.toContain('ALPHA');
  });

  it('撤销后 ask() 不会把被撤权片段放进模型提示词；只剩撤权片段时视为无结果', async () => {
    const t = setup();
    t.broker.revoke(t.scopeA.id);
    const q = await t.svc.ask('roadmap ALPHA');
    expect(q.sources).toEqual([]);
    expect(t.asked.join('')).not.toContain('ALPHA');
  });

  it('kb_search 工具同样不返回被撤权片段', async () => {
    const t = setup();
    t.broker.revoke(t.scopeA.id);
    const tool = t.svc.tools().find((x) => x.name === 'kb_search')!;
    const r = await tool.execute(
      { query: 'ALPHA roadmap' },
      {
        provider: { id: 'p', baseURL: 'http://localhost:1' },
      },
    );
    expect(JSON.stringify(r)).not.toContain('ALPHA');
  });

  it('撤权后缓存被立即清理（不等 30 分钟增量索引），并通知渲染进程', async () => {
    const t = setup();
    t.svc.start();
    t.broker.revoke(t.scopeA.id);
    await until(() => t.svc.index.get('da') === undefined, { what: 'revoked source purged' });
    expect(t.svc.index.get('db')).toBeDefined();
    await t.svc.dispose();
  });

  it('交叠授权：撤销某一个 scope 但路径仍被另一个授权覆盖时，来源继续可用', async () => {
    const t = setup();
    const parent = t.broker.grant(t.root, 'read'); // 覆盖 a 和 b
    t.broker.revoke(t.scopeA.id);
    expect((await t.svc.search('quarterly')).hits.map((h) => h.docId).sort()).toEqual(['da', 'db']);
    t.broker.revoke(parent.id);
    expect((await t.svc.search('quarterly')).hits.map((h) => h.docId)).toEqual(['db']);
  });

  it('重新授权后下一次索引可恢复（来源没有被删除）', async () => {
    const t = setup();
    t.broker.revoke(t.scopeA.id);
    await t.svc.search('quarterly');
    await until(() => t.svc.index.get('da') === undefined, { what: 'revoked source purged' });
    t.broker.grant(t.a, 'read');
    await t.svc.reindex(['sa']);
    const r = await t.svc.search('ALPHA');
    expect(r.hits.map((h) => h.path)).toEqual([path.join(t.a, 'plan.md')]);
  });

  it('索引过程中撤权：写回前再校验，不会产生可检索条目', async () => {
    const t = setup();
    const file = path.join(t.a, 'plan.md');
    t.svc.index.remove('da');
    // 在嵌入阶段撤权：withVectors 完成后才会走到写回
    const priv = t.svc as unknown as {
      withVectors: (...a: unknown[]) => Promise<unknown[]>;
      indexFile: (...a: unknown[]) => Promise<string>;
    };
    jest.spyOn(priv, 'withVectors').mockImplementation(async (chunks) => {
      t.broker.revoke(t.scopeA.id);
      return (chunks as Array<{ text: string; offset: number }>).map((c, i) => ({
        id: `x:${i}`,
        ...c,
      }));
    });
    const src = { id: 'sa', kind: 'folder', path: t.a, addedAt: 1, enabled: true };
    const r = await priv.indexFile(src, file, undefined, null, new AbortController().signal, true);
    expect(r).toBe('same');
    expect(t.svc.index.bySource('sa')).toEqual([]);
    expect((await t.svc.search('ALPHA')).hits).toEqual([]);
  });
});
