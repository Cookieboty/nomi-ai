/**
 * 运行时同步到的模型目录（§12.7.2）：作为内置目录的覆盖层；网关进程按 catalogFile 读取，文件变了才重读。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCatalog } from '../src/models/buildCatalog';
import {
  catalogEntry,
  catalogOverlayVersion,
  readCatalogFile,
  setCatalogOverlay,
} from '../src/models/catalog';
import { runGatewayWorker, type WorkerInbound, type WorkerOutbound } from '../src/worker';

const api = (n: number, ctx = 333_000) => ({
  openai: {
    models: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `ov-model-${i}`,
        { id: `ov-model-${i}`, limit: { context: ctx, output: 9_000 }, tool_call: true },
      ]),
    ),
  },
  // 覆盖内置里已有的模型
  anthropic: {
    models: { 'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 123_456 } } },
  },
});

afterEach(() => setCatalogOverlay(null));

describe('catalog overlay', () => {
  it('先查覆盖层，没有再查内置；清除后回到内置', () => {
    const builtinHaiku = catalogEntry('claude-haiku-4-5')?.limits?.context;
    expect(catalogEntry('ov-model-3')).toBeUndefined();
    setCatalogOverlay(buildCatalog(api(60), '2026-10-26'));
    expect(catalogOverlayVersion()).toBe('2026-10-26');
    expect(catalogEntry('relay/ov-model-3')?.limits).toMatchObject({ context: 333_000 });
    expect(catalogEntry('claude-haiku-4-5')?.limits?.context).toBe(123_456);
    // 覆盖层里没有的仍按内置
    expect(catalogEntry('gpt-5.2')?.limits?.input).toBe(272_000);
    setCatalogOverlay(null);
    expect(catalogEntry('claude-haiku-4-5')?.limits?.context).toBe(builtinHaiku);
  });

  it('读缓存文件：不存在 / 坏 JSON / 条目过少都返回 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cat-'));
    const f = path.join(dir, 'catalog-sync.json');
    expect(readCatalogFile(f)).toBeNull();
    fs.writeFileSync(f, '{oops');
    expect(readCatalogFile(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify(buildCatalog(api(10), 'x')));
    expect(readCatalogFile(f)).toBeNull();
    fs.writeFileSync(f, JSON.stringify(buildCatalog(api(60), '2026-10-26')));
    expect(readCatalogFile(f)?.version).toBe('2026-10-26');
  });

  it('网关进程按配置里的 catalogFile 加载，文件变了才重读', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cat-w-'));
    const file = path.join(dir, 'catalog-sync.json');
    fs.writeFileSync(file, JSON.stringify(buildCatalog(api(60, 111_000), 'v1')));
    let handler: ((e: { data: WorkerInbound }) => void) | null = null;
    const out: WorkerOutbound[] = [];
    let waiter: (() => void) | null = null;
    runGatewayWorker({
      on: (_e, fn) => (handler = fn),
      postMessage: (m) => {
        out.push(m);
        waiter?.();
      },
    });
    const config = {
      host: '127.0.0.1',
      port: 0,
      providers: [],
      clients: {},
      catalogFile: file,
    };
    await new Promise<void>((r) => {
      waiter = r;
      handler!({ data: { type: 'config', config } });
    });
    expect(catalogEntry('ov-model-1')?.limits?.context).toBe(111_000);
    // 文件更新（修改时间变化）后下一次推配置重读
    fs.writeFileSync(file, JSON.stringify(buildCatalog(api(60, 222_000), 'v2')));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    handler!({ data: { type: 'config', config } });
    await new Promise((r) => setTimeout(r, 20));
    expect(catalogOverlayVersion()).toBe('v2');
    expect(catalogEntry('ov-model-1')?.limits?.context).toBe(222_000);
    handler!({ data: { type: 'stop' } });
  });
});
