import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SafeKeyStoreService } from '../../src/plugins/SafeKeyStorePlugin';

interface FakeSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(v: string): Buffer;
  decryptString(buf: Buffer): string;
}

function createFakeSafeStorage(available = true): FakeSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (v: string) => Buffer.from(`enc::${v}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc::')) throw new Error('cannot decrypt');
      return s.slice('enc::'.length);
    },
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('SafeKeyStoreService', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ig-key-store-'));
    file = join(dir, 'keys.enc');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('set then get roundtrips value', async () => {
    const svc = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    await svc.set('openai', 'sk-xxx');
    expect(await svc.get('openai')).toBe('sk-xxx');
  });

  it('persists encrypted payload to disk (base64 in JSON)', async () => {
    const svc = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    await svc.set('a', '1');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; payload: string };
    expect(parsed.version).toBe(1);
    // safeStorage 输出应为 base64 编码后的密文，不出现明文 value
    expect(raw.includes('sk-')).toBe(false);
    expect(raw.includes('"1"')).toBe(false);
    expect(Buffer.from(parsed.payload, 'base64').toString('utf8')).toContain('enc::');
  });

  it('list returns sorted ids', async () => {
    const svc = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    await svc.set('zeta', 'v1');
    await svc.set('alpha', 'v2');
    expect(await svc.list()).toEqual(['alpha', 'zeta']);
  });

  it('del removes the entry', async () => {
    const svc = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    await svc.set('a', '1');
    await svc.del('a');
    expect(await svc.get('a')).toBeUndefined();
    expect(await svc.list()).toEqual([]);
  });

  it('reads back from disk after restart', async () => {
    const svc1 = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    await svc1.set('openai', 'sk-xxx');
    await svc1.set('volc', 'vk-yyy');

    const svc2 = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    expect(await svc2.get('openai')).toBe('sk-xxx');
    expect(await svc2.get('volc')).toBe('vk-yyy');
    expect(await svc2.list()).toEqual(['openai', 'volc']);
  });

  it('returns undefined for missing key on empty file', async () => {
    const svc = new SafeKeyStoreService(createFakeSafeStorage(), logger, file);
    expect(await svc.get('nope')).toBeUndefined();
  });
});
