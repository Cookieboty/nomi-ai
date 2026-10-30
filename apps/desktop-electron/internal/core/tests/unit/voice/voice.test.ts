jest.unmock('fs');
jest.unmock('path');

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { strToU8, zipSync, gzipSync } from 'fflate';

import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { VOICE_ASSETS, assetsFor, findAsset } from '../../../src/voice/catalog';
import { downloadVerified, extractTarGz, extractZip, safeJoin } from '../../../src/voice/download';
import {
  DEFAULT_VOICE_SETTINGS,
  cloudTargetId,
  sanitizeVoiceSettings,
} from '../../../src/voice/settings';
import { toFloat32 } from '../../../src/voice/sileroNode';
import { VoiceService } from '../../../src/voice/VoiceService';
import { buildArgs, cleanTranscript } from '../../../src/voice/whisperCpp';
import { fakeSecrets } from '../helpers/featureHost';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-voice-'));

function tarEntry(name: string, data: Uint8Array, type = '0', link = ''): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number) => h.set(strToU8(s), off);
  put(name, 0);
  put('0000755\0', 100);
  put(data.length.toString(8).padStart(11, '0') + '\0', 124);
  put('        ', 148);
  put(type, 156);
  put(link, 157);
  put('ustar\0', 257);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body.set(data);
  const out = new Uint8Array(512 + body.length);
  out.set(h);
  out.set(body, 512);
  return out;
}

describe('voice catalog', () => {
  it('every asset is permissive, pinned and checksummed', () => {
    for (const a of VOICE_ASSETS) {
      expect(a.license).toMatch(/^(MIT|Apache-2\.0|BSD|CC0)/);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.url).toMatch(/^https:\/\//);
    }
    expect(findAsset('ggml-base')).toBeTruthy();
    expect(assetsFor('linux-x64').some((a) => a.id === 'whisper-bin-linux-x64')).toBe(true);
    expect(assetsFor('darwin-arm64').some((a) => a.id.startsWith('whisper-bin'))).toBe(false);
  });
});

describe('voice settings', () => {
  it('wake word is data matched against speech, never a translation key', () => {
    // 唤醒功能早于多语言：唤醒词与识别结果比对，不随界面语言翻译，也不能被替换成 key。
    // 默认为空 = 跟着当前角色走（角色包的 wakePhrase），不写死官方角色名（§10.1）
    expect(DEFAULT_VOICE_SETTINGS.wakeWord.phrase).toBe('');
    expect(sanitizeVoiceSettings({}).wakeWord.phrase).toBe('');
    expect(sanitizeVoiceSettings({ wakeWord: { phrase: 'Hey Pip' } }).wakeWord.phrase).toBe(
      'Hey Pip',
    );
  });

  it('wake word: the active character supplies the default; a saved phrase wins', () => {
    const root = tmp();
    let packPhrase: string | undefined = '你好，小纸';
    const v = new VoiceService({
      root,
      secrets: fakeSecrets(),
      logger: { info() {}, warn() {}, error() {} },
      events: createRecordingAppEvents(),
      defaultWakePhrase: () => packPhrase,
    });
    expect(v.getSettings().wakeWord.phrase).toBe('你好，小纸');
    expect(v.state().settings.wakeWord.phrase).toBe('你好，小纸');
    // 换了角色包：跟着变（默认值不写回磁盘）
    packPhrase = 'Hi, Pip';
    v.setSettings({ autoSend: false });
    expect(v.getSettings().wakeWord.phrase).toBe('Hi, Pip');
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).wakeWord.phrase,
    ).toBe('');
    // 用户自己设的唤醒词优先
    v.setSettings({ wakeWord: { enabled: true, phrase: '嘿，助手', windowSec: 8 } });
    expect(v.getSettings().wakeWord.phrase).toBe('嘿，助手');
    packPhrase = undefined;
    v.setSettings({ wakeWord: { enabled: true, phrase: '', windowSec: 8 } });
    expect(v.getSettings().wakeWord.phrase).toBe('');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults: local engine, wake word off', () => {
    const s = sanitizeVoiceSettings(null);
    expect(s.engine).toBe('whisper-cpp');
    expect(s.wakeWord.enabled).toBe(false);
  });
  it('clamps and rejects bad values', () => {
    const s = sanitizeVoiceSettings({
      engine: 'x',
      vadThreshold: 5,
      customBaseURL: 'file:///etc',
      language: '../',
      wakeWord: { phrase: '', windowSec: 999 },
    });
    expect(s.engine).toBe(DEFAULT_VOICE_SETTINGS.engine);
    expect(s.vadThreshold).toBe(0.9);
    expect(s.customBaseURL).toBe('');
    expect(s.language).toBe(DEFAULT_VOICE_SETTINGS.language);
    expect(s.wakeWord.phrase).toBe('');
    expect(s.wakeWord.windowSec).toBe(30);
  });
  it('cloud target id', () => {
    expect(
      cloudTargetId({ ...DEFAULT_VOICE_SETTINGS, customBaseURL: 'https://a.example/v1' }),
    ).toBe('url:https://a.example');
  });
});

