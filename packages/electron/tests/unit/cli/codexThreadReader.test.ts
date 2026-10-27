jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CodexThreadRow } from '../../../src/cli/codexThreadIndex';
import {
  CodexThreadReader,
  type CodexIndexReply,
  type CodexIndexRequest,
  type CodexIndexWorkerLike,
} from '../../../src/cli/codexThreadReader';
import { SessionHistoryService } from '../../../src/cli/SessionHistoryService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
}));

// 崩溃 / 回退路径会打 warn 日志，测试里静音
beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────── 假 worker：按请求的文件名回复固定行，可模拟崩溃 / 卡死 ─────────────
class FakeWorker extends EventEmitter implements CodexIndexWorkerLike {
  sent: CodexIndexRequest[] = [];
  terminated = false;
  hang = false;
  constructor(private readonly rows: (file: string) => CodexThreadRow[]) {
    super();
  }
  postMessage(m: CodexIndexRequest): void {
    this.sent.push(m);
    if (this.hang) return;
    setTimeout(() => {
      if (this.terminated) return;
      const reply: CodexIndexReply = { id: m.id, ok: true, rows: this.rows(m.file) };
      this.emit('message', reply);
    }, 5);
  }
  crash(): void {
    this.emit('exit', 1);
  }
  terminate(): void {
    this.terminated = true;
  }
  ref(): void {}
  unref(): void {}
}

function setup(o: { idleMs?: number; timeoutMs?: number; maxCrashes?: number } = {}) {
  const workers: FakeWorker[] = [];
  const spawn = jest.fn(() => {
    const w = new FakeWorker((file) => [{ id: path.basename(file) }]);
    workers.push(w);
    return w;
  });
  const local = jest.fn((file: string): CodexThreadRow[] => [{ id: `local:${file}` }]);
  const r = new CodexThreadReader({ spawn, local, ...o });
  return { r, spawn, local, workers };
}

