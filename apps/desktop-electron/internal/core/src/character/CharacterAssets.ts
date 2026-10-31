/**
 * 当前角色包的远程素材（manifest `assets.remote`，如官方角色的 .riv）：不随安装包发，切到 Rive 时按远程
 * 角色目录（GitHub Release `characters` 的 catalog.json，scripts/character/remote-catalog.mjs 生成）下载到
 * `<userData>/character-assets/<packId>/`，经 character-pack://assets/<packId>/<file> 给视图。
 *
 * - 缓存：`<packId>/current.json` 记下就绪素材的文件名 / sha256 / 大小；启动时文件在、大小对就直接就绪；
 * - ensure()：读目录，sha256 与缓存一致就不动；不一致（首次 / 新版本）下载到 .part、边下边算 sha256，
 *   校验通过才改名并更新 current.json，再删掉旧文件。更新期间旧素材照常可用；
 * - 失败：有缓存就继续用缓存（只记日志），没有就进入 error，等用户重试（character.ensureAssets）。
 * 与 Go 版 internal/core/characterassets 行为一致。见 docs/design/remote-character-assets.md。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { NormalizedPack } from '@nomi-ai/character-contract';

export const CHARACTER_CATALOG_URL =
  'https://github.com/Cookieboty/nomi-ai/releases/download/characters/catalog.json';

const CATALOG_TIMEOUT_MS = 15_000;
/** 下载多久没有收到数据算卡住 */
const STALL_MS = 60_000;
const MAX_CATALOG_BYTES = 1 << 20;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type CharacterAssetsStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface CharacterAssetsState {
  packId: string | null;
  remote: boolean;
  status: CharacterAssetsStatus;
  version?: string | null;
  percent?: number | null;
  riveUrl?: string | null;
  error?: string | null;
}

interface CatalogAsset {
  file: string;
  url: string;
  size: number;
  sha256: string;
}

interface Cached {
  file: string;
  sha256: string;
  size: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CharacterAssetsDeps {
  /** `<userData>/character-assets` */
  root: string;
  /** 当前生效的角色包（null = 没有） */
  activePack: () => NormalizedPack | null;
  publish: (state: CharacterAssetsState) => void;
  logger?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
  fetchImpl?: FetchLike;
  catalogUrl?: string;
  stallMs?: number;
}

export const characterAssetUrl = (packId: string, file: string) =>
  `character-pack://assets/${packId}/${file}`;

export class CharacterAssets {
  private st: CharacterAssetsState;
  private running: Promise<CharacterAssetsState> | null = null;

  constructor(private readonly d: CharacterAssetsDeps) {
    this.st = this.fromCache();
  }

  state(): CharacterAssetsState {
    return { ...this.st };
  }

  /** 角色包变了（覆盖包装上 / 卸掉）：按新包重新读缓存 */
  refresh(): void {
    const next = this.fromCache();
    if (next.packId !== this.st.packId || next.remote !== this.st.remote) this.set(next);
  }

  /** 检查目录，缺少或有新版本时下载；并发调用共用一次 */
  ensure(): Promise<CharacterAssetsState> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private remoteRive(): { packId: string; rel: string } | null {
    const pack = this.d.activePack();
    if (!pack?.assets.rive || !pack.assets.remote?.includes('rive')) return null;
    const packId = pack.manifest.id;
    return PACK_ID_RE.test(packId) ? { packId, rel: pack.assets.rive } : null;
  }

  private dir(packId: string): string {
    return path.join(this.d.root, packId);
  }

