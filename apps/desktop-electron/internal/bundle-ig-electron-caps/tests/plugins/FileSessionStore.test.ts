import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UserProfile } from '@nomi-ai/bundle-ig-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileProfileStorage, FileSessionStore } from '../../src/plugins/FileSessionStorePlugin';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('FileSessionStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ig-sess-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append writes JSONL lines and read parses them back', async () => {
    const store = new FileSessionStore(dir, 1024 * 1024, logger);
    await store.append('s1', { kind: 'user', text: 'hello' });
    await store.append('s1', { kind: 'assistant', text: 'hi' });
    const records = await store.read('s1');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(records[1]).toMatchObject({ kind: 'assistant', text: 'hi' });
  });

  it('list returns sessions without .jsonl suffix', async () => {
    const store = new FileSessionStore(dir, 1024 * 1024, logger);
    await store.append('s2', { x: 1 });
    await store.append('s1', { x: 1 });
    expect(await store.list()).toEqual(['s1', 's2']);
  });

  it('rotates when file exceeds threshold', async () => {
    const store = new FileSessionStore(dir, 32, logger);
    await store.append('rot', { pad: 'aaaaaaaaaaaaaaaa' });
    await store.append('rot', { pad: 'bbbbbbbbbbbbbbbb' });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    const rotFiles = entries.filter((f) => f.startsWith('rot.jsonl.') && f.endsWith('.rot'));
    expect(rotFiles.length).toBeGreaterThanOrEqual(1);
    expect(entries).toContain('rot.jsonl');
  });

  it('read returns empty array for missing session', async () => {
    const store = new FileSessionStore(dir, 1024, logger);
    expect(await store.read('never-existed')).toEqual([]);
  });
});

describe('FileProfileStorage', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ig-profile-'));
    file = join(dir, 'memory', 'user_profile.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample: UserProfile = {
    version: 1,
    identity: { displayName: 'boty' },
    preferences: {},
    habits: {},
    dislikes: [],
    createdAt: 1,
    updatedAt: 1,
  };

  it('read returns undefined when file missing', async () => {
    const store = new FileProfileStorage(file, logger);
    expect(await store.read()).toBeUndefined();
  });

  it('write then read roundtrips profile', async () => {
    const store = new FileProfileStorage(file, logger);
    await store.write(sample);
    const roundtrip = await store.read();
    expect(roundtrip).toEqual(sample);
  });

  it('write uses temp file + rename (atomic)', async () => {
    const store = new FileProfileStorage(file, logger);
    await store.write(sample);
    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toEqual(sample);
    const { readdir } = await import('node:fs/promises');
    const remains = await readdir(join(dir, 'memory'));
    expect(remains.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('clear removes file and is idempotent', async () => {
    const store = new FileProfileStorage(file, logger);
    await store.write(sample);
    await store.clear();
    expect(await store.read()).toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
