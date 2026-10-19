jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ModelManifest } from '../../../src/tts/sherpa/manifest';
import { SherpaAddonLoadError } from '../../../src/tts/sherpa/nativeAddon';
import {
  SherpaTtsError,
  SherpaTtsService,
  type SherpaAddon,
  type SherpaHandle,
} from '../../../src/tts/sherpa/SherpaTtsService';

const manifest: ModelManifest = {
  id: 'tiny',
  url: 'https://example.invalid/tiny.tar.bz2',
  sha256: '0'.repeat(64),
  bytes: 1,
  topDir: 'tiny',
  files: { 'model.onnx': 1 },
};

function modelRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-sherpa-svc-'));
  fs.mkdirSync(path.join(root, 'tiny'));
  fs.writeFileSync(path.join(root, 'tiny', 'model.onnx'), 'x');
  return root;
}

function fakeAddon() {
  const generate = jest.fn(async (req: { text: string; sid: number; speed: number }) => ({
    samples: new Float32Array(req.text.length * 100).fill(0.1),
    sampleRate: 22050,
  }));
  const handle: SherpaHandle = { sampleRate: 22050, generateAsync: generate };
  const createAsync = jest.fn(async (_cfg: unknown) => handle);
  const addon: SherpaAddon = { OfflineTts: { createAsync } };
  return { addon, createAsync, generate };
}

