/**
 * 编程助手会话目录的异步扫描（带缓存）。
 * - 所有 stat / readdir / 读文件都走 fs.promises，并用一个小并发池限流，不在主进程同步阻塞；
 * - 目录列表按目录 mtime 缓存：目录里增删 / 改名文件会改目录 mtime，没变就不重新 readdir；
 * - 文件 mtime 缓存：只重新 stat「目录刚变过」「近期活跃」的文件，冷文件每隔一段时间整体复查一次。
 */
import fs from 'node:fs';
import path from 'node:path';

export type Limit = <T>(fn: () => Promise<T>) => Promise<T>;

/** 并发池：同时最多跑 n 个任务，其余排队 */
export function limiter(n: number): Limit {
  let active = 0;
  const queue: Array<() => void> = [];
  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };
      if (active < n) run();
      else queue.push(run);
    });
}

/** 递归遍历时最多看多少个目录项（与旧的同步实现一致） */
const MAX_VISITED = 20_000;
/**
 * 目录 mtime 的精度有限（FAT 2 秒、HFS+ 1 秒）：刚改过的目录，同一时刻内再新增的文件
 * 不会让 mtime 变化。这么近的目录列表不信任缓存，下一轮仍重新 readdir。
 */
const DIR_RACY_MS = 2_000;

interface DirEnt {
  name: string;
  dir: boolean;
  file: boolean;
}

export interface ScanOpts {
  /** 本轮时间（与文件 mtime 比较） */
  now: number;
  /** 缓存 mtime 在这段时间内的文件视为「近期活跃」，每轮都重新 stat */
  hotMs: number;
  /** 本轮整体复查：所有文件都重新 stat（冷文件被续写时靠它发现） */
  full: boolean;
}

export class ScanCache {
  private readonly dirs = new Map<
    string,
    { mtime: number; ents: DirEnt[]; trusted: boolean; gen: number }
  >();
  private readonly files = new Map<string, { mtime: number; gen: number }>();
  /** 解析结果缓存：路径 → (mtime, size) + 解析值；文件没变就不重新读、重新解析 */
  private readonly parsed = new Map<
    string,
    { mtime: number; size: number; val: unknown; gen: number }
  >();
  /** 进行中的读取 + 解析：同一轮里多次请求同一路径只读一次 */
  private readonly parsing = new Map<string, Promise<unknown>>();
  private gen = 0;

  constructor(readonly limit: Limit = limiter(16)) {}

  /** 开始一轮扫描；配合 end() 清掉本轮没再出现的目录 / 文件缓存 */
  begin(): void {
    this.gen++;
  }

  end(): void {
    for (const [k, v] of this.dirs) if (v.gen !== this.gen) this.dirs.delete(k);
    for (const [k, v] of this.files) if (v.gen !== this.gen) this.files.delete(k);
    // readParsed 在 end() 之后才被调用：保留上一轮和本轮用过的，连续一整轮没用到才清掉
    for (const [k, v] of this.parsed) if (v.gen < this.gen - 1) this.parsed.delete(k);
  }

  async stat(p: string): Promise<fs.Stats | null> {
    try {
      return await this.limit(() => fs.promises.stat(p));
    } catch {
      return null;
    }
  }

  /** 列目录：目录 mtime 没变就用缓存；fresh = 本轮重新读过 */
  private async listDir(d: string): Promise<{ ents: DirEnt[]; fresh: boolean } | null> {
    const st = await this.stat(d);
    if (!st?.isDirectory()) return null;
    const hit = this.dirs.get(d);
    if (hit && hit.trusted && hit.mtime === st.mtimeMs) {
      hit.gen = this.gen;
      return { ents: hit.ents, fresh: false };
    }
    let raw: fs.Dirent[];
    try {
      raw = await this.limit(() => fs.promises.readdir(d, { withFileTypes: true }));
    } catch {
      return null;
    }
    const ents = raw.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
    const trusted = Date.now() - st.mtimeMs > DIR_RACY_MS;
    this.dirs.set(d, { mtime: st.mtimeMs, ents, trusted, gen: this.gen });
    return { ents, fresh: true };
  }

  /** 文件 mtime：冷文件且目录没变时直接用缓存；null = 已不存在 */
  private async fileMtime(p: string, fresh: boolean, o: ScanOpts): Promise<number | null> {
    const hit = this.files.get(p);
    if (hit && !fresh && !o.full && o.now - hit.mtime >= o.hotMs) {
      hit.gen = this.gen;
      return hit.mtime;
    }
    const st = await this.stat(p);
    if (!st) {
      this.files.delete(p);
      return null;
    }
    this.files.set(p, { mtime: st.mtimeMs, gen: this.gen });
    return st.mtimeMs;
  }

  /**
   * 递归列出匹配文件，按 mtime 倒序取前 limit 个（不能按目录遍历顺序截断，否则会漏掉最新的）。
   * 子目录并发遍历，但结果按深度优先的目录项顺序拼接，mtime 相同时的先后与同步实现一致。
   */
  async listFiles(
    dir: string,
    pred: (n: string, full: string) => boolean,
    depth: number,
    limit: number,
    o: ScanOpts,
  ): Promise<Array<{ path: string; mtime: number }>> {
    let visited = 0;
    const walk = async (
      d: string,
      dep: number,
    ): Promise<Array<{ path: string; mtime: number }>> => {
      if (dep < 0 || visited > MAX_VISITED) return [];
      const listing = await this.listDir(d);
      if (!listing) return [];
      const parts: Array<Promise<Array<{ path: string; mtime: number }>>> = [];
      for (const e of listing.ents) {
        visited++;
        const p = path.join(d, e.name);
        if (e.dir) parts.push(walk(p, dep - 1));
        else if (e.file && pred(e.name, p))
          parts.push(
            this.fileMtime(p, listing.fresh, o).then((m) =>
              m === null ? [] : [{ path: p, mtime: m }],
            ),
          );
      }
      return (await Promise.all(parts)).flat();
    };
    const out = await walk(dir, depth);
    return out.sort((x, y) => y.mtime - x.mtime).slice(0, limit);
  }

  /**
   * 读文件开头 bytes 字节并解析，结果按 (mtime, size) 缓存：文件没变就直接返回上次的解析值；
   * 同一路径的并发请求共用一次读取。文件不存在时等同读到空串（与 readSlice 一致），不缓存。
   * 同一路径必须始终用同一个 parse；返回值是共享对象，调用方不要原地修改。
   */
  readParsed<T>(p: string, bytes: number, parse: (raw: string) => T): Promise<T> {
    const pending = this.parsing.get(p);
    if (pending) return pending as Promise<T>;
    const job = (async (): Promise<T> => {
      const st = await this.stat(p);
      if (!st) {
        this.parsed.delete(p);
        return parse('');
      }
      const hit = this.parsed.get(p);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
        hit.gen = this.gen;
        return hit.val as T;
      }
      const val = parse(await this.readSlice(p, 'head', bytes));
      this.parsed.set(p, { mtime: st.mtimeMs, size: st.size, val, gen: this.gen });
      return val;
    })().finally(() => this.parsing.delete(p));
    this.parsing.set(p, job);
    return job;
  }

  /** 读文件开头 / 结尾若干字节，不把几十 MB 的 JSONL 整个读进内存 */
  readSlice(p: string, which: 'head' | 'tail', bytes: number): Promise<string> {
    return this.limit(() => readSliceAsync(p, which, bytes));
  }
}

export async function readSliceAsync(
  p: string,
  which: 'head' | 'tail',
  bytes: number,
): Promise<string> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const size = (await fh.stat()).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, which === 'head' ? 0 : size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
