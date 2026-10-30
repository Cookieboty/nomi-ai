/**
 * Sec-MS-GEC token for the Edge read-aloud endpoint (version 2 format "<CS64>-<SHA256>").
 *
 * The input is Edge's copyright line + Windows-epoch time (rounded down to 5 minutes, in
 * 100 ns units) + the public TrustedClientToken. SHA-256 is standard; CS64 is a 64-bit
 * checksum keyed by the first two digest words. Written from the public protocol notes
 * (msedge-tts, MIT; edge-tts PR #492), no third-party code is bundled.
 */
import { createHash } from 'crypto';

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const COPYRIGHT_PREFIX = 'Copyright (C) Microsoft Corporation. All rights reserved.';
/** Seconds between 1601-01-01 (Windows file time) and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET = 11644473600;

const rot16 = (x: number): number => ((x << 16) | (x >>> 16)) >>> 0;
const mul = (a: number, b: number): number => Math.imul(a, b) >>> 0;

/** Swap term for one word: (w·k + rot(w)·a) → rot·b → (rot·c + itself). */
function swapTerm(word: number, key: number, a: number, b: number, c: number): number {
  const s = (mul(word, key) + mul(rot16(word), a)) >>> 0;
  const p = mul(rot16(s), b);
  return (mul(rot16(p), c) + p) >>> 0;
}

function mixChain(value: number, factors: readonly number[]): number {
  let v = value >>> 0;
  for (const f of factors) v = mul(rot16(v), f);
  return v;
}

const MIX_A = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83] as const;
const MIX_B = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69] as const;

/** 8-byte CS64 checksum of `msg`, keyed by the SHA-256 digest. */
export function cs64(msg: Uint8Array, digest: Uint8Array): Buffer {
  const d = Buffer.from(digest);
  const k1 = (d.readUInt32LE(0) | 1) >>> 0;
  const k2 = (d.readUInt32LE(4) | 1) >>> 0;
  const buf = Buffer.alloc(Math.ceil(msg.length / 8) * 8);
  buf.set(msg);
  let sumSwap = 0;
  let lastSwap = 0;
  let mix = 0;
  let sumMix = 0;
  for (let i = 0; i < buf.length; i += 8) {
    const w1 = buf.readUInt32LE(i);
    const w2 = buf.readUInt32LE(i + 4);
    const s1 = swapTerm(w1, k1, 0xef0569fb, 0x76f50f34, 0xc3efea97);
    lastSwap = swapTerm(w2, k2, 0xc31713db, 0x1881ce3c, 0x35bd1ec9);
    sumSwap = (sumSwap + s1 + lastSwap) >>> 0;
    mix = mixChain(mul((mix + w1) >>> 0, k1), MIX_A);
    sumMix = (sumMix + mix) >>> 0;
    mix = mixChain(mul((mix + w2) >>> 0, k2), MIX_B);
    sumMix = (sumMix + mix) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  out.writeUInt32LE((sumSwap ^ sumMix) >>> 0, 4);
  return out;
}

/** Token for a given unix time in seconds (already clock-skew corrected). */
export function secMsGec(unixSeconds: number): string {
  let t = Math.floor(unixSeconds) + WINDOWS_EPOCH_OFFSET;
  t -= t % 300;
  const ticks = (BigInt(t) * BigInt(10_000_000)).toString();
  const msg = Buffer.from(`${COPYRIGHT_PREFIX}${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = createHash('sha256').update(msg).digest();
  return `${cs64(msg, digest).toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

/** Process-wide clock skew (seconds) learned from a 403 response's Date header. */
let skewSeconds = 0;

export function nowSeconds(): number {
  return Date.now() / 1000 + skewSeconds;
}

/** Set skew from the server Date header. Returns false when the header is unusable. */
export function adjustSkewFromServerDate(dateHeader: string | undefined): boolean {
  if (!dateHeader) return false;
  const server = Date.parse(dateHeader);
  if (!Number.isFinite(server)) return false;
  skewSeconds = server / 1000 - Date.now() / 1000;
  return true;
}

export function resetSkewForTests(): void {
  skewSeconds = 0;
}
