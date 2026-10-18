import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import type {
  ModelConfig,
  ModelDownloadProgress,
  ModelImportResult,
  RegistryModel,
  StoreStateView,
} from '@nomi-ai/types';
import { BrowserWindow, app, dialog, ipcMain, protocol, type OpenDialogOptions } from 'electron';

import { t } from '../i18n';

import { parseConfigFile, toConfigFile } from './modelConfig';
import { ModelRegistry } from './ModelRegistry';
import { ModelStore } from './ModelStore';
import { MODEL_SCHEME, mimeFor, resolveModelUrl } from './protocol';
import { UserModels } from './UserModels';

export const MODELS_CHANGED = 'models:changed';
export const MODELS_PROGRESS = 'models:progress';

/** cdmodel:// 的特权声明：支持 fetch（GLTFLoader）与 CORS。由 registerAppSchemePrivileges 统一注册 */
export const MODEL_SCHEME_PRIVILEGES: Electron.CustomScheme = {
  scheme: MODEL_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

type Logger = { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void };

function bundledListPath(): string {
  const rel = path.join('assets', 'models', 'vrm', 'model-list.json');
  if (process.env.NODE_ENV === 'development') {
    return path.join(__dirname, '..', '..', '..', 'renderer', 'public', rel);
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'renderer', rel)
    : path.join(app.getAppPath(), 'dist', 'renderer', rel);
}

/** 主进程模型服务：注册表 + 商店 + 用户导入 + cdmodel:// 协议 + IPC。 */
/** fixed id of the e2e-seeded user model (see seedOnce) */
export const SEED_USER_VRM_ID = 'user-e2e-avatar-000000';

export class ModelService {
  readonly root: string;
  readonly store: ModelStore;
  readonly user: UserModels;
  readonly registry: ModelRegistry;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly logger: Logger) {
    this.root = path.join(app.getPath('userData'), 'models');
    const env = process.env.NOMI_MODEL_CATALOG_URL?.trim();
    this.store = new ModelStore({
      root: this.root,
      catalogUrls: env
        ? env
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      // 测试专用：未打包运行时可放行回环 http（e2e 的本地 mock 目录服务器）
      policy: {
        allowLoopbackHttp: !app.isPackaged && process.env.IG_MODEL_STORE_ALLOW_LOOPBACK === '1',
      },
      logger,
    });
    this.user = new UserModels(this.root);
    this.registry = new ModelRegistry({
      bundledListPath: bundledListPath(),
      store: this.store,
      user: this.user,
    });
  }

  private seeding?: Promise<void>;

  /**
   * Test-only (unpackaged builds): CD_SEED_USER_VRM=<path to fixture .vrm> imports it through the
   * normal user-import path under a fixed id, so e2e exercises the custom-upload 3D path without
   * any VRM bundled in the app.
   */
  private seedOnce(): Promise<void> {
    const src = process.env.CD_SEED_USER_VRM;
    if (!src || app.isPackaged) return Promise.resolve();
    this.seeding ??= (async () => {
      const id = process.env.CD_SEED_USER_VRM_ID || SEED_USER_VRM_ID;
      if ((await this.user.list()).some((r) => r.id === id)) return;
      await this.user.import(src, {}, id);
    })().catch((err: unknown) => this.logger.warn('[models] seed failed', { error: String(err) }));
    return this.seeding;
  }

  async list(): Promise<RegistryModel[]> {
    await this.seedOnce();
    return this.registry.list();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(MODELS_CHANGED);
    }
    for (const l of this.listeners) l();
  }

  private progress(p: ModelDownloadProgress): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(MODELS_PROGRESS, p);
    }
  }

  registerProtocol(): void {
    protocol.handle(MODEL_SCHEME, async (req) => {
      const file = await resolveModelUrl(this.root, req.url);
      if (!file) return new Response('not found', { status: 404 });
      const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
      return new Response(body, {
        headers: {
          'content-type': mimeFor(file),
          'access-control-allow-origin': '*',
          'cache-control': 'no-cache',
        },
      });
    });
  }

  async storeState(refresh = false): Promise<StoreStateView> {
    const s = await this.store.getState(refresh);
    return {
      entries: s.entries.map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description,
        author: e.author,
        license: e.license,
        source: e.source,
        credit: e.credit,
        licenseTerms: e.licenseTerms,
        licenseFileUrl: e.licenseFileUrl,
        version: e.version,
        vrmVersion: e.vrmVersion,
        tags: e.tags,
        size: e.vrm.size,
        thumbnailUrl: e.thumbnailUrl,
        installedVersion: e.installedVersion,
        updateAvailable: e.updateAvailable,
        downloading: this.store.isDownloading(e.id),
      })),
      offline: s.offline,
      fetchedAt: s.fetchedAt,
      error: s.error,
      rejectedCount: s.rejected.length,
      catalogUrls: this.store.catalogUrls(),
    };
  }

  async install(id: string): Promise<{ ok: boolean; error?: string }> {
    let last = 0;
    try {
      const rec = await this.store.install(id, ({ received, total }) => {
        const now = Date.now();
        if (now - last > 150 || received === total) {
          last = now;
          this.progress({
            id,
            received,
            total,
            state: received === total ? 'verifying' : 'downloading',
          });
        }
      });
      this.progress({ id, received: rec.entry.vrm.size, total: rec.entry.vrm.size, state: 'done' });
      this.changed();
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.progress({
        id,
        received: 0,
        total: 0,
        state: error === '已取消' ? 'cancelled' : 'error',
        error,
      });
      this.logger.warn('模型下载失败', { id, error });
      return { ok: false, error };
    }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (id.startsWith('user-')) await this.user.remove(id);
      else await this.store.remove(id);
      this.changed();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async pickFile(
    win: BrowserWindow | null,
    opts: OpenDialogOptions,
  ): Promise<string | undefined> {
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? undefined : r.filePaths[0];
  }

  private async userResult(fn: () => Promise<{ id: string }>): Promise<ModelImportResult> {
    try {
      const rec = await fn();
      this.changed();
      const model = (await this.list()).find((m) => m.id === rec.id);
      return { ok: true, model };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  registerIpc(): void {
    const vrmFilter = {
      filters: [{ name: 'VRM', extensions: ['vrm'] }],
      properties: ['openFile' as const],
    };
    const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
    ipcMain.handle('models:list', () => this.list());
    ipcMain.handle('models:store-state', (_e, refresh?: boolean) => this.storeState(!!refresh));
    ipcMain.handle('models:install', (_e, id: string) => this.install(String(id)));
    ipcMain.handle('models:cancel', (_e, id: string) => this.store.cancel(String(id)));
    ipcMain.handle('models:remove', (_e, id: string) => this.remove(String(id)));
    ipcMain.handle('models:import-vrm', async (e, filePath?: string, config?: ModelConfig) => {
      const src =
        typeof filePath === 'string' && filePath
          ? filePath
          : await this.pickFile(win(e), vrmFilter);
      if (!src) return { ok: false, error: 'cancelled' };
      if (path.extname(src).toLowerCase() !== '.vrm') {
        return { ok: false, error: t('仅支持 .vrm 文件') };
      }
      return this.userResult(() => this.user.import(src, config ?? {}));
    });
    ipcMain.handle('models:replace-vrm', async (e, id: string, filePath?: string) => {
      const src =
        typeof filePath === 'string' && filePath
          ? filePath
          : await this.pickFile(win(e), vrmFilter);
      if (!src) return { ok: false, error: 'cancelled' };
      if (path.extname(src).toLowerCase() !== '.vrm') {
        return { ok: false, error: t('仅支持 .vrm 文件') };
      }
      return this.userResult(() => this.user.replace(String(id), src));
    });
    ipcMain.handle('models:update-config', (_e, id: string, config: ModelConfig) =>
      this.userResult(() => this.user.updateConfig(String(id), config)),
    );
    ipcMain.handle('models:export-config', async (e, id: string) => {
      try {
        const rec = await this.user.get(String(id));
        const opts = {
          defaultPath: `${rec.name.replace(/[^\w.-]+/g, '_') || 'model'}.model-config.json`,
        };
        const w = win(e);
        const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
        if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
        const { promises: fsp } = await import('node:fs');
        await fsp.writeFile(
          r.filePath,
          JSON.stringify(toConfigFile(rec.config, rec.name), null, 2),
        );
        return { ok: true, path: r.filePath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
    ipcMain.handle('models:import-config', async (e, id: string, json?: string) => {
      let text = json;
      if (typeof text !== 'string') {
        const file = await this.pickFile(win(e), {
          filters: [{ name: 'Model config', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (!file) return { ok: false, error: 'cancelled' };
        const { promises: fsp } = await import('node:fs');
        text = await fsp.readFile(file, 'utf8');
      }
      const body = text;
      return this.userResult(() => this.user.updateConfig(String(id), parseConfigFile(body)));
    });
  }
}

let instance: ModelService | null = null;
export function getModelService(logger?: Logger): ModelService {
  if (!instance) instance = new ModelService(logger ?? console);
  return instance;
}
