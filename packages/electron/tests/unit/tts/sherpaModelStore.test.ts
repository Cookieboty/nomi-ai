jest.unmock('fs');
jest.unmock('path');

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ModelManifest } from '../../../src/tts/sherpa/manifest';
import {
  SHERPA_MANIFEST,
  SHERPA_MODEL_URL_ENV,
  resolveModelUrls,
} from '../../../src/tts/sherpa/manifest';
import {
  SherpaInstallError,
  installModel,
  locateModel,
  partialDownloadBytes,
  removeModel,
  verifyModelDir,
} from '../../../src/tts/sherpa/modelStore';

// 213 字节的 tar.bz2：tiny-model/model.onnx(8B)、tiny-model/dict/words.txt(3B)、
// 以及一个 zip-slip 条目 tiny-model/../../escape.txt（必须被丢弃）
const FIXTURE_B64 =
  'QlpoOTFBWSZTWaAx9mUAAOz/gMuABABAA//AAogCAH4n3+AKGDAArbBJUamQzSD0JoGmjQyPRPUGpqaZAAAA0AAASioxMAmTAAjIYIyGA9tCdEEirtjELxrSEhxZXgFgbQHNZIwGA2CIKAKhuERQP46dDqqrLSjgd1BB0FAGClKvQAAkgFMFHYceEEkCMi4kgLYGB513yO2BayXnoAn6uC/zZ7+I6XfcUMnjynDVciXEJnyA9F+e9ErZsweVUhlCFVBAJqXVEQcgQfxdyRThQkKAx9mU';
const FIXTURE = Buffer.from(FIXTURE_B64, 'base64');
const FIXTURE_SHA = '9735325ed4dfb93eef3512ebb21519dcb03ee22b3d92f91e168201b43fb0d9b6';

const manifest: ModelManifest = {
  id: 'tiny',
  url: 'https://example.invalid/tiny.tar.bz2',
  sha256: FIXTURE_SHA,
  bytes: FIXTURE.length,
  topDir: 'tiny-model',
  files: { 'model.onnx': 8, 'dict/words.txt': 3 },
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-sherpa-'));

function mk(root: string): string {
  fs.mkdirSync(path.join(root, 'dict'), { recursive: true });
  fs.writeFileSync(path.join(root, 'model.onnx'), '12345678');
  fs.writeFileSync(path.join(root, 'dict/words.txt'), 'abc');
  return root;
}

const okFetch = (body: Buffer) => async () =>
  new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-length': String(body.length) },
  });

describe('sherpa manifest', () => {
  it('pins archive sha256 + required files for the default model', () => {
    expect(SHERPA_MANIFEST.id).toBe('vits-zh-hf-theresa');
    expect(SHERPA_MANIFEST.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SHERPA_MANIFEST.url).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\//);
    expect(Object.keys(SHERPA_MANIFEST.files)).toEqual(
      expect.arrayContaining(['theresa.onnx', 'lexicon.txt', 'tokens.txt', 'dict/jieba.dict.utf8']),
    );
    expect(SHERPA_MANIFEST.files['theresa.onnx']).toBe(121913906);
  });
});

describe('verifyModelDir / locateModel', () => {
  it('requires every file with exact size', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'dict'));
    fs.writeFileSync(path.join(dir, 'model.onnx'), '12345678');
    expect(verifyModelDir(dir, manifest)).toEqual({ ok: false, bad: ['dict/words.txt'] });
    fs.writeFileSync(path.join(dir, 'dict/words.txt'), 'abcd');
    expect(verifyModelDir(dir, manifest).bad).toEqual(['dict/words.txt']);
    fs.writeFileSync(path.join(dir, 'dict/words.txt'), 'abc');
    expect(verifyModelDir(dir, manifest).ok).toBe(true);
  });

  it('prefers env > resources > dev > userData and ignores incomplete dirs', () => {
    const resources = mk(tmp());
    const dev = mk(tmp());
    const env = mk(tmp());
    const userRoot = tmp();
    const user = mk(path.join(userRoot, 'tiny'));
    const broken = tmp();
    expect(locateModel({ resourcesDir: resources, manifest })).toEqual({
      dir: resources,
      source: 'resources',
    });
    expect(locateModel({ resourcesDir: broken, manifest, devDirs: [broken, dev] })).toEqual({
      dir: dev,
      source: 'dev',
    });
    expect(locateModel({ resourcesDir: resources, manifest, devDirs: [dev], envDir: env })).toEqual(
      { dir: env, source: 'env' },
    );
    expect(locateModel({ resourcesDir: broken, manifest, envDir: broken, userRoot })).toEqual({
      dir: user,
      source: 'userData',
    });
    expect(locateModel({ resourcesDir: broken, manifest, envDir: broken })).toBeNull();
  });
});

