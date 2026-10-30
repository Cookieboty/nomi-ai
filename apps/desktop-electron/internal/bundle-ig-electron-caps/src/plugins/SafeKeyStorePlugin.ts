import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { definePlugin, type PluginContext } from '@nomi-ai/bundle-ig-base';

import { KeyStoreKey, type KeyStoreService } from '../seams/keyStore';

export interface SafeKeyStoreConfig {
  /** 覆盖默认 <userData>/ai-chat/keys.enc 目标 */
  filePath?: string;
  /** userData 之下的子路径，默认 'ai-chat' */
  subDir?: string;
  /** 密钥文件名，默认 keys.enc */
  fileName?: string;
  /** 宿主注入（Electron：`safeStorage` 与 `app.getPath('userData')`）；不给时不提供密钥库 */
  host?: { safeStorage: SafeStorageLike; userData: string };
}

interface EncFile {
  version: 1;
  /** base64(safeStorage.encryptString(JSON.stringify(entries))) */
  payload: string;
}

interface RawEntries {
  [id: string]: string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(v: string): Buffer;
  decryptString(buf: Buffer): string;
}

export class SafeKeyStoreService implements KeyStoreService {
  private cache: RawEntries | undefined;
  private readonly file: string;

  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly logger: PluginContext['logger'],
    filePath: string,
  ) {
    this.file = filePath;
  }

  private async ensureLoaded(): Promise<RawEntries> {
    if (this.cache) return this.cache;
    try {
      const buf = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(buf) as EncFile;
      if (parsed.version !== 1 || typeof parsed.payload !== 'string') {
        throw new Error('invalid key file version');
      }
      const decrypted = this.safeStorage.decryptString(Buffer.from(parsed.payload, 'base64'));
      this.cache = JSON.parse(decrypted) as RawEntries;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.cache = {};
      } else {
        this.logger.warn('keyStore: read failed, treating as empty', err);
        this.cache = {};
      }
    }
    return this.cache;
  }

  private async persist(): Promise<void> {
    const entries = this.cache ?? {};
    const cipher = this.safeStorage.encryptString(JSON.stringify(entries));
    const payload: EncFile = { version: 1, payload: cipher.toString('base64') };
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, this.file);
  }

  async get(id: string): Promise<string | undefined> {
    const entries = await this.ensureLoaded();
    return entries[id];
  }

  async set(id: string, value: string): Promise<void> {
    const entries = await this.ensureLoaded();
    entries[id] = value;
    await this.persist();
  }

  async del(id: string): Promise<void> {
    const entries = await this.ensureLoaded();
    if (id in entries) {
      delete entries[id];
      await this.persist();
    }
  }

  async list(): Promise<string[]> {
    const entries = await this.ensureLoaded();
    return Object.keys(entries).sort();
  }
}

function resolveKeyFile(userData: string, cfg: SafeKeyStoreConfig): string {
  if (cfg.filePath) return cfg.filePath;
  return join(userData, cfg.subDir ?? 'ai-chat', cfg.fileName ?? 'keys.enc');
}

export const SafeKeyStorePlugin = definePlugin<SafeKeyStoreConfig>({
  name: 'SafeKeyStorePlugin',
  apply(ctx: PluginContext, cfg: SafeKeyStoreConfig) {
    if (!cfg.host) {
      ctx.logger.warn('SafeKeyStorePlugin skipped: no safeStorage injected by the host');
      return;
    }
    const { safeStorage, userData } = cfg.host;

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        '[SafeKeyStorePlugin] safeStorage.isEncryptionAvailable() === false; ' +
          'refuse to fall back to plaintext. ' +
          'On Linux please ensure a working keyring (gnome-keyring / kwallet) is present.',
      );
    }

    const file = resolveKeyFile(userData, cfg);
    const svc = new SafeKeyStoreService(safeStorage, ctx.logger, file);
    ctx.provide(KeyStoreKey, svc);
    ctx.logger.info(`SafeKeyStore ready: ${file}`);
  },
});
