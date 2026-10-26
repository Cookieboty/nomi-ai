/**
 * Persist TTS config under userData/tts-config.json.
 * fish-cloud apiKey lives in safeStorage (keys/tts.fish.apiKey.bin), not in the JSON file.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { TTSConfig, TTSProvider } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';
import { app, safeStorage } from 'electron';

import { t as tr } from '../../i18n';
import { createMainLogger } from '../../utils/log';
import { writePrivateFile } from '../../utils/privateFile';

import { normalizeTtsConfig, validateTtsConfig } from './validateTtsConfig';

const log = createMainLogger('TTS-config');

type KeyProvider = 'fish-cloud';
const API_KEY_FILES: Record<KeyProvider, string> = { 'fish-cloud': 'tts.fish.apiKey.bin' };
const keyProviderOf = (p: TTSProvider | undefined): KeyProvider | undefined =>
  p === 'fish-cloud' ? p : undefined;

/** tts-config.json 的格式版本（2：移除内置离线引擎，默认 none） */
const CONFIG_SCHEMA_VERSION = 2;

export class FishTtsConfigStore {
  private configPath(): string {
    return path.join(app.getPath('userData'), 'tts-config.json');
  }

  private keyPath(provider: KeyProvider = 'fish-cloud'): string {
    return path.join(app.getPath('userData'), 'keys', API_KEY_FILES[provider]);
  }

  load(): TTSConfig {
    try {
      const p = this.configPath();
      if (!fs.existsSync(p)) {
        return { ...DEFAULT_TTS_CONFIG, lastModified: 0 };
      }
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<TTSConfig>;
      // Never keep apiKey from disk JSON；已移除的内置离线引擎等未知 provider 归一为 none
      const {
        apiKey: _drop,
        schemaVersion: _v,
        ...rest
      } = raw as Partial<TTSConfig> & {
        schemaVersion?: unknown;
      };
      const config = normalizeTtsConfig(rest);
      if ((raw as { provider?: unknown }).provider !== config.provider) {
        log.info('TTS provider normalized', { from: String(raw.provider), to: config.provider });
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
      hasApiKey: this.hasApiKey(keyProviderOf(cfg.provider)),
    };
  }

  save(input: TTSConfig): TTSConfig {
    const normalized = normalizeTtsConfig(input);
    const validation = validateTtsConfig(normalized);
    if (!validation.isValid) {
      throw new Error(`TTS config invalid: ${validation.errors.join(', ')}`);
    }

    const kp = keyProviderOf(normalized.provider);
    if (kp && input.clearApiKey) {
      this.clearApiKey(kp);
    } else if (kp && typeof input.apiKey === 'string' && input.apiKey.trim()) {
      this.setApiKey(input.apiKey.trim(), kp);
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
    this.clearApiKey('fish-cloud');
  }

  /** 只有真的能读出 Key 时才算已配置：解不开的文件不能让界面显示「已配置」（#35） */
  hasApiKey(provider: KeyProvider | undefined = 'fish-cloud'): boolean {
    return !!provider && !!this.getApiKey(provider);
  }

  getApiKey(provider: KeyProvider = 'fish-cloud'): string | undefined {
    let buf: Buffer;
    try {
      const p = this.keyPath(provider);
      if (!fs.existsSync(p)) return undefined;
      buf = fs.readFileSync(p);
    } catch {
      return undefined;
    }
    if (!buf.length) return undefined;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(buf);
      } catch {
        /* 可能是旧版本在安全存储不可用时写下的明文，见下 */
      }
    }
    const legacy = legacyPlainKey(buf);
    if (legacy === undefined) return undefined;
    // 旧明文：安全存储可用就就地加密迁移；不可用时照旧使用
    try {
      if (safeStorage.isEncryptionAvailable()) this.setApiKey(legacy, provider);
    } catch {
      /* 迁移失败不影响本次使用 */
    }
    return legacy;
  }

  setApiKey(value: string, provider: KeyProvider = 'fish-cloud'): void {
    const dir = path.dirname(this.keyPath(provider));
    fs.mkdirSync(dir, { recursive: true });
    // 安全存储不可用 / 加密失败：失败关闭，不把云 Key 以明文写进 keys/*.bin
    let buf: Buffer;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('unavailable');
      buf = safeStorage.encryptString(value);
    } catch {
      throw new Error(tr('electron.common.system-secure-storage-is-unavailable-so-the-cloud'));
    }
    fs.writeFileSync(this.keyPath(provider), buf, { mode: 0o600 });
  }

  clearApiKey(provider: KeyProvider = 'fish-cloud'): void {
    try {
      if (fs.existsSync(this.keyPath(provider))) fs.unlinkSync(this.keyPath(provider));
    } catch {
      /* ignore */
    }
  }
}

/** 旧版明文 Key：可打印 ASCII、无空白，长度合理；加密密文（含二进制前缀）不会满足 */
function legacyPlainKey(buf: Buffer): string | undefined {
  const s = buf.toString('utf8').trim();
  return /^[\x21-\x7e]{8,512}$/.test(s) ? s : undefined;
}
