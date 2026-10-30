/**
 * Edge read-aloud wire format (pure helpers, no I/O).
 * Text frames: "Header:value\r\n...\r\n\r\nbody". Binary frames: 2-byte big-endian header
 * length, header text, then audio bytes (Path:audio).
 */
import { randomBytes, randomUUID } from 'crypto';

import { TRUSTED_CLIENT_TOKEN, secMsGec } from './secMsGec';

/** Chromium version the token is tied to; bump when Microsoft starts rejecting it. */
export const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud';
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`;

const hexId = (): string => randomUUID().replace(/-/g, '');
const muidCookie = (): string => `muid=${randomBytes(16).toString('hex').toUpperCase()};`;

export function synthesisUrl(unixSeconds: number): string {
  return (
    `wss://${BASE}/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${hexId()}&Sec-MS-GEC=${secMsGec(unixSeconds)}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  );
}

export function voicesUrl(unixSeconds: number): string {
  return (
    `https://${BASE}/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec(unixSeconds)}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  );
}

export function socketHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: muidCookie(),
  };
}

export function httpHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: '*/*',
    'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${MAJOR}", "Chromium";v="${MAJOR}"`,
    'Sec-CH-UA-Mobile': '?0',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Cookie: muidCookie(),
  };
}

/** JavaScript-style date string the service expects in X-Timestamp. */
const stamp = (): string => new Date().toString();

export function configFrame(): string {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  });
  return (
    `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n${body}`
  );
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Voice names are interpolated into SSML: only allow the documented shape. */
export const VOICE_NAME_RE = /^[a-z]{2,3}-[A-Za-z0-9-]+Neural$/;

export function formatRate(percent: number): string {
  const r = Math.round(Math.max(-50, Math.min(50, Number.isFinite(percent) ? percent : 0)));
  return `${r >= 0 ? '+' : ''}${r}%`;
}

export function ssmlFrame(text: string, voice: string, ratePercent: number): string {
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${escapeXml(voice)}'><prosody pitch='+0Hz' rate='${formatRate(ratePercent)}' volume='+0%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`;
  return (
    `X-RequestId:${hexId()}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`
  );
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** Path header of a text frame (e.g. turn.start, audio.metadata, turn.end). */
export function textFramePath(frame: string): string | undefined {
  const end = frame.indexOf('\r\n\r\n');
  return parseHeaders(end >= 0 ? frame.slice(0, end) : frame).Path;
}

/** Audio payload of a binary frame, or null when it is not an audio frame. */
export function binaryFrameAudio(frame: Buffer): Buffer | null {
  if (frame.length < 2) return null;
  const headerLen = frame.readUInt16BE(0);
  if (headerLen + 2 > frame.length) return null;
  const headers = parseHeaders(frame.subarray(2, 2 + headerLen).toString('utf8'));
  if (headers.Path !== 'audio') return null;
  return frame.subarray(2 + headerLen);
}
