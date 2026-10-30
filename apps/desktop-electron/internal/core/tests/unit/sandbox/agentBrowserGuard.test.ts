import { checkRequestUrlSync, createRequestGuard } from '../../../src/sandbox/agentBrowserGuard';

const resolves = (map: Record<string, string[]>) => async (host: string) => {
  const list = map[host];
  if (!list) throw new Error(`ENOTFOUND ${host}`);
  return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

describe('agentBrowserGuard · 导航与子资源同一判定', () => {
  const guard = createRequestGuard({
    lookupAll: resolves({
      'example.com': ['93.184.216.34'],
      'internal.corp': ['10.0.0.8'],
      'rebind.evil': ['93.184.216.34', '127.0.0.1'],
      'meta.evil': ['169.254.169.254'],
      'v6.evil': ['::ffff:10.0.0.1'],
    }),
  });

  it('放行解析到公网的 http(s) / ws(s) 与不出网的内置 scheme', async () => {
    for (const u of [
      'https://example.com/a.js',
      'http://example.com/img.png',
      'wss://example.com/socket',
      'about:blank',
      'data:text/html,hi',
      'blob:https://example.com/uuid',
    ]) {
      expect((await guard.decideRequest(u)).cancel).toBe(false);
    }
  });

  it('拒绝内网 / 回环 / 链路本地 / 云元数据地址（含各种 IPv4 写法）', async () => {
    for (const u of [
      'http://127.0.0.1:8080/',
      'http://localhost/admin',
      'http://10.1.2.3/',
      'http://192.168.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://2130706433/', // 十进制 127.0.0.1
      'http://0177.0.0.1/', // 八进制
      'http://0x7f.1/',
      'http://[::ffff:127.0.0.1]/',
      'ws://127.0.0.1:9222/devtools',
    ]) {
      expect((await guard.decideRequest(u)).cancel).toBe(true);
    }
  });

  it('域名解析到内网（含任一地址是内网）→ 拒绝；解析失败 → 拒绝', async () => {
    for (const u of [
      'http://internal.corp/',
      'https://rebind.evil/x.png',
      'https://meta.evil/',
      'https://v6.evil/',
      'https://nonexistent.invalid/',
    ]) {
      expect((await guard.decideRequest(u)).cancel).toBe(true);
    }
  });

  it('拒绝 file: / ftp: / 内嵌凭据 / 非法 URL', async () => {
    for (const u of [
      'file:///etc/passwd',
      'ftp://example.com/',
      'https://user:pw@example.com/',
      'not a url',
    ]) {
      expect((await guard.decideRequest(u)).cancel).toBe(true);
    }
  });

  it('同步判定（will-navigate 用）与异步共用同一套 IP 规则', () => {
    expect(checkRequestUrlSync('http://127.0.0.1/').cancel).toBe(true);
    expect(checkRequestUrlSync('https://example.com/').cancel).toBe(false);
  });

  it('DNS 重绑定兜底：实际连接的对端是内网 → 判定为危险并拉黑该主机', async () => {
    expect(guard.onConnected('https://example.com/a', '93.184.216.34')).toBe(false);
    expect(guard.onConnected('https://example.com/a', undefined)).toBe(false);
    expect(guard.onConnected('https://example.com/a', '10.0.0.5')).toBe(true);
    // 之后即便 DNS 又解析回公网，该主机也不再放行
    expect((await guard.decideRequest('https://example.com/b')).cancel).toBe(true);
  });
});