describe('CodexThreadReader（主进程 ↔ worker）', () => {
  it('在 worker 里查询并复用同一个 worker', async () => {
    const { r, spawn, local } = setup();
    expect(await r.read('/x/a.sqlite')).toEqual([{ id: 'a.sqlite' }]);
    expect(await r.read('/x/b.sqlite')).toEqual([{ id: 'b.sqlite' }]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(local).not.toHaveBeenCalled();
    r.shutdown();
  });

  it('worker 脚本不存在（spawn 返回 null）或启动抛错时主进程内读取', async () => {
    const missing = new CodexThreadReader({ spawn: () => null, local: () => [{ id: 'l' }] });
    expect(await missing.read('/f')).toEqual([{ id: 'l' }]);
    expect(missing.inProcess).toBe(true);
    const throws = new CodexThreadReader({
      spawn: () => {
        throw new Error('no worker');
      },
      local: () => [{ id: 'l2' }],
    });
    expect(await throws.read('/f')).toEqual([{ id: 'l2' }]);
    expect(throws.inProcess).toBe(true);
  });

  it('worker 崩溃：进行中的请求失败，下次请求懒重建', async () => {
    const { r, spawn, workers } = setup();
    const p = r.read('/x/a');
    workers[0]!.crash();
    await expect(p).rejects.toThrow('退出');
    expect(workers[0]!.terminated).toBe(true);
    expect(await r.read('/x/b')).toEqual([{ id: 'b' }]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(r.inProcess).toBe(false);
    r.shutdown();
  });

  it('连续崩溃 maxCrashes 次后改用主进程内读取', async () => {
    const { r, spawn, local, workers } = setup({ maxCrashes: 2 });
    for (let i = 0; i < 2; i++) {
      const p = r.read('/x/a');
      workers[i]!.crash();
      await expect(p).rejects.toThrow();
    }
    expect(r.inProcess).toBe(true);
    expect(await r.read('/x/a')).toEqual([{ id: 'local:/x/a' }]);
    expect(local).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('worker 卡死：超时后失败并结束 worker，不计入回退', async () => {
    const { r, spawn, workers } = setup({ timeoutMs: 20, maxCrashes: 1 });
    await r.read('/x/a');
    workers[0]!.hang = true; // 之后的请求不再回复
    const q = r.read('/x/b');
    await expect(q).rejects.toThrow('超时');
    expect(workers[0]!.terminated).toBe(true);
    expect(r.inProcess).toBe(false);
    expect(await r.read('/x/c')).toEqual([{ id: 'c' }]);
    expect(spawn).toHaveBeenCalledTimes(2);
    r.shutdown();
  });

  it('空闲 idleMs 后结束 worker，之后按需重建', async () => {
    const { r, spawn, workers } = setup({ idleMs: 20 });
    await r.read('/x/a');
    expect(r.running).toBe(true);
    await sleep(40);
    expect(workers[0]!.terminated).toBe(true);
    expect(r.running).toBe(false);
    await r.read('/x/b');
    expect(spawn).toHaveBeenCalledTimes(2);
    r.shutdown();
  });

  it('请求之间不到 idleMs 时 worker 保持复用', async () => {
    const { r, spawn, workers } = setup({ idleMs: 40 });
    await r.read('/x/a');
    await sleep(15);
    await r.read('/x/b');
    await sleep(15);
    await r.read('/x/c');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(workers[0]!.terminated).toBe(false);
    r.shutdown();
    expect(workers[0]!.terminated).toBe(true);
  });

  it('shutdown：进行中的请求失败', async () => {
    const { r } = setup();
    const p = r.read('/x/a');
    r.shutdown();
    await expect(p).rejects.toThrow('关闭');
  });
});

describe('SessionHistoryService：异步刷新 Codex 索引', () => {
  let home: string;
  let work: string;
  const id = '01a13a9b-34b0-7612-ba36-613000000001';
  const dbFile = () => path.join(home, '.codex', 'state_5.sqlite');
  const bump = (ms: number) => fs.utimesSync(dbFile(), new Date(ms), new Date(ms));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-idx-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-idx-work-'));
    const day = path.join(home, '.codex', 'sessions', '2026', '10', '14');
    fs.mkdirSync(day, { recursive: true });
    const roll = path.join(day, `rollout-2026-10-14T21-30-12-${id}.jsonl`);
    fs.writeFileSync(
      roll,
      [
        {
          timestamp: '2026-10-14T13:30:12.603Z',
          type: 'session_meta',
          payload: { id, cwd: work, source: 'cli' },
        },
        {
          timestamp: '2026-10-14T13:30:13.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'from rollout' }],
          },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    // 索引内容由注入的读取函数给出；这里只需要一个有指纹的文件
    fs.writeFileSync(dbFile(), 'x');
    bump(1_000_000);
  });

  const mk = (codexThreads: (file: string) => Promise<CodexThreadRow[]>) =>
    new SessionHistoryService({ home, env: {}, codexThreads });

  it('刷新进行中时并发调用等同一个查询，不发起重叠的查询', async () => {
    let release!: (rows: CodexThreadRow[]) => void;
    const reader = jest.fn(
      () =>
        new Promise<CodexThreadRow[]>((r) => {
          release = r;
        }),
    );
    const svc = mk(reader);
    const a = svc.list('codex', { force: true });
    const b = svc.list('codex', { force: true });
    const c = svc.index('codex', { force: true });
    await sleep(20);
    expect(reader).toHaveBeenCalledTimes(1);
    release([{ id, title: 'indexed title' }]);
    const [pa, pb] = await Promise.all([a, b, c]);
    expect(pa.items.map((x) => x.title)).toEqual(['indexed title']);
    expect(pb.items.map((x) => x.title)).toEqual(['indexed title']);
    expect(reader).toHaveBeenCalledTimes(1);
    // 库没变：不再查询
    await svc.list('codex', { force: true });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('查询失败（worker 崩溃 / 超时）时保留上一份索引，下次再重试', async () => {
    const reader = jest
      .fn<Promise<CodexThreadRow[]>, [string]>()
      .mockResolvedValueOnce([{ id, title: 'indexed title' }])
      .mockRejectedValueOnce(new Error('Codex 索引 worker 退出（1）'))
      .mockResolvedValueOnce([{ id, title: 'renamed' }]);
    const warn = jest.fn();
    const svc = new SessionHistoryService({
      home,
      env: {},
      codexThreads: reader,
      logger: { warn },
    });
    expect((await svc.list('codex')).items.map((x) => x.title)).toEqual(['indexed title']);
    bump(2_000_000);
    expect((await svc.list('codex', { force: true })).items.map((x) => x.title)).toEqual([
      'indexed title',
    ]);
    expect(warn).toHaveBeenCalledWith('codex index refresh failed', expect.any(Error));
    // 失败时没记新指纹：同一个库下次列表时重试
    expect((await svc.list('codex', { force: true })).items.map((x) => x.title)).toEqual([
      'renamed',
    ]);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('库文件不存在时不查询，索引为空（退回解析 rollout）', async () => {
    fs.unlinkSync(dbFile());
    const reader = jest.fn(async () => [{ id, title: 'never' }]);
    const svc = mk(reader);
    expect((await svc.list('codex')).items.map((x) => x.title)).toEqual(['from rollout']);
    expect(reader).not.toHaveBeenCalled();
  });
});