describe('whisper cli', () => {
  it('builds args without shell interpolation', () => {
    const a = buildArgs({ model: '/m b.bin', wav: '/t.wav', language: 'zh', prompt: '你好' });
    expect(a).toContain('/m b.bin');
    expect(a).toEqual(expect.arrayContaining(['-l', 'zh', '-nt']));
  });
  it('strips non-speech markers', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]  你好 \n 世界 ')).toBe('你好 世界');
    expect(cleanTranscript('(laughs)')).toBe('');
    expect(cleanTranscript('（笑声） 好的')).toBe('好的');
  });
});

describe('archive extraction', () => {
  it('safeJoin blocks traversal', () => {
    const root = path.resolve(os.tmpdir(), 'r');
    expect(safeJoin(root, '../x')).toBeNull();
    expect(safeJoin(root, '/etc/passwd')).toBeNull();
    expect(safeJoin(root, 'C:\\Windows')).toBeNull();
    expect(safeJoin(root, 'a/b')).toBe(path.join(root, 'a', 'b'));
  });
  it('zip extracts and refuses zip-slip', () => {
    const d = tmp();
    extractZip(zipSync({ 'bin/whisper-cli.exe': strToU8('x'), '../evil': strToU8('y') }), d);
    expect(fs.existsSync(path.join(d, 'bin/whisper-cli.exe'))).toBe(true);
    expect(fs.existsSync(path.join(d, '..', 'evil'))).toBe(false);
  });
  it('tar.gz strips top dir and resolves symlinks by copy', () => {
    const d = tmp();
    const tar = new Uint8Array([
      ...tarEntry('top/libwhisper.so.1', strToU8('lib')),
      ...tarEntry('top/libwhisper.so', new Uint8Array(), '2', 'libwhisper.so.1'),
      ...tarEntry('top/whisper-cli', strToU8('bin')),
      ...new Uint8Array(1024),
    ]);
    extractTarGz(gzipSync(tar), d);
    expect(fs.readFileSync(path.join(d, 'whisper-cli'), 'utf8')).toBe('bin');
    expect(fs.readFileSync(path.join(d, 'libwhisper.so'), 'utf8')).toBe('lib');
  });
});

describe('downloadVerified', () => {
  const body = strToU8('hello model');
  const sha = createHash('sha256').update(body).digest('hex');
  const fakeFetch = async () =>
    new Response(body, { headers: { 'content-length': String(body.length) } });
  it('writes the file when sha256 matches and reports progress', async () => {
    const dest = path.join(tmp(), 'm.bin');
    const seen: number[] = [];
    await downloadVerified({
      url: 'https://x',
      sha256: sha,
      dest,
      fetchImpl: fakeFetch as never,
      onProgress: (p) => seen.push(p.received),
    });
    expect(fs.readFileSync(dest, 'utf8')).toBe('hello model');
    expect(seen.at(-1)).toBe(body.length);
  });
  it('rejects a checksum mismatch and leaves nothing behind', async () => {
    const dir = tmp();
    const dest = path.join(dir, 'm.bin');
    await expect(
      downloadVerified({
        url: 'https://x',
        sha256: '0'.repeat(64),
        dest,
        fetchImpl: fakeFetch as never,
      }),
    ).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
  it('fails on HTTP errors', async () => {
    const f = async () => new Response('no', { status: 404 });
    await expect(
      downloadVerified({
        url: 'https://x',
        sha256: sha,
        dest: path.join(tmp(), 'a'),
        fetchImpl: f as never,
      }),
    ).rejects.toThrow(/404/);
  });
});

// Silero 推理需要 ESM 动态 import（jest vm 不支持）：由 scripts/smoke-silero.cjs 在真实 Node 下验证

describe('toFloat32 (IPC frames)', () => {
  it('accepts every shape structured clone may produce', () => {
    const f = new Float32Array([0.5, -0.25]);
    expect(Array.from(toFloat32(f)!)).toEqual([0.5, -0.25]);
    expect(Array.from(toFloat32(Buffer.from(f.buffer))!)).toEqual([0.5, -0.25]);
    expect(Array.from(toFloat32(f.buffer)!)).toEqual([0.5, -0.25]);
    expect(Array.from(toFloat32([0.5])!)).toEqual([0.5]);
    expect(toFloat32('x')).toBeNull();
  });
});
