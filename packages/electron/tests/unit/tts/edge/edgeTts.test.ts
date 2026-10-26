import { EventEmitter } from 'events';

import { cleanTextForSpeech, splitSpeechSegments } from '@nomi-ai/types';

import {
  binaryFrameAudio,
  formatRate,
  ssmlFrame,
  synthesisUrl,
  textFramePath,
} from '../../../../src/tts/edge/edgeProtocol';
import {
  EdgeTtsClient,
  EdgeTtsError,
  type EdgeSocket,
} from '../../../../src/tts/edge/EdgeTtsClient';
import { EdgeTtsService } from '../../../../src/tts/edge/EdgeTtsService';
import {
  BUILTIN_ZH_VOICES,
  clearVoiceCacheForTests,
  listChineseVoices,
} from '../../../../src/tts/edge/edgeVoices';
import {
  adjustSkewFromServerDate,
  resetSkewForTests,
  secMsGec,
} from '../../../../src/tts/edge/secMsGec';

/** 模拟 ws：open 后收到两条文本帧，按脚本回音频帧 / turn.end */
class FakeSocket extends EventEmitter implements EdgeSocket {
  sent: string[] = [];
  terminated = false;
  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {
    super();
  }
  send(d: string): void {
    this.sent.push(d);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function audioFrame(bytes: string): Buffer {
  const head = Buffer.from('X-RequestId:1\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(head.length);
  return Buffer.concat([len, head, Buffer.from(bytes)]);
}
const text = (path: string) => Buffer.from(`X-RequestId:1\r\nPath:${path}\r\n\r\n{}`);

function scripted(script: (s: FakeSocket, attempt: number) => void) {
  const sockets: FakeSocket[] = [];
  const createSocket = (url: string, headers: Record<string, string>) => {
    const s = new FakeSocket(url, headers);
    sockets.push(s);
    const n = sockets.length;
    setImmediate(() => script(s, n));
    return s;
  };
  return { sockets, client: new EdgeTtsClient({ createSocket }) };
}

const happy = (s: FakeSocket) => {
  s.emit('open');
  s.emit('message', text('turn.start'), false);
  s.emit('message', audioFrame('ID3'), true);
  s.emit('message', audioFrame('MP3'), true);
  s.emit('message', text('turn.end'), false);
};

afterEach(() => resetSkewForTests());

describe('secMsGec（自写 v2 令牌，对照 Python edge-tts 参考值）', () => {
  it('matches reference values', () => {
    expect(secMsGec(1700000000)).toBe(
      '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2',
    );
    expect(secMsGec(1800000123.5)).toBe(
      '99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654',
    );
  });
  it('same 5-minute window gives the same token', () => {
    expect(secMsGec(1700000000)).toBe(secMsGec(1700000001));
  });
  it('bad Date header does not set skew', () => {
    expect(adjustSkewFromServerDate('nonsense')).toBe(false);
    expect(adjustSkewFromServerDate(undefined)).toBe(false);
    expect(adjustSkewFromServerDate(new Date().toUTCString())).toBe(true);
  });
});

describe('edgeProtocol', () => {
  it('SSML escapes text and formats rate', () => {
    const f = ssmlFrame(`a<b>&'"`, 'zh-CN-XiaoyiNeural', -5);
    expect(f).toContain('Path:ssml');
    expect(f).toContain("rate='-5%'");
    expect(f).toContain('a&lt;b&gt;&amp;&apos;&quot;');
    expect(formatRate(7)).toBe('+7%');
    expect(formatRate(-90)).toBe('-50%');
  });
  it('parses frames', () => {
    expect(binaryFrameAudio(audioFrame('xyz'))!.toString()).toBe('xyz');
    expect(binaryFrameAudio(Buffer.from([0, 1]))).toBeNull();
    expect(textFramePath(text('turn.end').toString())).toBe('turn.end');
  });
  it('url carries token and version', () => {
    expect(synthesisUrl(1700000000)).toMatch(
      /^wss:\/\/speech\.platform\.bing\.com\/.*Sec-MS-GEC=2CD23A2CA0B2595A-.*Sec-MS-GEC-Version=2-/,
    );
  });
});

describe('EdgeTtsClient（mock WebSocket）', () => {
  it('collects audio frames until turn.end', async () => {
    const { client, sockets } = scripted(happy);
    const mp3 = await client.synthesize('你好', { voice: 'zh-CN-XiaoyiNeural', rate: -5 });
    expect(mp3.toString()).toBe('ID3MP3');
    expect(sockets[0]!.sent[0]).toContain('Path:speech.config');
    expect(sockets[0]!.sent[1]).toContain("<voice name='zh-CN-XiaoyiNeural'>");
    expect(sockets[0]!.headers.Origin).toMatch(/^chrome-extension:/);
    expect(sockets[0]!.terminated).toBe(true);
  });

  it('403 with Date header: adjusts clock and retries once', async () => {
    const { client, sockets } = scripted((s, n) => {
      if (n === 1)
        s.emit(
          'unexpected-response',
          {},
          {
            statusCode: 403,
            headers: { date: new Date(Date.now() + 3600_000).toUTCString() },
          },
        );
      else happy(s);
    });
    await expect(client.synthesize('x', { voice: 'zh-CN-XiaoyiNeural', rate: 0 })).resolves.toEqual(
      Buffer.from('ID3MP3'),
    );
    expect(sockets).toHaveLength(2);
  });

  it('403 twice: forbidden', async () => {
    const { client, sockets } = scripted((s) =>
      s.emit(
        'unexpected-response',
        {},
        { statusCode: 403, headers: { date: new Date().toUTCString() } },
      ),
    );
    await expect(
      client.synthesize('x', { voice: 'zh-CN-XiaoyiNeural', rate: 0 }),
    ).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(sockets).toHaveLength(2);
  });

  it('offline / timeout / abort / no audio', async () => {
    const offline = scripted((s) =>
      s.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
    );
    await expect(
      offline.client.synthesize('x', { voice: 'zh-CN-XiaoyiNeural', rate: 0 }),
    ).rejects.toMatchObject({ kind: 'offline' });

    const hang = scripted((s) => s.emit('open'));
    await expect(
      hang.client.synthesize('x', { voice: 'zh-CN-XiaoyiNeural', rate: 0, timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(hang.sockets[0]!.terminated).toBe(true);

    const ac = new AbortController();
    const p = hang.client.synthesize('x', {
      voice: 'zh-CN-XiaoyiNeural',
      rate: 0,
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });

    const empty = scripted((s) => {
      s.emit('open');
      s.emit('message', text('turn.end'), false);
    });
    await expect(
      empty.client.synthesize('x', { voice: 'zh-CN-XiaoyiNeural', rate: 0 }),
    ).rejects.toBeInstanceOf(EdgeTtsError);
  });

  it('rejects voice names that are not voice short names', async () => {
    const { client, sockets } = scripted(happy);
    await expect(client.synthesize('x', { voice: "a'/>", rate: 0 })).rejects.toMatchObject({
      kind: 'protocol',
    });
    expect(sockets).toHaveLength(0);
  });
});

describe('EdgeTtsService', () => {
  it('cleans markdown, counts consecutive failures, resets on success, ignores aborts', async () => {
    const synthesize = jest
      .fn()
      .mockRejectedValueOnce(new EdgeTtsError('offline', 'x'))
      .mockRejectedValueOnce(new EdgeTtsError('timeout', 'x'))
      .mockRejectedValueOnce(new EdgeTtsError('aborted', 'x'))
      .mockResolvedValue(Buffer.from('a'));
    const svc = new EdgeTtsService({ synthesize });
    expect((await svc.speak({ text: '**你好** `code`' })).ok).toBe(false);
    expect((await svc.speak({ text: '你好' })).ok).toBe(false);
    expect((await svc.speak({ text: '你好' })).ok).toBe(false);
    expect(svc.getStatus().consecutiveFailures).toBe(2);
    expect(synthesize.mock.calls[0][0]).toBe('你好');
    expect(synthesize.mock.calls[0][1]).toMatchObject({ voice: 'zh-CN-XiaoyiNeural', rate: -5 });
    expect((await svc.speak({ text: '你好', voice: 'zh-CN-YunxiNeural', rate: 10 })).ok).toBe(true);
    expect(synthesize.mock.calls[3][1]).toMatchObject({ voice: 'zh-CN-YunxiNeural', rate: 10 });
    expect(svc.getStatus().consecutiveFailures).toBe(0);
    expect(await svc.speak({ text: '```\ncode\n```' })).toMatchObject({ ok: false, kind: 'empty' });
  });

  it('stop() aborts in-flight requests', async () => {
    let seen: AbortSignal | undefined;
    const svc = new EdgeTtsService({
      synthesize: (_t, o) =>
        new Promise((_r, rej) => {
          seen = o.signal;
          o.signal!.addEventListener('abort', () => rej(new EdgeTtsError('aborted', 'a')));
        }),
    });
    const p = svc.speak({ text: '你好' });
    svc.stop();
    expect(seen!.aborted).toBe(true);
    await expect(p).resolves.toMatchObject({ ok: false, kind: 'aborted' });
  });
});

describe('listChineseVoices', () => {
  beforeEach(() => clearVoiceCacheForTests());
  it('filters zh voices from the online list', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { ShortName: 'en-US-AriaNeural', Locale: 'en-US' },
        { ShortName: 'zh-CN-XiaoyiNeural', Locale: 'zh-CN', Gender: 'Female' },
        { ShortName: 'zh-CN-YunxiNeural', Locale: 'zh-CN', Gender: 'Male' },
      ],
    }));
    const r = await listChineseVoices(fetchImpl);
    expect(r.source).toBe('online');
    expect(r.voices.map((v) => v.shortName)).toEqual(['zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural']);
  });
  it('falls back to the built-in list', async () => {
    const r = await listChineseVoices(async () => {
      throw new Error('offline');
    });
    expect(r).toEqual({ source: 'builtin', voices: [...BUILTIN_ZH_VOICES] });
    const r2 = await listChineseVoices(async () => ({
      ok: false,
      status: 403,
      json: async () => [],
    }));
    expect(r2.source).toBe('builtin');
  });
});

describe('speech text helpers', () => {
  it('strips markdown and code', () => {
    const md =
      '# 标题\n\n看 [文档](https://x.y) 和 ![图](a.png)。\n```js\nconst a=1\n```\n- **重点**：`x` 很好\n> 引用 https://a.b/c';
    const out = cleanTextForSpeech(md);
    expect(out).not.toMatch(/[#*`>\[\]]|https?:|const a/);
    expect(out).toContain('文档');
    expect(out).toContain('重点');
  });
  it('splits long text into sentence segments', () => {
    const segs = splitSpeechSegments('第一句。第二句！第三句？' + '长'.repeat(400), 20);
    expect(segs.length).toBeGreaterThan(2);
    expect(segs.every((s) => s.length <= 280)).toBe(true);
    expect(segs.join('')).toContain('第一句。');
    expect(splitSpeechSegments('   ')).toEqual([]);
  });
});
