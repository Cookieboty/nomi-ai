jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { UsageLedger } from '../../../src/usage/UsageLedger';
import { UsageLogScanner, createLimiter, walkAsync } from '../../../src/usage/UsageLogScanner';

/** 旧的同步实现（对照组）：异步遍历的结果要和它完全一致 */
function walkSync(
  dir: string,
  pred: (name: string, full: string) => boolean,
  depth: number,
  since: number,
): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  let visited = 0;
  const go = (d: string, dep: number) => {
    if (dep < 0 || visited > 50_000) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      visited++;
      const full = path.join(d, e.name);
      if (e.isDirectory()) go(full, dep - 1);
      else if (e.isFile() && pred(e.name, full)) {
        const st = fs.statSync(full);
        if (st.mtimeMs >= since) out.push({ path: full, mtime: st.mtimeMs });
      }
    }
  };
  go(dir, depth);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 5000);
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-walk-'));
const at = (p: string, ms: number) => fs.utimesSync(p, new Date(ms), new Date(ms));

/** 造一棵多层目录树：不同深度、命中 / 不命中的文件、以及超出回看窗口的旧文件 */
function tree(root: string): void {
  const base = Date.now() - 10 * 86_400_000;
  let n = 0;
  for (let a = 0; a < 4; a++)
    for (let b = 0; b < 3; b++) {
      const d = path.join(root, `p${a}`, `s${b}`, 'deep', 'deeper');
      fs.mkdirSync(d, { recursive: true });
      for (const [dir, name] of [
        [path.join(root, `p${a}`), `top${b}.jsonl`],
        [path.join(root, `p${a}`, `s${b}`), 'x.jsonl'],
        [path.join(root, `p${a}`, `s${b}`), 'skip.txt'],
        [path.join(root, `p${a}`, `s${b}`, 'deep'), 'y.jsonl'],
        [d, 'z.jsonl'],
      ] as const) {
        const f = path.join(dir, name);
        fs.writeFileSync(f, 'x\n');
        // 一部分文件早于回看窗口；mtime 各不相同，排序结果确定
        at(f, base + (n++ % 7 === 0 ? -400 * 86_400_000 : n * 1000));
      }
    }
}

describe('walkAsync：与同步遍历结果一致', () => {
  it.each([0, 1, 2, 3, 4, 6])('depth=%i', async (depth) => {
    const root = tmp();
    tree(root);
    const pred = (n: string) => n.endsWith('.jsonl');
    const since = Date.now() - 30 * 86_400_000;
    const expected = walkSync(root, pred, depth, since);
    expect(await walkAsync(root, pred, depth, since)).toEqual(expected);
    // 带缓存跑两遍（第二遍走缓存）结果也不变
    const cache = new Map();
    expect(await walkAsync(root, pred, depth, since, cache)).toEqual(expected);
    expect(await walkAsync(root, pred, depth, since, cache)).toEqual(expected);
  });

  it('pred 拿到的 full 路径与同步实现相同；不存在的根目录返回空', async () => {
    const root = tmp();
    tree(root);
    const a: string[] = [];
    const b: string[] = [];
    walkSync(root, (_n, full) => (a.push(full), true), 4, 0);
    await walkAsync(root, (_n, full) => (b.push(full), true), 4, 0);
    expect(b).toEqual(a);
    expect(await walkAsync(path.join(root, 'nope'), () => true, 4, 0)).toEqual([]);
  });
});

