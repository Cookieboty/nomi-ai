import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { t } from '../i18n';

import {
  DEFAULT_CATALOG_URLS,
  compareVersions,
  isAllowedUrl,
  validateCatalog,
  type CatalogEntry,
  type ModelCatalog,
  type UrlPolicy,
} from './catalog';
import { downloadVerified, sha256File, type DownloadProgress } from './download';
import { inspectVrmFile } from './vrmInspect';

export interface InstalledRemote {
  id: string;
  version: string;
  sha256: string;
  installedAt: number;
  entry: CatalogEntry;
}

export interface StoreEntry extends CatalogEntry {
  installedVersion?: string;
  updateAvailable: boolean;
  /** cdmodel://cache/... 本地缓存的缩略图（下载并校验后） */
  thumbnailUrl?: string;
}

export interface StoreState {
  entries: StoreEntry[];
  /** 当前目录来自缓存（网络不可用） */
  offline: boolean;
  fetchedAt?: number;
  error?: string;
  rejected: Array<{ id: string; reason: string }>;
}

interface CatalogCache {
  url: string;
  etag?: string;
  fetchedAt: number;
  body: unknown;
}

export interface ModelStoreOptions {
  root: string; // userData/models
  catalogUrls?: string[];
  fetchImpl?: typeof fetch;
  policy?: UrlPolicy;
  /** 覆盖默认时限（毫秒）；主要供测试缩短等待 */
  timeouts?: {
    thumbIdleMs?: number;
    thumbTotalMs?: number;
    listBudgetMs?: number;
    vrmIdleMs?: number;
  };
  logger?: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctl = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted) ctl.abort();
    else s.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}

/** 缩略图是可选资源：每张的空闲 / 总时限，以及目录列表等它们的总预算（超出则先返回无图条目） */
const THUMB_IDLE_MS = 8_000;
const THUMB_TOTAL_MS = 30_000;
const THUMB_LIST_BUDGET_MS = 6_000;
const THUMB_CONCURRENCY = 4;
/** VRM 本体：连续这么久没有任何数据就判为卡死（按失败处理，可重试 / 换镜像） */
const VRM_IDLE_MS = 60_000;

/** 远程模型商店：目录（ETag 缓存）+ 下载（续传 / 重试 / sha256）+ 安装记录。 */
export class ModelStore {
  private catalog: ModelCatalog | null = null;
  private readonly inflight = new Map<string, AbortController>();
  /** 同一缩略图的后台下载只发一次（列表可能因预算超时先返回，下载仍在继续） */
  private readonly thumbJobs = new Map<string, Promise<string | undefined>>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ModelStoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get remoteDir(): string {
    return path.join(this.opts.root, 'remote');
  }

  private get cacheDir(): string {
    return path.join(this.opts.root, 'cache');
  }

  catalogUrls(): string[] {
    return (this.opts.catalogUrls?.length ? this.opts.catalogUrls : DEFAULT_CATALOG_URLS).filter(
      (u) => isAllowedUrl(u, this.opts.policy),
    );
  }

  async listInstalled(): Promise<InstalledRemote[]> {
    const out: InstalledRemote[] = [];
    let ids: string[];
    try {
      ids = await fsp.readdir(this.remoteDir);
    } catch {
      return out;
    }
    for (const id of ids) {
      try {
        const rec = JSON.parse(
          await fsp.readFile(path.join(this.remoteDir, id, 'installed.json'), 'utf8'),
        ) as InstalledRemote;
        await fsp.access(path.join(this.remoteDir, id, 'model.vrm'));
        if (rec.id === id) out.push(rec);
      } catch {
        /* 不完整的安装：忽略 */
      }
    }
    return out;
  }

