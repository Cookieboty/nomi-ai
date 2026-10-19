/**
 * Persist TTS config under userData/tts-config.json.
 * fish-cloud apiKey lives in safeStorage (keys/tts.fish.apiKey.bin), not in the JSON file.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { TTSConfig } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';
import { app, safeStorage } from 'electron';

import { t as tr } from '../../i18n';
import { createMainLogger } from '../../utils/log';
import { writePrivateFile } from '../../utils/privateFile';

import {
  migrateTtsConfigProvider,
  normalizeTtsConfig,
  validateTtsConfig,
} from './validateTtsConfig';

const log = createMainLogger('FishTTS-config');

const API_KEY_FILE = 'tts.fish.apiKey.bin';

/**
 * tts-config.json 的格式版本。新写入一律带当前版本；缺失版本号 = 旧版本写出的文件，
 * 只有这类文件才会跑「fish-local 旧产品默认 → sherpa」一次性迁移，
 * 用户在新版本里主动保存的 Fish 默认组合不会再被改回去。
 */
const CONFIG_SCHEMA_VERSION = 1;

export class FishTtsConfigStore {
  private configPath(): string {
    return path.join(app.getPath('userData'), 'tts-config.json');
  }

  private keyPath(): string {
    return path.join(app.getPath('userData'), 'keys', API_KEY_FILE);
  }

  load(): TTSConfig {
    try {
      const p = this.configPath();
      if (!fs.existsSync(p)) {
        return { ...DEFAULT_TTS_CONFIG, lastModified: 0 };
      }
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<TTSConfig>;
      // Never keep apiKey from disk JSON
      const {
        apiKey: _drop,
        schemaVersion,
        ...rest
      } = raw as Partial<TTSConfig> & {
        schemaVersion?: unknown;
      };
      // 只迁移没有版本号的旧文件；带版本号的文件里的 provider 是用户（或迁移）的明确结果
      const { config, migrated } =
        typeof schemaVersion === 'number'
          ? { config: normalizeTtsConfig(rest), migrated: false }
          : migrateTtsConfigProvider(rest);
      if (migrated) {
        // Persist (with the current schemaVersion) so the migration runs exactly once;
        // intentional Fish users with custom baseUrl/referenceId are not migrated
        // (see isLegacyFishProductDefault).
        // Write directly (avoid save→loadPublic→load recursion).
        try {
          log.info('migrated legacy fish-local product default → sherpa-theresa');
          const toDisk: Record<string, unknown> = {
            ...config,
            schemaVersion: CONFIG_SCHEMA_VERSION,
            lastModified: Date.now(),
          };
          delete toDisk.apiKey;
          delete toDisk.hasApiKey;
          delete toDisk.clearApiKey;
          writePrivateFile(this.configPath(), JSON.stringify(toDisk, null, 2));
        } catch (e) {
          log.warn('TTS provider migration save failed; using in-memory sherpa default', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return config;
      }
      return config;
    } catch {
      return { ...DEFAULT_TTS_CONFIG, lastModified: 0 };
    }
  }

  /** Config safe to send to renderer (apiKey stripped; hasApiKey set). */
  loadPublic(): TTSConfig {
    const cfg = this.load();
    return {
      ...cfg,
      apiKey: '',
      hasApiKey: this.hasApiKey(),
    };
  }

  save(input: TTSConfig): TTSConfig {
    const normalized = normalizeTtsConfig(input);
    const validation = validateTtsConfig(normalized);
    if (!validation.isValid) {
      throw new Error(`TTS config invalid: ${validation.errors.join(', ')}`);
    }

    if (input.clearApiKey) {
      this.clearApiKey();
    } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      this.setApiKey(input.apiKey.trim());
    }

    const toDisk: Record<string, unknown> = {
      ...normalized,
      schemaVersion: CONFIG_SCHEMA_VERSION,
      lastModified: Date.now(),
    };
    delete toDisk.apiKey;
    delete toDisk.hasApiKey;
    delete toDisk.clearApiKey;

    writePrivateFile(this.configPath(), JSON.stringify(toDisk, null, 2));
    return this.loadPublic();
  }

  reset(): void {
    const p = this.configPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    this.clearApiKey();
  }

  hasApiKey(): boolean {
    try {
      return fs.existsSync(this.keyPath()) && fs.statSync(this.keyPath()).size > 0;
    } catch {
      return false;
    }
  }

  getApiKey(): string | undefined {
    try {
      const p = this.keyPath();
      if (!fs.existsSync(p)) return undefined;
      const buf = fs.readFileSync(p);
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buf);
      }
      return buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  setApiKey(value: string): void {
    const dir = path.dirname(this.keyPath());
    fs.mkdirSync(dir, { recursive: true });
    // 安全存储不可用 / 加密失败：失败关闭，不把云 Key 以明文写进 keys/*.bin
    let buf: Buffer;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('unavailable');
      buf = safeStorage.encryptString(value);
    } catch {
      throw new Error(tr('系统安全存储不可用，无法安全保存云 Key；请在系统钥匙串可用后重试'));
    }
    fs.writeFileSync(this.keyPath(), buf, { mode: 0o600 });
  }

  clearApiKey(): void {
    try {
      if (fs.existsSync(this.keyPath())) fs.unlinkSync(this.keyPath());
    } catch {
      /* ignore */
    }
  }
}
