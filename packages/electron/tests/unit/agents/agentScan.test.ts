jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  Notification: Object.assign(
    jest.fn(() => ({ show: jest.fn() })),
    { isSupported: () => false },
  ),
}));
jest.mock('../../../src/island/IslandService', () => ({ notifyIsland: jest.fn() }));
jest.mock('../../../src/ai/mascotCommand', () => ({ broadcastMascotCommand: jest.fn() }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentProgressService, readSlice } from '../../../src/agents/AgentProgressService';
import { ScanCache, limiter, readSliceAsync } from '../../../src/agents/fsScan';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-scan-'));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 旧的同步实现（对照组）：结果必须与 ScanCache.listFiles 一致 */
function listFilesSync(
  dir: string,
  pred: (n: string, full: string) => boolean,
  depth: number,
  limit: number,
): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  let visited = 0;
  const walk = (d: string, dep: number) => {
    if (dep < 0 || visited > 20_000) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      visited++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, dep - 1);
      else if (e.isFile() && pred(e.name, p)) {
        try {
          out.push({ path: p, mtime: fs.statSync(p).mtimeMs });
        } catch {
          /* 已删除 */
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, depth);
  return out.sort((x, y) => y.mtime - x.mtime).slice(0, limit);
}

const touch = (file: string, mtime: number, body = '{}\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
};
/** 把目录 mtime 拨到过去，让目录列表缓存可信（绕开「刚改过的目录不信任」的保护） */
const ageDir = (dir: string, mtime: number) => fs.utimesSync(dir, new Date(mtime), new Date(mtime));

describe('limiter', () => {
  it('同时运行的任务不超过上限，结果按调用对应', async () => {
    const limit = limiter(3);
    let active = 0;
    let peak = 0;
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(res).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

describe('readSliceAsync', () => {
  it('与同步版读出的头尾一致；文件不存在返回空串', async () => {
    const f = path.join(tmp(), 'a.txt');
    fs.writeFileSync(f, 'hello world, 0123456789');
    for (const [w, n] of [
      ['head', 5],
      ['tail', 4],
      ['head', 1000],
    ] as const)
      expect(await readSliceAsync(f, w, n)).toBe(readSlice(f, w, n));
    expect(await readSliceAsync(path.join(tmp(), 'missing'), 'head', 10)).toBe('');
  });
});

describe('ScanCache', () => {
  const now = Date.now();
  const jsonl = (n: string) => n.endsWith('.jsonl');
  const opts = (full = false) => ({ now, hotMs: 3 * DAY, full });
  const scan = async (c: ScanCache, root: string, o = opts(), depth = 3, limit = 60) => {
    c.begin();
    const r = await c.listFiles(root, jsonl, depth, limit, o);
    c.end();
    return r;
  };

  const fixture = () => {
    const root = tmp();
    // 多个项目、子代理目录、过深 / 不匹配的文件、冷热混合，mtime 有重复
    for (let p = 0; p < 4; p++) {
      for (let s = 0; s < 8; s++)
        touch(path.join(root, `proj-${p}`, `s-${s}.jsonl`), now - (p * 8 + s) * HOUR);
      touch(path.join(root, `proj-${p}`, 'notes.txt'), now);
      touch(path.join(root, `proj-${p}`, 's-0', 'subagents', 'agent-1.jsonl'), now - 5 * DAY);
      touch(path.join(root, `proj-${p}`, 'a', 'b', 'c', 'too-deep.jsonl'), now);
    }
    touch(path.join(root, 'proj-0', 'same-1.jsonl'), now - 2 * HOUR);
    touch(path.join(root, 'proj-0', 'same-2.jsonl'), now - 2 * HOUR);
    return root;
  };

  it('结果与旧的同步遍历完全一致（含排序、截断、深度、谓词）', async () => {
    const root = fixture();
    const c = new ScanCache();
    for (const [depth, limit] of [
      [3, 60],
      [2, 10],
      [1, 60],
      [0, 60],
    ])
      expect(await scan(c, root, opts(), depth, limit)).toEqual(
        listFilesSync(root, jsonl, depth, limit),
      );
    // 第二轮走缓存，结果不变
    expect(await scan(c, root)).toEqual(listFilesSync(root, jsonl, 3, 60));
    expect(await scan(c, path.join(root, 'missing'))).toEqual([]);
  });

  it('目录 mtime 没变就不重新 readdir；新增文件改了目录 mtime → 重新列出并找到新文件', async () => {
    const root = fixture();
    const proj = path.join(root, 'proj-1');
    const past = now - DAY;
    const walkDirs = (d: string): string[] => [
      d,
      ...fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .flatMap((e) => walkDirs(path.join(d, e.name))),
    ];
    for (const d of walkDirs(root)) ageDir(d, past);
    const c = new ScanCache();
    await scan(c, root);
    const readdir = jest.spyOn(fs.promises, 'readdir');
    try {
      await scan(c, root);
      expect(readdir).not.toHaveBeenCalled();

      const fresh = path.join(proj, 'new.jsonl');
      touch(fresh, now);
      const r = await scan(c, root);
      expect(readdir.mock.calls.map(([d]) => d)).toEqual([proj]);
      expect(r).toContainEqual({ path: fresh, mtime: fs.statSync(fresh).mtimeMs });
      expect(r).toEqual(listFilesSync(root, jsonl, 3, 60));

      // 删除文件同样会改目录 mtime
      fs.rmSync(fresh);
      expect(await scan(c, root)).toEqual(listFilesSync(root, jsonl, 3, 60));
    } finally {
      readdir.mockRestore();
    }
  });

  it('只重新 stat 近期文件；冷文件用缓存 mtime，整体复查时才发现被续写', async () => {
    const root = tmp();
    const proj = path.join(root, 'p');
    const hot = path.join(proj, 'hot.jsonl');
    const cold = path.join(proj, 'cold.jsonl');
    touch(hot, now - HOUR);
    touch(cold, now - 10 * DAY);
    ageDir(proj, now - DAY);
    ageDir(root, now - DAY);
    const c = new ScanCache();
    await scan(c, root);
    const stat = jest.spyOn(fs.promises, 'stat');
    try {
      await scan(c, root);
      const statted = stat.mock.calls.map(([p]) => p);
      expect(statted).toContain(hot);
      expect(statted).not.toContain(cold);

      // 续写冷文件（不改目录 mtime）：平时看不到，整体复查那一轮看到
      fs.utimesSync(cold, new Date(now), new Date(now));
      expect((await scan(c, root)).find((f) => f.path === cold)?.mtime).toBe(now - 10 * DAY);
      const full = await scan(c, root, opts(true));
      expect(full[0]?.path).toBe(cold);
      expect(full).toEqual(listFilesSync(root, jsonl, 3, 60));
    } finally {
      stat.mockRestore();
    }
  });
});

describe('AgentProgressService 异步轮询', () => {
  const mk = () => {
    const home = tmp();
    const now = Date.now();
    const file = path.join(home, '.claude', 'projects', '-w-a', 's.jsonl');
    touch(
      file,
      now,
      JSON.stringify({ type: 'user', sessionId: 's', cwd: '/w/a', message: { content: 'hi' } }) +
        '\n',
    );
    const svc = new AgentProgressService({
      root: tmp(),
      home,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say: jest.fn() } as never,
      pollMs: 50,
      processes: () => [],
      lockedInodes: () => new Set(),
    });
    return { svc, file };
  };

  it('start() 不同步扫描：返回时还没有结果，稍后异步填上', async () => {
    const { svc } = mk();
    const scanFiles = jest.spyOn(svc, 'scanFiles');
    svc.start();
    try {
      expect(svc.state().sessions).toHaveLength(0);
      await (svc as unknown as { ticking: Promise<void> }).ticking;
      expect(scanFiles).toHaveBeenCalledTimes(1);
      expect(svc.state().sessions.map((s) => s.id)).toEqual(['claude:s']);
    } finally {
      svc.stop();
    }
  });

  it('上一轮还没扫完：定时器到点跳过；手动调用合并成跑完后补一轮', async () => {
    jest.useFakeTimers();
    const { svc } = mk();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = svc.scanFiles.bind(svc);
    const scanFiles = jest
      .spyOn(svc, 'scanFiles')
      .mockImplementationOnce(async () => {
        await gate;
        return real();
      })
      .mockImplementation(real);
    try {
      svc.start();
      expect(scanFiles).toHaveBeenCalledTimes(1);
      // 卡住的这轮期间定时器到点多次：都跳过
      jest.advanceTimersByTime(50 * 5);
      expect(scanFiles).toHaveBeenCalledTimes(1);
      svc.stop();
      // 手动调用多次：都返回同一个进行中的 Promise，跑完后只补一轮
      const a = svc.tick();
      const b = svc.tick();
      expect(a).toBe(b);
      jest.useRealTimers();
      release();
      await a;
      expect(scanFiles).toHaveBeenCalledTimes(2);
      expect(svc.state().sessions.map((s) => s.id)).toEqual(['claude:s']);
    } finally {
      svc.stop();
      jest.useRealTimers();
    }
  });
});
