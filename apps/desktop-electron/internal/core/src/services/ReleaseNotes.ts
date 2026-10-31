/**
 * 按版本号取更新说明（updates.releaseNotes）：先读 <userData>/release-notes.json，没有再取该版本自己的
 * latest-go.json（packaging/update-manifest.py 把 docs/releases/vX.Y.Z.md 写进 releaseNotes）并缓存。
 * 与 Go 版 internal/core/updates/releasenotes.go 同一份缓存格式。
 */
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileAtomicAsync } from '../utils/privateFile';

export const RELEASE_NOTES_URL = (version: string) =>
  `https://github.com/Cookieboty/nomi-ai/releases/download/v${version}/latest-go.json`;

/** 缓存最近几个版本的说明：升级后「更新日志」离线也能打开 */
const CACHE_MAX = 5;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1 << 20;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export interface ReleaseNotesResult {
  version: string;
  notes: string | null;
  releaseDate?: string;
}

interface Entry {
  notes: string;
  releaseDate?: string;
  savedAt: number;
}

interface Cache {
  version: 1;
  entries: Record<string, Entry>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ReleaseNotesOptions {
  /** 当前应用版本 */
  version: () => string;
  /** 缓存文件；null = 不缓存 */
  file: string | null;
  fetchImpl?: FetchLike;
  url?: (version: string) => string;
  now?: () => number;
  logger?: { warn(...args: unknown[]): void };
}

export class ReleaseNotes {
  /** 同一版本并发请求共用一次 */
  private readonly inflight = new Map<string, Promise<ReleaseNotesResult>>();

  constructor(private readonly o: ReleaseNotesOptions) {}

  /** version 缺省取当前版本；取不到（开发版、旧版本清单没有说明、离线）时 notes 为 null */
  get(version?: string): Promise<ReleaseNotesResult> {
    const v = version || this.o.version();
    if (!SEMVER.test(v)) return Promise.resolve({ version: v, notes: null });
    const cached = this.load().entries[v];
    if (cached?.notes) return Promise.resolve(withEntry(v, cached));
    let job = this.inflight.get(v);
    if (!job) {
      job = this.fetchAndCache(v).finally(() => this.inflight.delete(v));
      this.inflight.set(v, job);
    }
    return job;
  }

  private load(): Cache {
    const empty: Cache = { version: 1, entries: {} };
    if (!this.o.file) return empty;
    try {
      const raw = JSON.parse(fs.readFileSync(this.o.file, 'utf8')) as Partial<Cache> | null;
      return raw?.entries && typeof raw.entries === 'object'
        ? { version: 1, entries: raw.entries }
        : empty;
    } catch {
      return empty;
    }
  }

  private async save(c: Cache): Promise<void> {
    const file = this.o.file;
    if (!file) return;
    const keys = Object.keys(c.entries).sort(
      (a, b) => c.entries[b]!.savedAt - c.entries[a]!.savedAt,
    );
    for (const k of keys.slice(CACHE_MAX)) delete c.entries[k];
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await writePrivateFileAtomicAsync(file, JSON.stringify(c));
    } catch (e) {
      this.o.logger?.warn('[updater] release notes cache write failed', String(e));
    }
  }

  private async fetchAndCache(v: string): Promise<ReleaseNotesResult> {
    const out: ReleaseNotesResult = { version: v, notes: null };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let entry: Entry;
    try {
      const doFetch: FetchLike = this.o.fetchImpl ?? ((u, i) => fetch(u, i));
      const res = await doFetch((this.o.url ?? RELEASE_NOTES_URL)(v), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        credentials: 'omit',
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HttpError: ${res.status}`);
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) throw new Error('latest-go.json too large');
      const m = JSON.parse(Buffer.from(body).toString('utf8')) as {
        version?: unknown;
        releaseDate?: unknown;
        releaseNotes?: unknown;
      };
      if (m.version !== v || typeof m.releaseNotes !== 'string' || !m.releaseNotes) return out;
      entry = {
        notes: m.releaseNotes,
        ...(typeof m.releaseDate === 'string' && m.releaseDate
          ? { releaseDate: m.releaseDate }
          : {}),
        savedAt: (this.o.now ?? Date.now)(),
      };
    } catch (e) {
      this.o.logger?.warn('[updater] release notes fetch failed', v, String(e));
      return out;
    } finally {
      clearTimeout(timer);
    }
    const c = this.load();
    c.entries[v] = entry;
    await this.save(c);
    return withEntry(v, entry);
  }
}

function withEntry(version: string, e: Entry): ReleaseNotesResult {
  return { version, notes: e.notes, ...(e.releaseDate ? { releaseDate: e.releaseDate } : {}) };
}
