#!/usr/bin/env node
/**
 * 批次 9 golden parity（语音 / 朗读）：Node 的纯函数 + EdgeTtsClient（假 socket 脚本）+
 * transcribeOpenAICompat（本地 mock HTTP 服务）在固定输入上的输出，
 * 写到 apps/desktop-go/internal/core/voice/testdata/parity-b9.json（或 $NOMI_GOLDEN_DIR）。
 * Go 侧 voice/parity_b9_test.go 回放并比对。
 *
 * 用法：TZ=UTC pnpm exec tsx scripts/parity/record-b9.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.TZ = 'UTC';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/core/voice/testdata');
const out = join(outDir, 'parity-b9.json');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const proto = await imp('packages/core/src/tts/edge/edgeProtocol.ts');
const gec = await imp('packages/core/src/tts/edge/secMsGec.ts');
const { EdgeTtsClient } = await imp('packages/core/src/tts/edge/EdgeTtsClient.ts');
const ttsCfg = await imp('packages/core/src/tts/ttsConfig.ts');
const reply = await imp('packages/core/src/tts/replySpeech.ts');
const router = await imp('packages/core/src/tts/ttsRouter.ts');
const settings = await imp('packages/core/src/voice/settings.ts');
const whisper = await imp('packages/core/src/voice/whisperCpp.ts');
const asr = await imp('packages/core/src/voice/cloudAsr.ts');
const { cleanTextForSpeech } = await imp('packages/types/src/speechText.ts');
const { EdgeTtsService } = await imp('packages/core/src/tts/edge/EdgeTtsService.ts');
const { pcmToWav } = await imp('packages/core/src/voice/VoiceService.ts');

const norm = (s) =>
  s
    .replace(/X-Timestamp:[^\r\n]*/g, 'X-Timestamp:<T>')
    .replace(/X-RequestId:[0-9a-f]+/g, 'X-RequestId:<ID>');

// ---------- edge protocol ----------
const secs = [0, 1, 1700000000, 1700000299.9, 1700000300, 1761700000.5];
const rates = [-80, -50, -10.4, -0.5, 0, 0.5, 10.6, 50, 99, NaN, Infinity];
const texts = ['你好', 'a & b < c > "d" \'e\'', '', '  空格  ', 'x'.repeat(50)];
const dates = [0, 1700000000000, 1761700000123];
const edge = {
  gec: secs.map((s) => ({ in: s, out: gec.secMsGec(s) })),
  synthUrl: secs.slice(0, 3).map((s) => ({ in: s, out: proto.synthesisUrl(s) })),
  voicesUrl: secs.slice(0, 3).map((s) => ({ in: s, out: proto.voicesUrl(s) })),
  socketHeaders: Object.entries(proto.socketHeaders()).map(([k, v]) => [k, k === 'Cookie' ? '<MUID>' : v]),
  httpHeaders: Object.entries(proto.httpHeaders()).map(([k, v]) => [k, k === 'Cookie' ? '<MUID>' : v]),
  configFrame: norm(proto.configFrame()),
  rate: rates.map((r) => ({ in: String(r), out: proto.formatRate(r) })),
  escape: texts.map((t) => ({ in: t, out: proto.escapeXml(t) })),
  ssml: texts.flatMap((t) => [0, 20].map((r) => ({ in: [t, 'zh-CN-XiaoxiaoNeural', r], out: norm(proto.ssmlFrame(t, 'zh-CN-XiaoxiaoNeural', r)) }))),
  dateString: dates.map((ms) => ({ in: ms, out: new Date(ms).toString() })),
  textPath: ['X-RequestId:1\r\nPath:turn.end\r\n\r\n{}', 'Path:audio.metadata', 'nothing', 'A:b\r\nPath: x \r\n\r\nPath:y'].map(
    (f) => ({ in: f, out: proto.textFramePath(f) ?? null }),
  ),
};

