jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userData = '';
const safe = { available: true };

jest.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
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
