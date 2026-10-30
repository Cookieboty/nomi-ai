import {
  assertPublicHttpUrl,
  assertPublicHttpUrlResolved,
  isPrivateHost,
  makeSafeLookup,
  safeLookup,
} from '../../../src/security/netGuard';

describe('netGuard', () => {
  it('放行公网 https / http', () => {
    expect(assertPublicHttpUrl('https://cos.example.com/a/tts.mp3').hostname).toBe(
      'cos.example.com',
    );
    expect(assertPublicHttpUrl('http://8.8.8.8/x').hostname).toBe('8.8.8.8');
  });

  it('拒绝非 http(s) 协议', () => {
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => assertPublicHttpUrl('ftp://example.com/a')).toThrow(/http/);
  });

  it.each([
    'http://127.0.0.1/x',
    'http://localhost/x',
    'http://192.168.1.1/x',
    'http://10.0.0.2/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x',
    'http://[fe80::1]/x',
    'http://[fc00::1]/x',
  ])('拒绝内网地址 %s', (u) => {
    expect(() => assertPublicHttpUrl(u)).toThrow(/本机或局域网/);
  });

  it('拒绝内嵌凭据', () => {
    expect(() => assertPublicHttpUrl('https://user:pass@example.com/')).toThrow(/账号密码/);
  });

  it('拒绝非法 URL', () => {
    expect(() => assertPublicHttpUrl('not a url')).toThrow(/无效/);
  });

  it('isPrivateHost 覆盖云元数据地址', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('100.64.0.1')).toBe(true); // CGNAT 100.64.0.0/10
  });
});

describe('netGuard · 加固', () => {
  it.each([
    // IPv4 保留段
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '100.127.255.254',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    // 非常规写法
    '2130706433', // 127.0.0.1
    '0177.0.0.1',
    '0x7f.0.0.1',
    '0x7f000001',
    '127.1',
    '10.1',
    '017700000001',
    // IPv6
    '::',
    '[::1]',
    '::ffff:127.0.0.1',
    '[::ffff:7f00:1]', // WHATWG URL 规范化后的形式
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    'fd12:3456::1',
    'fe80::1%eth0',
    'febf::1',
    'ff02::1',
    'localhost.',
    'printer.local',
  ])('私有 / 保留：%s', (h) => expect(isPrivateHost(h)).toBe(true));

  it.each([
    '8.8.8.8',
    '100.63.255.255',
    '100.128.0.1',
    '172.32.0.1',
    '134744072', // 8.8.8.8
    '::ffff:8.8.8.8',
    '2606:4700:4700::1111',
    '64:ff9b::8.8.8.8',
    'example.com',
    '1.example.com',
  ])('公网：%s', (h) => expect(isPrivateHost(h)).toBe(false));

  it.each([
    'http://2130706433/x',
    'http://0x7f.1/x',
    'http://0177.0.0.1/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://100.64.1.1/x',
    'http://0.0.0.0/x',
  ])('URL 规范化后仍拒绝 %s', (u) => {
    expect(() => assertPublicHttpUrl(u)).toThrow(/本机或局域网/);
  });

  it('解析结果含内网地址时拒绝（DNS 预检）', async () => {
    const lookup = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];
    await expect(assertPublicHttpUrlResolved('https://rebind.example/a', lookup)).rejects.toThrow(
      /本机或局域网/,
    );
    await expect(
      assertPublicHttpUrlResolved('https://ok.example/a', async () => [
        { address: '93.184.216.34', family: 4 },
      ]),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicHttpUrlResolved('https://empty.example/a', async () => []),
    ).rejects.toThrow();
  });

  it('safeLookup 在连接时的解析结果上校验（防 DNS 重绑定）', async () => {
    const answers = [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '::ffff:10.0.0.1', family: 6 }],
    ];
    let i = 0;
    const base = ((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) =>
      cb(null, answers[i++])) as unknown as typeof import('dns').lookup;
    const lookup = makeSafeLookup(base);
    const call = () =>
      new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((r) =>
        lookup('rebind.example', {}, (err, addr) => r({ err, addr })),
      );
    expect(await call()).toEqual({ err: null, addr: '93.184.216.34' });
    const second = await call();
    expect(second.err?.code).toBe('EPRIVATEADDR');
  });

  it('safeLookup 真实接入 http：连接 127.0.0.1 被拦截', async () => {
    const http = await import('http');
    const server = http.createServer((_q, s) => s.end('secret'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as import('net').AddressInfo).port;
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => {
      http
        .get(`http://localhost:${port}/`, { lookup: safeLookup }, () => r(null))
        .on('error', (e) => r(e));
    });
    server.close();
    expect(err?.code).toBe('EPRIVATEADDR');
  });
});
