jest.unmock('fs');
jest.unmock('path');

import zlib from 'node:zlib';

import { codexRowsChanged, zstdDecode } from '../../../src/cli/SessionHistoryService';

const z = zlib as unknown as {
  zstdCompressSync?: (b: Buffer) => Buffer;
  zstdDecompress?: unknown;
};
const hasZstd = typeof z.zstdCompressSync === 'function' && typeof z.zstdDecompress === 'function';
const maybe = hasZstd ? it : it.skip;

describe('zstdDecode（异步）', () => {
  afterEach(() => jest.restoreAllMocks());

  maybe('用异步 zlib.zstdDecompress 解压，不走同步 API', async () => {
    const sync = jest.spyOn(zlib as never, 'zstdDecompressSync' as never);
    const text = '{"type":"x"}\n'.repeat(10_000) + '中文';
    await expect(zstdDecode(z.zstdCompressSync!(Buffer.from(text)))).resolves.toBe(text);
    expect(sync).not.toHaveBeenCalled();
  });

  maybe('解压结果超过上限直接失败（不再退回外部 zstd）', async () => {
    const buf = z.zstdCompressSync!(Buffer.alloc(100_000, 97));
    await expect(zstdDecode(buf, 1000)).rejects.toMatchObject({ code: 'ERR_BUFFER_TOO_LARGE' });
    await expect(zstdDecode(buf, 100_000)).resolves.toHaveLength(100_000);
  });

  it('不是 zstd 数据时失败', async () => {
    await expect(zstdDecode(Buffer.from('definitely not zstd'))).rejects.toBeTruthy();
  });
});

describe('codexRowsChanged', () => {
  it('只报告新增、删除和列值变化的会话', () => {
    const prev = new Map([
      ['a', { id: 'a', title: 't', archived: 0 }],
      ['b', { id: 'b', title: 't', archived: 0 }],
      ['c', { id: 'c', title: 't' }],
    ]);
    const next = new Map([
      ['a', { id: 'a', title: 't', archived: 0 }],
      ['b', { id: 'b', title: 't', archived: 1 }],
      ['d', { id: 'd' }],
    ]);
    expect([...codexRowsChanged(prev, next)].sort()).toEqual(['b', 'c', 'd']);
    expect(codexRowsChanged(next, new Map(next)).size).toBe(0);
  });
});