  private readCached(packId: string): Cached | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.dir(packId), 'current.json'), 'utf8'),
      ) as { rive?: Partial<Cached> } | null;
      const c = raw?.rive;
      if (!c || typeof c.file !== 'string' || !FILE_RE.test(c.file)) return null;
      if (typeof c.sha256 !== 'string' || !SHA_RE.test(c.sha256) || typeof c.size !== 'number') {
        return null;
      }
      if (fs.statSync(path.join(this.dir(packId), c.file)).size !== c.size) return null;
      return { file: c.file, sha256: c.sha256, size: c.size };
    } catch {
      return null;
    }
  }

  private fromCache(): CharacterAssetsState {
    const r = this.remoteRive();
    if (!r)
      return { packId: this.d.activePack()?.manifest.id ?? null, remote: false, status: 'idle' };
    const c = this.readCached(r.packId);
    return c
      ? {
          packId: r.packId,
          remote: true,
          status: 'ready',
          version: c.sha256.slice(0, 12),
          riveUrl: characterAssetUrl(r.packId, c.file),
        }
      : { packId: r.packId, remote: true, status: 'idle' };
  }

  private set(next: CharacterAssetsState): void {
    this.st = next;
    this.d.publish(this.state());
  }

  private patch(p: Partial<CharacterAssetsState>): void {
    this.set({ ...this.st, ...p });
  }

  private async run(): Promise<CharacterAssetsState> {
    this.refresh();
    const r = this.remoteRive();
    if (!r) return this.state();
    const cached = this.readCached(r.packId);
    const ready = cached ? this.fromCache() : null;
    if (!ready) this.patch({ status: 'checking', error: null, percent: null });
    try {
      const entry = await this.catalogEntry(r.packId);
      if (cached && cached.sha256 === entry.sha256) {
        this.set(this.fromCache());
        return this.state();
      }
      await this.download(r.packId, entry);
      this.set(this.fromCache());
      this.d.logger?.info('[character-assets] ready', r.packId, entry.file);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.d.logger?.warn('[character-assets] update failed', r.packId, msg);
      // 有缓存：继续用旧素材；没有：报错等重试
      if (ready) this.set(ready);
      else this.patch({ status: 'error', error: msg, percent: null });
    }
    return this.state();
  }

  private async catalogEntry(packId: string): Promise<CatalogAsset> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CATALOG_TIMEOUT_MS);
    let body: ArrayBuffer;
    try {
      const res = await this.fetch(this.d.catalogUrl ?? CHARACTER_CATALOG_URL, ctl.signal);
      if (!res.ok) throw new Error(`catalog HttpError: ${res.status}`);
      body = await res.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
    if (body.byteLength > MAX_CATALOG_BYTES) throw new Error('catalog too large');
    const cat = JSON.parse(Buffer.from(body).toString('utf8')) as {
      schemaVersion?: unknown;
      packs?: Array<{ id?: unknown; assets?: { rive?: Partial<CatalogAsset> } }>;
    };
    if (cat.schemaVersion !== 1 || !Array.isArray(cat.packs))
      throw new Error('catalog: unsupported');
    const a = cat.packs.find((p) => p?.id === packId)?.assets?.rive;
    if (!a) throw new Error(`catalog: no rive asset for ${packId}`);
    if (
      typeof a.file !== 'string' ||
      !FILE_RE.test(a.file) ||
      a.file === 'current.json' ||
      typeof a.url !== 'string' ||
      !a.url.startsWith('https://') ||
      typeof a.size !== 'number' ||
      !(a.size > 0) ||
      typeof a.sha256 !== 'string' ||
      !SHA_RE.test(a.sha256)
    ) {
      throw new Error(`catalog: invalid rive asset for ${packId}`);
    }
    return { file: a.file, url: a.url, size: a.size, sha256: a.sha256 };
  }

  private fetch(url: string, signal: AbortSignal): Promise<Response> {
    const doFetch: FetchLike = this.d.fetchImpl ?? ((u, i) => fetch(u, i));
    return doFetch(url, { method: 'GET', redirect: 'follow', credentials: 'omit', signal });
  }

  private async download(packId: string, a: CatalogAsset): Promise<void> {
    const dir = this.dir(packId);
    await fs.promises.mkdir(dir, { recursive: true });
    const part = path.join(dir, `${a.file}.part`);
    const ctl = new AbortController();
    const stallMs = this.d.stallMs ?? STALL_MS;
    let stall = setTimeout(() => ctl.abort(), stallMs);
    const kick = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctl.abort(), stallMs);
    };
    this.patch({ status: this.st.status === 'ready' ? 'ready' : 'downloading', percent: 0 });
    const out = fs.createWriteStream(part);
    const hash = createHash('sha256');
    let got = 0;
    let lastPct = -1;
    try {
      const res = await this.fetch(a.url, ctl.signal);
      if (!res.ok || !res.body) throw new Error(`download HttpError: ${res.status}`);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        kick();
        got += chunk.length;
        if (got > a.size) throw new Error('download larger than the catalog says');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
        const pct = Math.floor((got / a.size) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          // 更新已有素材时界面照常用旧的，不显示进度条
          if (this.st.status !== 'ready') this.patch({ status: 'downloading', percent: pct });
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
      if (got !== a.size) throw new Error(`download incomplete (${got}/${a.size} bytes)`);
      if (hash.digest('hex') !== a.sha256) throw new Error('download sha256 mismatch');
      await fs.promises.rename(part, path.join(dir, a.file));
    } catch (e) {
      out.destroy();
      await fs.promises.rm(part, { force: true }).catch(() => undefined);
      throw ctl.signal.aborted &&
        !(e instanceof Error && /sha256|incomplete|larger/.test(e.message))
        ? new Error(`download stalled: no data for ${Math.round(stallMs / 1000)}s`)
        : e;
    } finally {
      clearTimeout(stall);
    }
    const current = { rive: { file: a.file, sha256: a.sha256, size: a.size } };
    const tmp = path.join(dir, `current.json.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, JSON.stringify(current));
    await fs.promises.rename(tmp, path.join(dir, 'current.json'));
    // 删掉旧版本（视图已经在用新地址；Windows 上旧文件正被读时删不掉，下次再删）
    for (const f of await fs.promises.readdir(dir)) {
      if (f === a.file || f === 'current.json') continue;
      await fs.promises.rm(path.join(dir, f), { force: true }).catch(() => undefined);
    }
  }
}