// ---------- edge client (scripted fake socket) ----------
const audioFrame = (payload, path = 'audio') => {
  const h = Buffer.from(`X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:${path}\r\n`, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(h.length);
  return Buffer.concat([len, h, Buffer.from(payload, 'utf8')]);
};
const scripts = {
  ok: [{ open: true }, { bin: audioFrame('AAA') }, { bin: audioFrame('BBB') }, { text: 'Path:turn.end\r\n\r\n' }],
  skipNonAudio: [{ open: true }, { bin: audioFrame('meta', 'audio.metadata') }, { bin: Buffer.from([0]) }, { bin: audioFrame('Z') }, { text: 'Path:turn.end\r\n\r\n' }],
  noAudio: [{ open: true }, { text: 'Path:turn.end\r\n\r\n' }],
  closeNoAudio: [{ open: true }, { close: 1006 }],
  closeAfterAudio: [{ open: true }, { bin: audioFrame('Q') }, { close: 1000 }],
  http500: [{ status: 500 }],
  forbiddenNoDate: [{ status: 403 }],
  offline: [{ error: 'getaddrinfo ENOTFOUND speech.platform.bing.com', code: 'ENOTFOUND' }],
  otherError: [{ error: 'boom', code: 'EPROTO' }],
};
const toWire = (step) =>
  step.bin ? { bin: step.bin.toString('base64') } : step;
const runScript = async (steps, voice = 'zh-CN-XiaoxiaoNeural') => {
  const sent = [];
  const factory = () => {
    const h = {};
    const sock = {
      on(ev, cb) { h[ev] = cb; return sock; },
      send(d) { sent.push(norm(d)); },
      terminate() {},
    };
    setTimeout(async () => {
      for (const s of steps) {
        await new Promise((r) => setTimeout(r, 1));
        if (s.open) h.open?.();
        else if (s.bin) h.message?.(s.bin, true);
        else if (s.text) h.message?.(Buffer.from(s.text), false);
        else if (s.close) h.close?.(s.close);
        else if (s.status) h['unexpected-response']?.({}, { statusCode: s.status, headers: {} });
        else if (s.error) h.error?.(Object.assign(new Error(s.error), { code: s.code }));
      }
    }, 0);
    return sock;
  };
  const c = new EdgeTtsClient({ createSocket: factory });
  try {
    const buf = await c.synthesize('你好', { voice, rate: 10, timeoutMs: 2000 });
    return { ok: buf.toString('base64'), sent };
  } catch (e) {
    return { kind: e.kind, message: e.message, sent };
  }
};
const edgeClient = [];
for (const [name, steps] of Object.entries(scripts))
  edgeClient.push({ name, steps: steps.map(toWire), out: await runScript(steps) });
edgeClient.push({ name: 'badVoice', steps: [], voice: 'bad voice', out: await runScript([], 'bad voice') });

// ---------- tts config / reply / router ----------
const cfgIn = [
  null, 'x', {}, { provider: 'edge' }, { provider: 'volc', enabled: true },
  { provider: 'azure', enabled: true, azure: { key: 'k', region: 'eastasia', voice: 'v' } },
  { provider: 'openai', enabled: 1, speed: 9, voice: 3 },
  { enabled: true, readReplies: true, provider: 'edge', edge: { voice: 'zh-CN-YunxiNeural', rate: 99 } },
];
const tts = {
  normalize: cfgIn.map((v) => ({ in: v, out: ttsCfg.normalizeTtsConfig(v) })),
  validate: cfgIn.map((v) => ({ in: v, out: ttsCfg.validateTtsConfig(v) })),
  reply: [
    [{ op: 'stop' }, null], [{ op: 'stop', id: 'a' }, null], [{ op: 'say', id: 'a', text: 'hi' }, cfgIn[7]],
    [{ op: 'say', id: 'a', text: '  ' }, cfgIn[7]], [{ op: 'end', id: 'a' }, cfgIn[7]], [{ op: 'end', id: 'a' }, cfgIn[3]],
    [{ op: 'say', id: 'x'.repeat(100), text: 'y'.repeat(700) }, cfgIn[7]], [null, cfgIn[7]],
  ].flatMap(([m, c]) => [{}, { CD_TTS: 'off' }].map((env) => ({ in: [m, c, env], out: reply.replySpeechCommand(m, c, env) }))),
  envOverride: [{}, { CD_TTS: 'off' }, { CD_TTS: 'on' }].flatMap((env) =>
    [true, false].map((enabled) => ({ in: [enabled, env], out: router.applyTtsEnvOverride({ enabled }, env) })),
  ),
};

// ---------- voice settings / whisper / wav ----------
const vIn = [
  null, 7, {}, { engine: 'cloud', cloud: { baseURL: ' https://api.openai.com/v1/ ', model: 'whisper-1' } },
  { engine: 'nope', wakeWord: true, wakePhrase: '  你好小诺你好小诺你好小诺你好小诺你好小诺你好小诺  ' },
  { pttKey: 'x'.repeat(400), vadThreshold: 9, silenceMs: -1, language: 'en', autoSend: 'yes' },
  { engine: 'volc', volc: { appId: 'a', resource: 'bogus' }, cloudAcked: ['x', 3] },
];
const voice = {
  defaults: settings.DEFAULT_VOICE_SETTINGS,
  sanitize: vIn.map((v) => ({ in: v, out: settings.sanitizeVoiceSettings(v) })),
  cloudTarget: vIn.map((v) => ({ in: v, out: settings.cloudTargetId(settings.sanitizeVoiceSettings(v)) })),
  cliNames: whisper.CLI_NAMES,
  args: [
    { model: 'm.bin', wav: 'a.wav', language: '', threads: 3 },
    { model: 'm.bin', wav: 'a.wav', language: 'zh', prompt: '以下是普通话', threads: 1 },
  ].map((o) => ({ in: o, out: whisper.buildArgs(o) })),
  clean: ['', '[BLANK_AUDIO]', ' 你好 (音乐) 世界 ', '[00:00.000 --> 00:01.000] hi\n  there', '（笑）好的 [Music]', '*咳嗽* ok'].map(
    (s) => ({ in: s, out: whisper.cleanTranscript(s) }),
  ),
  wav: [[], [1, 2], [0, 255, 1, 128]].map((b) => ({ in: b, out: Buffer.from(pcmToWav(new Uint8Array(b))).toString('base64') })),
  transcriptionsURL: ['https://a/v1', 'https://a/v1///', 'http://127.0.0.1:8080'].map((u) => ({ in: u, out: asr.transcriptionsURL(u) })),
};

// ---------- cloud ASR against a mock HTTP server ----------
const responses = [
  { status: 200, body: '{"text":"  你好  "}' },
  { status: 200, body: '{"text":5}' },
  { status: 200, body: '{}' },
  { status: 200, body: ' plain text \n' },
  { status: 200, body: '[1]' },
  { status: 401, body: 'x'.repeat(300) },
  { status: 500, body: '{"error":"bad"}' },
];
const reqs = [
  { apiKey: 'sk-1', model: 'whisper-1', language: 'zh', prompt: '提示' },
  { model: 'm', language: 'auto' },
  { apiKey: '', model: 'm', language: '' },
  { apiKey: 'k', model: 'a\rb', language: 'en', prompt: 'x\r\ny\nz\r' },
];
const seen = [];
let next = null;
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const fields = [...body.matchAll(/name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: ([^\r\n]+)\r\n)?\r\n([^\r]*)/g)].map(
      (m) => [m[1], m[2] ?? null, m[3] ?? null, m[2] ? null : Buffer.from(m[4], 'latin1').toString('utf8')],
    );
    // D-B9-6：undici 的 boundary 形状、默认请求头（名字小写、按名排序比较；connection 属传输层不比）与 body 原字节
    const boundary = /boundary=(.*)$/.exec(req.headers['content-type'] ?? '')?.[1] ?? '';
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      if (k === 'connection') continue;
      let v = req.rawHeaders[i + 1];
      if (k === 'host') v = 'HOST';
      headers.push([k, boundary ? v.split(boundary).join('BOUNDARY') : v]);
    }
    headers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const rawBody = boundary ? body.split(boundary).join('BOUNDARY') : body;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, multipart: /^multipart\/form-data; boundary=/.test(req.headers['content-type'] ?? ''), fields, boundary: /^----formdata-undici-0\d{11}$/.test(boundary), headers, body: rawBody });
    res.writeHead(next.status, { 'content-type': 'text/plain' });
    res.end(next.body);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1/`;
const cloud = [];
for (const r of responses)
  for (const q of reqs) {
    next = r;
    seen.length = 0;
    let result;
    try {
      result = { text: await asr.transcribeOpenAICompat({ baseURL: base, wav: new Uint8Array([1, 2, 3]), ...q }) };
    } catch (e) {
      result = { error: e.message };
    }
    cloud.push({ resp: r, req: q, out: result, seen: seen[0] });
  }
server.close();

// ---------- speech text + EdgeTtsService.speak (fake client) ----------
const speechIn = [
  '', '你好！', '**粗体** 和 `代码` [链接](https://x.y/z) ![img](a.png)', '```js\nconst a=1\n```\n然后', '# 标题\n- 列表 1\n- 列表 2',
  '😀🎉 emoji only', '...', 'https://example.com/path?q=1 看这里', '<b>html</b> &amp; text', '1. 第一\n2. 第二\n\n\n段落', 'a'.repeat(700),
  '表格 | a | b |\n|---|---|', '> 引用\n正文', 'mixed English 和中文, 123.',
];
const speech = speechIn.map((t) => ({ in: t, out: cleanTextForSpeech(t) }));
const speak = [];
for (const [text, v, rate] of [['你好', undefined, undefined], ['你好', 'bad', 30], ['...', 'zh-CN-YunxiNeural', 0], ['x'.repeat(700), 'zh-CN-YunxiNeural', NaN], ['**hi**', 'zh-CN-YunxiNeural', -20]]) {
  const calls = [];
  const svc = new EdgeTtsService({ synthesize: async (t, o) => { calls.push({ text: t, voice: o.voice, rate: o.rate }); return Buffer.from('mp3'); } }, () => 42);
  const r = await svc.speak({ text, voice: v, rate });
  speak.push({ in: { text, voice: v ?? null, rate: rate === undefined ? null : String(rate) }, out: { ok: r.ok, kind: r.kind ?? null, message: r.message ?? null, calls } });
}

// ---------- D-B9-7：whisper-cli 无 stderr 时的 execFile err.message ----------
const { execFile } = await import('node:child_process');
const execCases = [
  { name: 'exit', file: '/bin/sh', args: ['-c', 'exit 3'] },
  { name: 'enoent', file: '/nonexistent/whisper-cli', args: ['-m', 'model.bin', '-f', 'in.wav'] },
  { name: 'timeout', file: '/bin/sh', args: ['-c', 'sleep 5'], timeout: 200 },
  { name: 'abort', file: '/bin/sh', args: ['-c', 'sleep 5'], abort: 100 },
];
const exec = [];
if (process.platform !== 'win32')
  for (const c of execCases) {
    const ac = new AbortController();
    if (c.abort) setTimeout(() => ac.abort(), c.abort);
    const msg = await new Promise((r) =>
      execFile(c.file, c.args, { timeout: c.timeout ?? 0, signal: ac.signal, maxBuffer: 8 << 20 }, (err, _o, stderr) => r(stderr || (err ? err.message : null))),
    );
    exec.push({ ...c, out: msg });
  }

mkdirSync(outDir, { recursive: true });
// D-B9-4：V8 Date#toString（X-Timestamp）在各 TZ 下的写法（括号内 ICU 时区长名）
const { execFileSync } = await import('node:child_process');
const jsDateZones = ['UTC', 'Etc/UTC', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Tokyo', 'America/New_York', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Berlin', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Chatham', 'Asia/Kathmandu', 'America/St_Johns',
  'Asia/Dubai', 'Pacific/Apia', 'America/Caracas'];
const jsDateInstants = [0, 1767225600000, 1784505600000, 662688000000, 1793260800123];
const jsDate = jsDateZones.map((tz) => ({
  tz,
  out: JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${JSON.stringify(jsDateInstants)}.map((t)=>new Date(t).toString())))`], { env: { ...process.env, TZ: tz } }).toString()),
}));
// D-B9-3：ConfigService 读 config.json（与默认深合并）→ saveMascotVoiceSettings → 落盘的 voiceSettings（未知键 / 键序）
const { ConfigService } = await imp('packages/core/src/services/ConfigService.ts');
const mascotVS = await imp('packages/core/src/voice/mascotVoiceSettings.ts');
const { mkdtempSync, readFileSync: rfs, writeFileSync: wfs } = await import('node:fs');
const { tmpdir } = await import('node:os');
const mascotCases = [
  { file: { voiceSettings: { custom: { a: 1 }, volume: 0.5, extra: [1, 2], voiceMode: 'random' } }, patch: { volume: 0.25, late: 'x' } },
  { file: { voiceSettings: { sfxEnabled: false, nested: { k: 'v' } } }, patch: { nested: { z: 1 }, enabled: true } },
  { file: {}, patch: { timeAnnouncement: false, newKey: null } },
];
const mascot = [];
for (const c of mascotCases) {
  const dir = mkdtempSync(join(tmpdir(), 'b9cfg-'));
  wfs(join(dir, 'config.json'), JSON.stringify(c.file));
  const cfg = new ConfigService({ ports: { paths: { userData: () => dir } } });
  await cfg.load();
  const got = mascotVS.getMascotVoiceSettings(cfg);
  let published = null;
  mascotVS.saveMascotVoiceSettings(cfg, c.patch, { info() {}, error() {} }, { publish: (_n, p) => { published = p; } });
  await cfg.save();
  const saved = JSON.parse(rfs(join(dir, 'config.json'), 'utf8')).voiceSettings;
  mascot.push({ ...c, got: JSON.stringify(got), published: JSON.stringify(published), saved: JSON.stringify(saved) });
}
// D-B9-1 / D-B9-5：VolcAsrSession 对着本地 ws 模拟服务（http 'upgrade'，不协商扩展）：
// 记录握手 rawHeaders（顺序 / 值；随机值替换为占位）、客户端帧（头 4 字节 + 解压后的负载）、会话结果
const volcMod = await imp('packages/core/src/voice/volcAsr.ts');
const { createHash } = await import('node:crypto');
const { gunzipSync, gzipSync } = await import('node:zlib');
const srvResult = (seq, flags, json) => {
  const g = gzipSync(Buffer.from(JSON.stringify(json)));
  const b = Buffer.alloc(12 + g.length);
  b[0] = 0x11; b[1] = (0b1001 << 4) | flags; b[2] = 0x11; b[3] = 0;
  b.writeInt32BE(seq, 4); b.writeUInt32BE(g.length, 8); g.copy(b, 12);
  return b;
};
const volcScript = [
  { on: 'full', frame: srvResult(1, 1, { result: { text: '' } }).toString('hex') },
  { on: 'audio', frame: srvResult(2, 1, { result: { text: '你好' } }).toString('hex') },
  { on: 'audio', frame: srvResult(3, 1, { result: { text: '你好' } }).toString('hex') },
  { on: 'audio', frame: srvResult(4, 1, { result: [{ text: '你好呀' }] }).toString('hex') },
  { on: 'last', frame: srvResult(-5, 3, { result: { text: '你好呀，世界', utterances: [] } }).toString('hex') },
];
const wsFrame = (op, payload) => {
  const n = payload.length;
  const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : null;
  return Buffer.concat([h, payload]);
};
const volc = await new Promise((resolveAll) => {
  const rec = { rawHeaders: null, url: null, frames: [] };
  const srv = createServer();
  srv.on('upgrade', (req, sock) => {
    rec.url = req.url;
    rec.rawHeaders = req.rawHeaders.slice();
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Tt-Logid: LOG-B9\r\n\r\n`);
    let buf = Buffer.alloc(0);
    let sentAudio = false;
    const send = (on) => { for (const s of volcScript) if (s.on === on) sock.write(wsFrame(2, Buffer.from(s.frame, 'hex'))); };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0xf;
        let len = buf[1] & 0x7f, o = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
        if (buf.length < o + 4 + len) return;
        const mask = buf.subarray(o, o + 4);
        const p = Buffer.from(buf.subarray(o + 4, o + 4 + len));
        for (let i = 0; i < p.length; i++) p[i] ^= mask[i % 4];
        buf = buf.subarray(o + 4 + len);
        if (op === 8) { sock.end(wsFrame(8, p)); return; }
        if (op !== 2) continue;
        const type = p[1] >> 4, last = (p[1] & 0xf & 2) !== 0;
        const payload = gunzipSync(p.subarray(8));
        rec.frames.push({ head: p.subarray(0, 4).toString('hex'), payload: type === 1 ? payload.toString('utf8') : payload.toString('hex') });
        if (type === 1) send('full');
        else if (last) send('last');
        else if (!sentAudio) { sentAudio = true; send('audio'); }
      }
    });
    sock.on('error', () => {});
  });
  srv.listen(0, '127.0.0.1', async () => {
    const port = srv.address().port;
    const partials = [];
    const s = new volcMod.VolcAsrSession({ apiKey: 'k-secret', resourceId: 'volc.seedasr.sauc.duration',
      url: `ws://127.0.0.1:${port}/api/v3/sauc/bigmodel_async`, retries: 0, onPartial: (t) => partials.push(t) });
    await s.start();
    const pcm = Buffer.alloc(16000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
    s.push(pcm.subarray(0, 7000));
    await new Promise((r) => setTimeout(r, 150));
    s.push(pcm.subarray(7000));
    const text = await s.finish();
    const ids = { [s.requestId]: 'REQUEST_ID' };
    const rh = rec.rawHeaders.map((v, i) => {
      const k = rec.rawHeaders[i - 1]?.toLowerCase();
      if (i % 2 === 0) return v;
      if (k === 'sec-websocket-key') return 'KEY';
      if (k === 'host') return 'HOST';
      if (k === 'x-api-connect-id') return /^[0-9a-f-]{36}$/.test(v) ? 'UUID' : v;
      return ids[v] ?? v;
    });
    srv.close();
    resolveAll({ url: rec.url, rawHeaders: rh, frames: rec.frames, script: volcScript, partials, text, logId: s.serverLogId ?? null,
      pcm: pcm.toString('hex') });
  });
});
writeFileSync(out, JSON.stringify({ edge, edgeClient, tts, voice, cloud, speech, speak, exec, jsDate, jsDateInstants, mascot, volc }, null, 2) + '\n');
console.log(`wrote ${out}`);
