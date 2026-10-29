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
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, multipart: /^multipart\/form-data; boundary=/.test(req.headers['content-type'] ?? ''), fields });
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

mkdirSync(outDir, { recursive: true });
writeFileSync(out, JSON.stringify({ edge, edgeClient, tts, voice, cloud, speech, speak }, null, 2) + '\n');
console.log(`wrote ${out}`);