describe('walkAsync：目录列表按 mtime 缓存', () => {
  afterEach(() => jest.restoreAllMocks());

  it('目录没变不再 readdir；新增文件（目录 mtime 变了）能看到；追加内容的新 mtime 也能看到', async () => {
    const root = tmp();
    const sub = path.join(root, 'proj');
    fs.mkdirSync(sub);
    const f1 = path.join(sub, 'a.jsonl');
    fs.writeFileSync(f1, 'x\n');
    const old = Date.now() - 60_000;
    at(f1, old);
    at(sub, old);
    at(root, old);
    const cache = new Map();
    const pred = (n: string) => n.endsWith('.jsonl');
    expect((await walkAsync(root, pred, 4, 0, cache)).map((x) => x.path)).toEqual([f1]);
    expect(cache.size).toBe(2);

    const readdir = jest.spyOn(fs.promises, 'readdir');
    expect((await walkAsync(root, pred, 4, 0, cache)).map((x) => x.path)).toEqual([f1]);
    expect(readdir).not.toHaveBeenCalled();

    // 只追加内容：目录 mtime 不变，仍复用列表，但文件的新 mtime 要被 stat 出来
    fs.appendFileSync(f1, 'y\n');
    const later = Date.now() - 1000;
    at(f1, later);
    const r = await walkAsync(root, pred, 4, 0, cache);
    expect(readdir).not.toHaveBeenCalled();
    expect(r).toEqual([{ path: f1, mtime: fs.statSync(f1).mtimeMs }]);

    // 新建文件：目录 mtime 变了，重新列目录
    const f2 = path.join(sub, 'b.jsonl');
    fs.writeFileSync(f2, 'x\n');
    const paths = (await walkAsync(root, pred, 4, 0, cache)).map((x) => x.path);
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(paths.sort()).toEqual([f1, f2].sort());
    // 刚改过的目录（mtime 太新）不进缓存：同一时间刻度里再新建的文件也不会漏
    expect(cache.has(sub)).toBe(false);
    const f3 = path.join(sub, 'c.jsonl');
    fs.writeFileSync(f3, 'x\n');
    expect((await walkAsync(root, pred, 4, 0, cache)).map((x) => x.path)).toContain(f3);
  });

  it('删除的目录不再记为遍历到（find() 据此清理缓存）', async () => {
    const root = tmp();
    const sub = path.join(root, 'gone');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.jsonl'), 'x\n');
    const old = Date.now() - 60_000;
    at(sub, old);
    at(root, old);
    const cache = new Map();
    await walkAsync(root, () => true, 4, 0, cache);
    expect(cache.has(sub)).toBe(true);
    fs.rmSync(sub, { recursive: true });
    const seen = new Set<string>();
    expect(await walkAsync(root, () => true, 4, 0, cache, seen)).toEqual([]);
    expect([...seen]).toEqual([root]);
  });
});

describe('createLimiter', () => {
  it('同时运行的任务数不超过上限，结果按调用对应', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    const res = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(res).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('任务失败不占住名额', async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limit(async () => 1)).resolves.toBe(1);
  });
});

describe('UsageLogScanner.scan：重入保护', () => {
  it('一轮没结束时再次调用直接返回 0，结束后可以再扫', async () => {
    const home = tmp();
    const ledger = new UsageLedger({ root: tmp() });
    const scanner = new UsageLogScanner({ ledger, home, env: {}, retention: () => '1y' });
    const dir = path.join(home, '.claude', 'projects', '-w');
    fs.mkdirSync(dir, { recursive: true });
    const line = (id: string) =>
      `${JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: 's1',
        message: { id, model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 2 } },
      })}\n`;
    fs.writeFileSync(path.join(dir, 's1.jsonl'), line('m1'));
    const first = scanner.scan();
    expect(await scanner.scan()).toEqual({ added: 0, files: 0 });
    expect((await first).added).toBe(1);
    fs.appendFileSync(path.join(dir, 's1.jsonl'), line('m2'));
    expect((await scanner.scan()).added).toBe(1);
  });
});

describe('UsageLogScanner：dsh zstd 异步解压 + 目录缓存清理', () => {
  const zc = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  const maybe = zc ? it : it.skip;

  maybe('整份解压 .zstd 会话并记账；删掉的目录在下一轮从缓存清掉', async () => {
    const home = tmp();
    const ledger = new UsageLedger({ root: tmp() });
    const scanner = new UsageLogScanner({
      ledger,
      home,
      dshHome: path.join(home, '.dsh'),
      env: {},
      retention: () => '1y',
    });
    const text = fs.readFileSync(
      path.join(__dirname, '../../fixtures/history/dsh-session.jsonl'),
      'utf8',
    );
    const sessions = path.join(home, '.dsh', 'sessions');
    const dir = path.join(sessions, '--work--', 'session-887fa07d');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zc!(Buffer.from(text)));
    const old = Date.now() - 60_000;
    for (const d of [dir, path.dirname(dir), sessions]) at(d, old);
    expect((await scanner.scan()).added).toBe(2);
    const cache = (scanner as unknown as { dirCache: Map<string, unknown> }).dirCache;
    expect(cache.has(dir)).toBe(true);
    fs.rmSync(path.dirname(dir), { recursive: true });
    await scanner.scan();
    expect(cache.has(dir)).toBe(false);
    expect(cache.has(path.dirname(dir))).toBe(false);
  });
});
