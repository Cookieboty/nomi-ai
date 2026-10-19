jest.unmock('fs');
jest.unmock('path');

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { downloadVerified } from '../../../src/voice/download';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-resume-'));
const full = Buffer.from('0123456789abcdefghij');
const sha = createHash('sha256').update(full).digest('hex');

/** 支持 Range 的假服务器；记录请求头 */
function rangeServer(opts: { supportsRange?: boolean; failAfter?: number } = {}) {
  const calls: Array<Record<string, string> | undefined> = [];
  const f = async (_u: string, init: { headers?: Record<string, string> }) => {
    calls.push(init.headers);
    const m = /bytes=(\d+)-/.exec(init.headers?.Range ?? '');
    const start = m && opts.supportsRange !== false ? Number(m[1]) : 0;
    const slice = full.subarray(start);
    const status = start > 0 ? 206 : 200;
    if (opts.failAfter !== undefined) {
      const n = opts.failAfter;
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          // 先给一块，下一次读再断开（error() 会丢弃队列里未读的块）
          if (!sent) {
            sent = true;
            c.enqueue(new Uint8Array(slice.subarray(0, n)));
          } else c.error(new Error('ECONNRESET'));
        },
      });
      return new Response(stream, { status, headers: { 'content-length': String(slice.length) } });
    }
    return new Response(new Uint8Array(slice), {
      status,
      headers: { 'content-length': String(slice.length) },
    });
  };
  return { f, calls };
}

describe('downloadVerified resume', () => {
  it('keeps .part on a network error and resumes with Range on the next call', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    const broken = rangeServer({ failAfter: 8 });
    await expect(
      downloadVerified({ url: 'u', sha256: sha, dest, resume: true, fetchImpl: broken.f as never }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fs.readFileSync(`${dest}.part`).toString()).toBe('01234567');

    const ok = rangeServer();
    const seen: Array<{ received: number; total: number }> = [];
    await downloadVerified({
      url: 'u',
      sha256: sha,
      dest,
      resume: true,
      fetchImpl: ok.f as never,
      onProgress: (p) => seen.push(p),
    });
    expect(ok.calls[0]).toEqual({ Range: 'bytes=8-' });
    expect(fs.readFileSync(dest).equals(full)).toBe(true);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(seen[0]).toEqual({ received: 8, total: 20 });
    expect(seen.at(-1)).toEqual({ received: 20, total: 20 });
  });

  it('server ignores Range (200) → restarts from scratch and still verifies', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    fs.writeFileSync(`${dest}.part`, 'garbage!');
    const s = rangeServer({ supportsRange: false });
    await downloadVerified({ url: 'u', sha256: sha, dest, resume: true, fetchImpl: s.f as never });
    expect(s.calls[0]).toEqual({ Range: 'bytes=8-' });
    expect(fs.readFileSync(dest).equals(full)).toBe(true);
  });

  it('corrupt partial → checksum mismatch deletes .part so the next attempt restarts', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    fs.writeFileSync(`${dest}.part`, 'XXXXXXXX');
    const s = rangeServer();
    await expect(
      downloadVerified({ url: 'u', sha256: sha, dest, resume: true, fetchImpl: s.f as never }),
    ).rejects.toThrow();
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('partial larger than expectedBytes is ignored (full download)', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    fs.writeFileSync(`${dest}.part`, 'x'.repeat(50));
    const s = rangeServer();
    await downloadVerified({
      url: 'u',
      sha256: sha,
      dest,
      resume: true,
      expectedBytes: 20,
      fetchImpl: s.f as never,
    });
    expect(s.calls[0]).toEqual({});
    expect(fs.readFileSync(dest).equals(full)).toBe(true);
  });

  it('without resume, a failure removes .part (legacy behavior)', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    const broken = rangeServer({ failAfter: 8 });
    await expect(
      downloadVerified({ url: 'u', sha256: sha, dest, fetchImpl: broken.f as never }),
    ).rejects.toThrow();
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
  });

  it('abort keeps the partial in resume mode (caller decides to delete it)', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    const ctl = new AbortController();
    const f = async (_u: string, init: { signal?: AbortSignal }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(full.subarray(0, 5)));
          init.signal?.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      });
      setTimeout(() => ctl.abort(), 20);
      return new Response(stream, { headers: { 'content-length': '20' } });
    };
    await expect(
      downloadVerified({
        url: 'u',
        sha256: sha,
        dest,
        resume: true,
        signal: ctl.signal,
        fetchImpl: f as never,
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(`${dest}.part`).toString()).toBe('01234');
  });
});