describe('installModel', () => {
  it('downloads, verifies sha256, extracts (strip top dir) and drops zip-slip entries', async () => {
    const installRoot = tmp();
    const phases: string[] = [];
    const dir = await installModel({
      installRoot,
      manifest,
      fetchImpl: okFetch(FIXTURE),
      onProgress: (phase) => phases.push(phase),
    });
    expect(dir).toBe(path.join(installRoot, 'tiny'));
    expect(fs.readFileSync(path.join(dir, 'model.onnx'), 'utf8')).toBe('12345678');
    expect(fs.readFileSync(path.join(dir, 'dict/words.txt'), 'utf8')).toBe('abc');
    expect(fs.existsSync(path.join(installRoot, '..', 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(installRoot, 'escape.txt'))).toBe(false);
    expect(phases).toContain('download');
    expect(phases).toContain('extract');
    expect(fs.existsSync(`${dir}.partial`)).toBe(false);
    expect(fs.existsSync(path.join(installRoot, '.download', 'tiny.tar.bz2'))).toBe(false);
    expect(locateModel({ userRoot: installRoot, manifest })?.source).toBe('userData');
  });

  it('rejects a sha256 mismatch and installs nothing', async () => {
    const installRoot = tmp();
    const tampered = Buffer.from(FIXTURE);
    tampered[tampered.length - 1]! ^= 0xff;
    await expect(
      installModel({ installRoot, manifest, fetchImpl: okFetch(tampered) }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(installRoot, 'tiny'))).toBe(false);
    expect(fs.existsSync(path.join(installRoot, '.download', 'tiny.tar.bz2'))).toBe(false);
    expect(fs.existsSync(path.join(installRoot, '.download', 'tiny.tar.bz2.part'))).toBe(false);
  });

  it('rejects an archive whose extracted files do not match expected sizes', async () => {
    const installRoot = tmp();
    const bad: ModelManifest = { ...manifest, files: { 'model.onnx': 9, 'dict/words.txt': 3 } };
    await expect(
      installModel({ installRoot, manifest: bad, fetchImpl: okFetch(FIXTURE) }),
    ).rejects.toThrow(/校验失败|model\.onnx/);
    expect(fs.existsSync(path.join(installRoot, 'tiny'))).toBe(false);
    expect(fs.existsSync(path.join(installRoot, 'tiny.partial'))).toBe(false);
  });

  it('surfaces HTTP failures', async () => {
    const installRoot = tmp();
    await expect(
      installModel({
        installRoot,
        manifest,
        fetchImpl: async () => new Response('nope', { status: 404 }),
      }),
    ).rejects.toThrow(/404/);
    expect(fs.existsSync(path.join(installRoot, 'tiny'))).toBe(false);
  });

  it('retries a flaky download, then succeeds; logs each failure', async () => {
    const installRoot = tmp();
    let calls = 0;
    const events: string[] = [];
    const dir = await installModel({
      installRoot,
      manifest,
      retryDelayMs: 1,
      sleep: async () => undefined,
      onEvent: (m) => events.push(m),
      fetchImpl: async (...a) => {
        if (++calls < 3) throw new Error('read ECONNRESET');
        void a;
        return okFetch(FIXTURE)();
      },
    });
    expect(calls).toBe(3);
    expect(fs.existsSync(path.join(dir, 'model.onnx'))).toBe(true);
    expect(events.filter((e) => /download failed/.test(e))).toHaveLength(2);
  });

  it('falls through mirrors: 404 mirror skipped without retries, next url used', async () => {
    const installRoot = tmp();
    const seen: string[] = [];
    await installModel({
      installRoot,
      manifest,
      urls: ['https://mirror.invalid/a', 'https://mirror2.invalid/b'],
      sleep: async () => undefined,
      fetchImpl: async (url) => {
        seen.push(url);
        return url.includes('mirror.invalid')
          ? new Response('nf', { status: 404 })
          : okFetch(FIXTURE)();
      },
    });
    expect(seen).toEqual(['https://mirror.invalid/a', 'https://mirror2.invalid/b']);
  });

  it('all urls failing → SherpaInstallError(download) with mirror hint, no residue', async () => {
    const installRoot = tmp();
    const err = await installModel({
      installRoot,
      manifest,
      attempts: 2,
      sleep: async () => undefined,
      fetchImpl: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SherpaInstallError);
    expect(err.phase).toBe('download');
    expect(err.message).toMatch(/ETIMEDOUT/);
    expect(err.message).toMatch(/NOMI_SHERPA_TTS_MODEL_URL/);
    expect(fs.existsSync(path.join(installRoot, 'tiny'))).toBe(false);
  });

  it('stalled download times out (idle) instead of hanging forever', async () => {
    const installRoot = tmp();
    const err = await installModel({
      installRoot,
      manifest,
      attempts: 1,
      idleTimeoutMs: 50,
      fetchImpl: (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SherpaInstallError);
    expect(err.message).toMatch(/stalled|timeout/i);
  });

  it('unwritable install root → prepare error up-front (no download attempted)', async () => {
    const f = path.join(tmp(), 'afile');
    fs.writeFileSync(f, 'x');
    const download = jest.fn();
    const err = await installModel({ installRoot: path.join(f, 'sub'), manifest, download }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SherpaInstallError);
    expect(err.phase).toBe('prepare');
    expect(download).not.toHaveBeenCalled();
  });

  it('resolveModelUrls: env mirrors first (comma/space/semicolon), official last, http(s) only', () => {
    expect(resolveModelUrls(manifest, {})).toEqual([manifest.url]);
    expect(
      resolveModelUrls(manifest, {
        [SHERPA_MODEL_URL_ENV]: 'https://m1/a.tar.bz2, http://m2/b.tar.bz2;ftp://bad  file:///c',
      }),
    ).toEqual(['https://m1/a.tar.bz2', 'http://m2/b.tar.bz2', manifest.url]);
  });

  it('sanity: fixture sha constant matches the embedded bytes', () => {
    expect(createHash('sha256').update(FIXTURE).digest('hex')).toBe(FIXTURE_SHA);
  });
});

describe('removeModel / partialDownloadBytes', () => {
  const m: ModelManifest = {
    id: 'tiny',
    url: 'u',
    sha256: '0'.repeat(64),
    bytes: 1,
    topDir: 'tiny',
    files: {},
  };

  it('reports partial bytes and removes model / partial / download dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-rm-'));
    fs.mkdirSync(path.join(root, 'tiny'));
    fs.mkdirSync(path.join(root, 'tiny.partial'));
    fs.mkdirSync(path.join(root, '.download'));
    fs.writeFileSync(path.join(root, '.download', 'tiny.tar.bz2.part'), 'abc');
    expect(partialDownloadBytes(root, m)).toBe(3);
    removeModel(root, m, { keepModel: true });
    expect(fs.existsSync(path.join(root, 'tiny'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.download'))).toBe(false);
    expect(partialDownloadBytes(root, m)).toBe(0);
    removeModel(root, m);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('installModel forwards resume to the downloader', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-resume-'));
    const download = jest.fn(async () => {
      throw Object.assign(new Error('nope'), { status: 404 });
    });
    await expect(
      installModel({ installRoot: root, manifest: m, download: download as never, resume: true }),
    ).rejects.toBeInstanceOf(SherpaInstallError);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ resume: true }));
  });
});