  async getState(refresh = false): Promise<StoreState> {
    let offline = false;
    let error: string | undefined;
    let rejected: StoreState['rejected'] = [];
    let fetchedAt: number | undefined;
    const cachePath = path.join(this.cacheDir, 'catalog.json');
    let cache: CatalogCache | null;
    try {
      cache = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as CatalogCache;
    } catch {
      cache = null;
    }

    if (refresh || !this.catalog) {
      let fresh: { body: unknown; url: string; etag?: string } | null = null;
      for (const url of this.catalogUrls()) {
        try {
          const headers: Record<string, string> = { Accept: 'application/json' };
          if (cache?.etag && cache.url === url) headers['If-None-Match'] = cache.etag;
          const res = await this.fetchImpl(url, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
          });
          if (res.status === 304 && cache) {
            fresh = { body: cache.body, url, etag: cache.etag };
            break;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (text.length > 2 * 1024 * 1024) throw new Error(t('目录过大'));
          fresh = { body: JSON.parse(text), url, etag: res.headers.get('etag') ?? undefined };
          break;
        } catch (err) {
          error = `${url}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      const source =
        fresh ?? (cache ? { body: cache.body, url: cache.url, etag: cache.etag } : null);
      offline = !fresh;
      if (source) {
        try {
          const v = validateCatalog(source.body, this.opts.policy);
          this.catalog = v.catalog;
          rejected = v.rejected;
          if (fresh) {
            fetchedAt = Date.now();
            await fsp.mkdir(this.cacheDir, { recursive: true });
            await fsp.writeFile(
              cachePath,
              JSON.stringify({ ...fresh, fetchedAt } satisfies CatalogCache),
            );
          } else {
            fetchedAt = cache?.fetchedAt;
          }
          if (fresh) error = undefined;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      }
      if (rejected.length) this.opts.logger?.warn('模型目录中有条目被拒绝', rejected);
    } else {
      fetchedAt = cache?.fetchedAt;
    }

    const installed = new Map((await this.listInstalled()).map((i) => [i.id, i]));
    const models = this.catalog?.models ?? [];
    const thumbs = await this.thumbsWithinBudget(models, !offline);
    const entries: StoreEntry[] = models.map((e, i) => {
      const inst = installed.get(e.id);
      return {
        ...e,
        installedVersion: inst?.version,
        updateAvailable: !!inst && compareVersions(e.version, inst.version) > 0,
        thumbnailUrl: thumbs[i],
      };
    });
    return { entries, offline, fetchedAt, error, rejected };
  }

  /**
   * 并发（有上限）取各条目的缩略图，但整体最多等 THUMB_LIST_BUDGET_MS：
   * 慢 / 卡住的缩略图不再拖住商店列表，先返回无图条目，图片下载在后台继续，下次刷新即可命中缓存。
   */
  private async thumbsWithinBudget(
    models: CatalogEntry[],
    allowNetwork: boolean,
  ): Promise<Array<string | undefined>> {
    const out: Array<string | undefined> = new Array(models.length).fill(undefined);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= models.length) return;
        out[i] = await this.cachedThumb(models[i]!, allowNetwork);
      }
    };
    const pool = Promise.all(
      Array.from({ length: Math.min(THUMB_CONCURRENCY, models.length) }, () => worker()),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.opts.timeouts?.listBudgetMs ?? THUMB_LIST_BUDGET_MS);
    });
    try {
      await Promise.race([pool.then(() => undefined), budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return [...out];
  }

  /** 缩略图下载到 cache/thumbs（sha256 校验），返回 cdmodel:// 地址 */
  private async cachedThumb(e: CatalogEntry, allowNetwork: boolean): Promise<string | undefined> {
    const ext = e.thumbnail.urls[0]?.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    const name = `${e.id}-${e.thumbnail.sha256.slice(0, 12)}.${ext}`;
    const dest = path.join(this.cacheDir, 'thumbs', name);
    try {
      await fsp.access(dest);
      return `cdmodel://cache/thumbs/${name}`;
    } catch {
      if (!allowNetwork) return undefined;
    }
    let job = this.thumbJobs.get(name);
    if (!job) {
      job = (async () => {
        try {
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await downloadVerified(e.thumbnail, dest, {
            fetchImpl: this.fetchImpl,
            policy: this.opts.policy,
            attemptsPerUrl: 1,
            idleTimeoutMs: this.opts.timeouts?.thumbIdleMs ?? THUMB_IDLE_MS,
            signal: AbortSignal.timeout(this.opts.timeouts?.thumbTotalMs ?? THUMB_TOTAL_MS),
          });
          return `cdmodel://cache/thumbs/${name}`;
        } catch {
          return undefined;
        } finally {
          this.thumbJobs.delete(name);
        }
      })();
      this.thumbJobs.set(name, job);
    }
    return job;
  }

  isDownloading(id: string): boolean {
    return this.inflight.has(id);
  }

  cancel(id: string): void {
    this.inflight.get(id)?.abort();
  }

  /** 安装 / 更新：下载到 remote/<id>/model.vrm（续传 + 校验），校验是 VRM 后写 installed.json */
  async install(id: string, onProgress?: (p: DownloadProgress) => void): Promise<InstalledRemote> {
    if (!this.catalog) await this.getState(false);
    const entry = this.catalog?.models.find((m) => m.id === id);
    if (!entry) throw new Error(t('目录中没有模型 {0}', id));
    if (this.inflight.has(id)) throw new Error(t('正在下载中'));
    const ac = new AbortController();
    this.inflight.set(id, ac);
    const dir = path.join(this.remoteDir, id);
    const staging = path.join(dir, `download-${entry.vrm.sha256.slice(0, 12)}.vrm`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await downloadVerified(entry.vrm, staging, {
        fetchImpl: this.fetchImpl,
        policy: this.opts.policy,
        signal: ac.signal,
        onProgress,
        idleTimeoutMs: this.opts.timeouts?.vrmIdleMs ?? VRM_IDLE_MS,
      });
      // 只读解析一遍，确认确实是 VRM（不执行任何内容）
      await inspectVrmFile(staging);
      if (ac.signal.aborted) throw new Error(t('已取消'));
      // 缩略图是可选资源：先下到暂存名，有空闲 / 总时限，也受取消控制；
      // 失败 / 超时只是没有图，不影响安装。放在提交之前，取消时旧版本保持原样。
      const ext = entry.thumbnail.urls[0]?.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      const thumbStaging = path.join(dir, `download-thumb.${ext}`);
      let haveThumb = false;
      try {
        await downloadVerified(entry.thumbnail, thumbStaging, {
          fetchImpl: this.fetchImpl,
          policy: this.opts.policy,
          attemptsPerUrl: 1,
          idleTimeoutMs: this.opts.timeouts?.thumbIdleMs ?? THUMB_IDLE_MS,
          signal: combineSignals(
            ac.signal,
            AbortSignal.timeout(this.opts.timeouts?.thumbTotalMs ?? THUMB_TOTAL_MS),
          ),
        });
        haveThumb = true;
      } catch {
        haveThumb = false;
      }
      // 提交边界：此后不再响应取消（取消在这之前才生效）
      if (ac.signal.aborted) throw new Error(t('已取消'));
      const rec: InstalledRemote = {
        id,
        version: entry.version,
        sha256: entry.vrm.sha256,
        installedAt: Date.now(),
        entry,
      };
      // installed.json 先写临时文件，再紧挨着 model.vrm 的替换落盘，缩小「新模型 + 旧记录」的不一致窗口
      const recTmp = path.join(dir, 'installed.json.tmp');
      await fsp.writeFile(recTmp, JSON.stringify(rec, null, 2));
      await fsp.rename(staging, path.join(dir, 'model.vrm'));
      await fsp.rename(recTmp, path.join(dir, 'installed.json'));
      if (haveThumb) {
        await fsp.rename(thumbStaging, path.join(dir, `thumb.${ext}`)).catch(() => undefined);
        // 换了图片格式（png ↔ jpg）：去掉上一版留下的另一种缩略图，免得显示旧图
        const other = ext === 'png' ? 'jpg' : 'png';
        await fsp.rm(path.join(dir, `thumb.${other}`), { force: true }).catch(() => undefined);
      }
      this.opts.logger?.info('远程模型已安装', { id, version: entry.version });
      return rec;
    } catch (err) {
      if (ac.signal.aborted) {
        await fsp.rm(`${staging}.part`, { force: true }).catch(() => undefined);
      }
      // 已下完（甚至已校验）但没提交的整份 VRM：取消 / 失败都不能留在磁盘上（#33）
      await fsp.rm(staging, { force: true }).catch(() => undefined);
      // 取消 / 失败时清掉缩略图暂存与临时记录（旧版本文件保持不变）
      await Promise.all(
        ['png', 'jpg'].flatMap((x) => [
          fsp.rm(path.join(dir, `download-thumb.${x}`), { force: true }),
          fsp.rm(path.join(dir, `download-thumb.${x}.part`), { force: true }),
        ]),
      ).catch(() => undefined);
      await fsp.rm(path.join(dir, 'installed.json.tmp'), { force: true }).catch(() => undefined);
      throw err;
    } finally {
      this.inflight.delete(id);
    }
  }

  async remove(id: string): Promise<void> {
    if (!/^[a-z0-9-]{2,64}$/.test(id)) throw new Error('invalid id');
    this.cancel(id);
    await fsp.rm(path.join(this.remoteDir, id), { recursive: true, force: true });
  }

  /** 已安装文件完整性复查（供调试 / 测试） */
  async verifyInstalled(id: string): Promise<boolean> {
    const rec = (await this.listInstalled()).find((r) => r.id === id);
    if (!rec) return false;
    return (await sha256File(path.join(this.remoteDir, id, 'model.vrm'))) === rec.sha256;
  }
}
