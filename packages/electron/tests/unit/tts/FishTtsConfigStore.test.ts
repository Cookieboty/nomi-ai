jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData = '';
const safe = { available: true, throws: false };

jest.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => {
      if (safe.throws) throw new Error('keychain locked');
      return Buffer.from(`enc:${s}`);
    },
    // 与真实 safeStorage 一致：不是本机密文就抛错
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext');
      return s.slice(4);
    },
  },
}));

import type { TTSConfig } from '@nomi-ai/types';
import { DEFAULT_TTS_CONFIG } from '@nomi-ai/types';

import { FishTtsConfigStore } from '../../../src/tts/fish/FishTtsConfigStore';

const cfgFile = () => path.join(userData, 'tts-config.json');
const onDisk = () => JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) as Record<string, unknown>;
const fishLocalDefault = (): TTSConfig => ({
  ...DEFAULT_TTS_CONFIG,
  lastModified: 0,
  provider: 'fish-local',
  baseUrl: 'http://127.0.0.1:8080',
  referenceId: 'nomi',
  format: 'mp3',
});

describe('FishTtsConfigStore save → load（#31）', () => {
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-cfg-'));
    safe.available = true;
    safe.throws = false;
  });
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

  it('新保存的 fish-local 默认组合：返回值、文件、重新创建 store 后都保持 fish-local', () => {
    const saved = new FishTtsConfigStore().save(fishLocalDefault());
    expect(saved.provider).toBe('fish-local');
    expect(onDisk()).toMatchObject({ provider: 'fish-local', schemaVersion: 1 });

    const again = new FishTtsConfigStore();
    expect(again.load().provider).toBe('fish-local');
    expect(again.loadPublic().provider).toBe('fish-local');
    expect(onDisk().provider).toBe('fish-local');
  });

  it('不把 schemaVersion 泄露给渲染端', () => {
    const store = new FishTtsConfigStore();
    store.save(fishLocalDefault());
    expect(store.loadPublic()).not.toHaveProperty('schemaVersion');
  });

  it('旧的无版本配置（fish-local 旧产品默认）只迁移一次，随后用户再选 fish-local 保持不变', () => {
    fs.writeFileSync(
      cfgFile(),
      JSON.stringify({
        provider: 'fish-local',
        baseUrl: 'http://127.0.0.1:8080',
        referenceId: 'nomi',
      }),
    );
    const store = new FishTtsConfigStore();
    expect(store.load().provider).toBe('sherpa-theresa');
    expect(onDisk()).toMatchObject({ provider: 'sherpa-theresa', schemaVersion: 1 });

    store.save(fishLocalDefault());
    expect(new FishTtsConfigStore().load().provider).toBe('fish-local');
  });

  it('旧的无版本配置：自定义 Fish 与 fish-cloud 不迁移', () => {
    fs.writeFileSync(
      cfgFile(),
      JSON.stringify({
        provider: 'fish-local',
        baseUrl: 'http://10.0.0.5:8080',
        referenceId: 'me',
      }),
    );
    expect(new FishTtsConfigStore().load()).toMatchObject({
      provider: 'fish-local',
      baseUrl: 'http://10.0.0.5:8080',
      referenceId: 'me',
    });
    fs.writeFileSync(
      cfgFile(),
      JSON.stringify({ provider: 'fish-cloud', baseUrl: 'https://api.fish.audio' }),
    );
    expect(new FishTtsConfigStore().load().provider).toBe('fish-cloud');
  });
});

describe('Fish 云 Key 落盘（#35）', () => {
  const keyFile = () => path.join(userData, 'keys', 'tts.fish.apiKey.bin');
  const cloud = (): TTSConfig => ({
    ...fishLocalDefault(),
    provider: 'fish-cloud',
    baseUrl: 'https://api.fish.audio',
    apiKey: 'FISH_SECRET_KEY_123',
  });
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-key-'));
    safe.available = true;
    safe.throws = false;
  });
  afterEach(() => fs.rmSync(userData, { recursive: true, force: true }));

  it.each([
    ['safeStorage 不可用', () => (safe.available = false)],
    ['encryptString 抛错', () => (safe.throws = true)],
  ])('%s：保存云 Key 失败关闭——不写明文，配置也不被部分写入', (_n, arrange) => {
    arrange();
    const store = new FishTtsConfigStore();
    expect(() => store.save(cloud())).toThrow(/安全存储不可用/);
    expect(fs.existsSync(keyFile())).toBe(false);
    expect(fs.existsSync(cfgFile())).toBe(false);
    expect(store.hasApiKey()).toBe(false);
  });

  it('安全存储可用：Key 以密文写入 0600 文件，配置 JSON 与公开配置里都没有 Key', () => {
    const store = new FishTtsConfigStore();
    const pub = store.save(cloud());
    expect(pub.hasApiKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('FISH_SECRET_KEY_123');
    expect(fs.readFileSync(cfgFile(), 'utf8')).not.toContain('FISH_SECRET_KEY_123');
    expect(fs.readFileSync(keyFile(), 'utf8')).toBe('enc:FISH_SECRET_KEY_123');
    if (process.platform !== 'win32') expect(fs.statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(store.getApiKey()).toBe('FISH_SECRET_KEY_123');
  });

  const writeKey = (buf: Buffer | string) => {
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), buf);
  };

  it('旧版本留下的明文 Key：能读出并就地加密迁移', () => {
    writeKey('LEGACY_PLAIN_KEY_42');
    const store = new FishTtsConfigStore();
    expect(store.hasApiKey()).toBe(true);
    expect(store.getApiKey()).toBe('LEGACY_PLAIN_KEY_42');
    expect(fs.readFileSync(keyFile(), 'utf8')).toBe('enc:LEGACY_PLAIN_KEY_42');
  });

  it('旧明文 Key 在安全存储不可用时照旧可用、不改文件', () => {
    safe.available = false;
    writeKey('LEGACY_PLAIN_KEY_42');
    expect(new FishTtsConfigStore().getApiKey()).toBe('LEGACY_PLAIN_KEY_42');
    expect(fs.readFileSync(keyFile(), 'utf8')).toBe('LEGACY_PLAIN_KEY_42');
  });

  it('解不开的 Key 文件不算「已配置」', () => {
    writeKey(Buffer.from([0x76, 0x31, 0x30, 0x00, 0xff, 0x13, 0x88, 0x01, 0x02, 0x9a]));
    const store = new FishTtsConfigStore();
    expect(store.getApiKey()).toBeUndefined();
    expect(store.hasApiKey()).toBe(false);
    expect(store.loadPublic().hasApiKey).toBe(false);
  });

  it('不带 Key 的保存（如只改声线）在安全存储不可用时仍可保存', () => {
    safe.available = false;
    const { apiKey: _k, ...noKey } = cloud();
    expect(() => new FishTtsConfigStore().save(noKey as TTSConfig)).not.toThrow();
  });
});