describe('SherpaTtsService', () => {
  it('is lazy: addon not loaded until first synth; engine is a singleton', async () => {
    const { addon, createAsync, generate } = fakeAddon();
    const loadAddon = jest.fn(() => addon);
    const root = modelRoot();
    const svc = new SherpaTtsService({
      userRoot: () => root,
      loadAddon,
      manifest,
    });
    expect(loadAddon).not.toHaveBeenCalled();
    const [ra, rb] = await Promise.allSettled([
      svc.synthesize('你好。世界。'),
      svc.synthesize('再见。'),
    ]);
    expect(ra.status).toBe('rejected');
    expect((ra as PromiseRejectedResult).reason).toBeInstanceOf(SherpaTtsError);
    expect((ra as PromiseRejectedResult).reason.code).toBe('superseded');
    expect(rb.status).toBe('fulfilled');
    expect((rb as PromiseFulfilledResult<{ sentences: number }>).value.sentences).toBe(1);
    await svc.synthesize('第三次。');
    expect(loadAddon).toHaveBeenCalledTimes(1);
    expect(createAsync).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalled();
  });

  it('passes the model config with sid / speed, splits sentences and returns a WAV', async () => {
    const { addon, createAsync, generate } = fakeAddon();
    const root = modelRoot();
    const svc = new SherpaTtsService({
      userRoot: () => root,
      loadAddon: () => addon,
      manifest,
    });
    const r = await svc.synthesize('你好。世界！', { sid: 0, speed: 1.0 });
    expect(r.sentences).toBe(2);
    expect(r.wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(r.sampleRate).toBe(22050);
    expect(generate.mock.calls.map((c) => c[0])).toEqual([
      { text: '你好。', sid: 0, speed: 1.0, enableExternalBuffer: false },
      { text: '世界！', sid: 0, speed: 1.0, enableExternalBuffer: false },
    ]);
    const cfg = createAsync.mock.calls[0]![0] as {
      model: { vits: Record<string, string>; numThreads: number; provider: string };
      ruleFsts: string;
      maxNumSentences: number;
    };
    expect(cfg.model.vits.model).toBe(path.join(root, 'tiny', 'theresa.onnx'));
    expect(cfg.model.vits.dictDir).toBe(path.join(root, 'tiny', 'dict'));
    expect(cfg.model.numThreads).toBe(4);
    expect(cfg.model.provider).toBe('cpu');
    expect(cfg.maxNumSentences).toBe(1);
    expect(cfg.ruleFsts.split(',').map((p) => path.basename(p))).toEqual([
      'phone.fst',
      'date.fst',
      'number.fst',
      'new_heteronym.fst',
    ]);
  });

  it('defaults to sid 0 / speed 1.0 and disables external buffers (Electron)', async () => {
    const { addon, generate } = fakeAddon();
    const svc = new SherpaTtsService({
      userRoot: () => modelRoot(),
      loadAddon: () => addon,
      manifest,
    });
    await svc.synthesize('你好');
    expect(generate).toHaveBeenCalledWith({
      text: '你好',
      sid: 0,
      speed: 1.0,
      enableExternalBuffer: false,
    });
  });

  it('missing model → not_ready with a hint; never downloads, never loads the addon', async () => {
    const loadAddon = jest.fn();
    const install = jest.fn();
    const svc = new SherpaTtsService({
      userRoot: () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-sherpa-empty-')),
      loadAddon,
      install: install as never,
      manifest,
    });
    await expect(svc.synthesize('你好')).rejects.toMatchObject({
      code: 'not_ready',
      message: expect.stringMatching(/enable voice in Settings/),
    });
    await expect(svc.warmup()).rejects.toMatchObject({ code: 'not_ready' });
    expect(install).not.toHaveBeenCalled();
    expect(loadAddon).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ state: 'missing', modelId: 'tiny', partialBytes: 0 });
  });

  it('no userData at all → status missing and synth not_ready (no crash)', async () => {
    const svc = new SherpaTtsService({
      userRoot: () => {
        throw new Error('app not ready');
      },
      manifest,
    });
    expect(svc.getStatus().state).toBe('missing');
    await expect(svc.synthesize('你好')).rejects.toMatchObject({ code: 'not_ready' });
    await expect(svc.download()).rejects.toMatchObject({ code: 'not_ready' });
  });

  describe('explicit download()', () => {
    function setup() {
      const { addon, createAsync } = fakeAddon();
      const loadAddon = jest.fn(() => addon);
      const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-sherpa-install-'));
      let release!: () => void;
      let fail!: (e: Error) => void;
      const gate = new Promise<void>((res, rej) => {
        release = res;
        fail = rej;
      });
      let onProgress:
        | ((phase: 'download' | 'extract', p: { received: number; total: number }) => void)
        | undefined;
      const seen: Array<{ installRoot: string; resume?: boolean; signal?: AbortSignal }> = [];
      const install = jest.fn(
        async (o: {
          installRoot: string;
          resume?: boolean;
          signal?: AbortSignal;
          onProgress?: typeof onProgress;
        }) => {
          seen.push(o);
          onProgress = o.onProgress;
          await new Promise<void>((res, rej) => {
            gate.then(res, rej);
            o.signal?.addEventListener('abort', () => rej(new Error('aborted')));
          });
          const dir = path.join(o.installRoot, 'tiny');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'model.onnx'), 'x');
          return dir;
        },
      );
      const statuses: string[] = [];
      const svc = new SherpaTtsService({
        userRoot: () => userRoot,
        loadAddon,
        install: install as never,
        manifest,
        log: () => undefined,
      });
      svc.onStatus((st) => statuses.push(st.state));
      return {
        svc,
        install,
        seen,
        loadAddon,
        createAsync,
        userRoot,
        statuses,
        release,
        fail,
        progress: (n: number) => onProgress?.('download', { received: n, total: 100 }),
      };
    }

    it('downloads into userData with resume on; single-flight; progress; then sherpa works offline', async () => {
      const t = setup();
      const p1 = t.svc.download();
      const p2 = t.svc.download();
      expect(t.install).toHaveBeenCalledTimes(1);
      expect(t.seen[0]).toMatchObject({ installRoot: t.userRoot, resume: true });
      expect(t.svc.getStatus()).toMatchObject({ state: 'downloading', phase: 'download' });
      await expect(t.svc.synthesize('你好')).rejects.toMatchObject({ code: 'downloading' });
      t.progress(42);
      expect(t.svc.getStatus()).toMatchObject({ received: 42, total: 100 });
      t.release();
      await Promise.all([p1, p2]);
      expect(t.svc.getStatus()).toMatchObject({ state: 'ready', source: 'userData' });
      expect(t.statuses).toContain('downloading');
      expect(t.statuses[t.statuses.length - 1]).toBe('ready');
      const r = await t.svc.synthesize('你好');
      expect(r.sentences).toBe(1);
      // 已就绪再调用：不再下载
      await t.svc.download();
      expect(t.install).toHaveBeenCalledTimes(1);
    });

    it('failure → state error with the message; synth stays not_ready; retry downloads again', async () => {
      const t = setup();
      const p = t.svc.download();
      t.fail(new Error('connect ETIMEDOUT github.com'));
      await expect(p).rejects.toMatchObject({ code: 'not_ready', message: /ETIMEDOUT/ });
      expect(t.svc.getStatus()).toMatchObject({ state: 'error', message: /ETIMEDOUT/ });
      await expect(t.svc.synthesize('b')).rejects.toMatchObject({ code: 'not_ready' });
      void t.svc.download().catch(() => undefined);
      expect(t.install).toHaveBeenCalledTimes(2);
    });

    it('cancelDownload aborts, rejects with superseded and removes the partial files', async () => {
      const t = setup();
      const tmp = path.join(t.userRoot, '.download');
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tiny.tar.bz2.part'), 'abc');
      expect(t.svc.getStatus().state).toBe('missing');
      const p = t.svc.download();
      await t.svc.cancelDownload();
      await expect(p).rejects.toMatchObject({ code: 'superseded' });
      expect(t.seen[0]!.signal!.aborted).toBe(true);
      expect(fs.existsSync(tmp)).toBe(false);
      expect(t.svc.getStatus()).toMatchObject({ state: 'missing', partialBytes: 0 });
    });

    it('reports partialBytes left by a previous (quit mid-download) run', () => {
      const t = setup();
      const tmp = path.join(t.userRoot, '.download');
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tiny.tar.bz2.part'), 'abcd');
      expect(t.svc.getStatus()).toMatchObject({ state: 'missing', partialBytes: 4 });
    });

    it('deleteModel removes the userData model and resets the engine', async () => {
      const t = setup();
      const p = t.svc.download();
      t.release();
      await p;
      await t.svc.synthesize('你好');
      const st = await t.svc.deleteModel();
      expect(st.state).toBe('missing');
      expect(fs.existsSync(path.join(t.userRoot, 'tiny'))).toBe(false);
      await expect(t.svc.synthesize('你好')).rejects.toMatchObject({ code: 'not_ready' });
    });
  });

  it('addon native-load error is surfaced verbatim (engine_failed) and logged', async () => {
    const logs: string[] = [];
    const svc = new SherpaTtsService({
      userRoot: () => modelRoot(),
      loadAddon: () => {
        throw new SherpaAddonLoadError('缺少 VC++ 运行库 VCRUNTIME140_1.dll');
      },
      manifest,
      log: (m: string) => logs.push(m),
    });
    await expect(svc.synthesize('你好')).rejects.toMatchObject({
      code: 'engine_failed',
      message: expect.stringContaining('VCRUNTIME140_1'),
    });
    expect(logs.some((l) => /engine load FAILED/.test(l))).toBe(true);
  });

  it('addon load failure → engine_failed, then cooldown avoids retrying immediately', async () => {
    let now = 1_000_000;
    const loadAddon = jest.fn(() => {
      throw new Error('dlopen failed');
    });
    const svc = new SherpaTtsService({
      userRoot: () => modelRoot(),
      loadAddon,
      manifest,
      now: () => now,
    });
    await expect(svc.synthesize('你好')).rejects.toMatchObject({ code: 'engine_failed' });
    await expect(svc.synthesize('你好')).rejects.toMatchObject({ code: 'engine_failed' });
    expect(loadAddon).toHaveBeenCalledTimes(1);
    now += 61_000;
    await expect(svc.synthesize('你好')).rejects.toMatchObject({ code: 'engine_failed' });
    expect(loadAddon).toHaveBeenCalledTimes(2);
  });

  it('rejects empty, unreadable and over-long text', async () => {
    const { addon } = fakeAddon();
    const svc = new SherpaTtsService({
      userRoot: () => modelRoot(),
      loadAddon: () => addon,
      manifest,
    });
    await expect(svc.synthesize('   ')).rejects.toMatchObject({ code: 'empty' });
    await expect(svc.synthesize('。。。')).rejects.toMatchObject({ code: 'empty' });
    await expect(svc.synthesize('啊'.repeat(1501))).rejects.toMatchObject({ code: 'too_long' });
  });

  it('reports ready when userData has a valid model; env dir wins', () => {
    const root = modelRoot();
    const svc = new SherpaTtsService({ userRoot: () => root, manifest });
    expect(svc.getStatus()).toMatchObject({ state: 'ready', source: 'userData', modelId: 'tiny' });
    const env = path.join(modelRoot(), 'tiny');
    const svc2 = new SherpaTtsService({ envDir: () => env, userRoot: () => root, manifest });
    expect(svc2.getStatus()).toMatchObject({ state: 'ready', source: 'env' });
  });
});
