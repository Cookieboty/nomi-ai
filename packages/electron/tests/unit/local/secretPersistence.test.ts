/**
 * 回归 #18 / #35：
 * - 导出 ZIP 的 settings/mcp.json 不含任何 env / header 取值、URL 凭据与命令行令牌（无论落盘时是否加密）；
 * - 安全存储不可用 / encryptString 抛错时，MCP 密钥失败关闭，不写明文。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

const safe = { available: true, throws: false };

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  ClipboardItem: class {},
  clipboard: {},
  dialog: {},
  nativeImage: {},
  shell: {},
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { strFromU8, unzipSync } from 'fflate';

import { ExtensionsService } from '../../../src/extensions/ExtensionsService';
import { redactServerForExport } from '../../../src/extensions/mcpConfig';
import { LocalHubService } from '../../../src/local/LocalHubService';
import { fakeSecrets, featureDeps } from '../helpers/featureHost';

const SECRET = 'TEST_MCP_SECRET_12345';
const B64 = (s: string) => Buffer.from(`CIPHER<${s}>`).toString('base64');

let ud: string;

function makeExt(): ExtensionsService {
  const root = path.join(ud, 'extensions');
  return new ExtensionsService({
    root,
    skillsRoot: path.join(ud, 'skills'),
    logger: { info() {}, warn() {}, error() {} } as never,
    desktop: { audit: { append: jest.fn() } } as never,
    ...featureDeps({ secrets: fakeSecrets(safe) }),
  });
}
function makeHub(): LocalHubService {
  return new LocalHubService({
    root: path.join(ud, 'local'),
    userData: ud,
    logger: { info() {}, warn() {}, error() {} },
    desktop: { audit: { append: jest.fn() } },
    ...featureDeps({ secrets: fakeSecrets(safe) }),
  } as never);
}
function exported(hub: LocalHubService): Record<string, string> {
  const file = path.join(ud, 'out.zip');
  hub.exportTo(file, { include: ['settings'] });
  const z = unzipSync(new Uint8Array(fs.readFileSync(file)));
  return Object.fromEntries(Object.entries(z).map(([k, v]) => [k, strFromU8(v)]));
}
const server = {
  name: 'Remote',
  transport: 'http' as const,
  url: `https://user:pw-${SECRET}@mcp.example.com/mcp?key=${SECRET}&x=1#frag`,
  env: { API_KEY: SECRET, DEBUG: '1' },
  headers: { Authorization: `Bearer ${SECRET}`, 'X-Custom-Gateway': SECRET },
};

describe('MCP 导出脱敏与密钥落盘（#18）', () => {
  beforeEach(() => {
    ud = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-'));
    safe.available = true;
    safe.throws = false;
  });
  afterEach(() => fs.rmSync(ud, { recursive: true, force: true }));

  it('redactServerForExport：env / headers 全部取值、URL 凭据、命令行令牌都被移除', () => {
    const r = redactServerForExport(
      {
        id: 'x',
        name: 'x',
        transport: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'pkg',
          '--api-key',
          SECRET,
          `--token=${SECRET}`,
          `GITHUB_TOKEN=${SECRET}`,
          `https://u:${SECRET}@h.example/p?t=${SECRET}`,
          '--port',
          '8080',
        ],
        env: { A: SECRET, enc: `enc:${B64(SECRET)}`, EMPTY: '' },
        headers: { 'X-Whatever': SECRET },
        url: `https://h.example/p?access_token=${SECRET}`,
        enabled: true,
        trust: 'ask',
        origin: 'user',
      },
      '<R>',
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(B64(SECRET));
    expect(r.env).toEqual({ A: '<R>', enc: '<R>', EMPTY: '<R>' });
    expect(r.headers).toEqual({ 'X-Whatever': '<R>' });
    expect(r.args).toEqual([
      '-y',
      'pkg',
      '--api-key',
      '<R>',
      '--token=<R>',
      'GITHUB_TOKEN=<R>',
      'https://h.example/p',
      '--port',
      '8080',
    ]);
    expect(r.url).toBe('https://h.example/p');
  });

  it('正常密文保存 → 导出不含明文、密文或其 base64', () => {
    makeExt().upsert({ ...server, url: 'https://mcp.example.com/mcp' });
    const raw = fs.readFileSync(path.join(ud, 'extensions', 'mcp.json'), 'utf8');
    expect(raw).not.toContain(SECRET); // 落盘为 enc:
    const z = exported(makeHub());
    const mcp = z['settings/mcp.json'];
    expect(mcp).toBeDefined();
    expect(mcp).not.toContain(SECRET);
    expect(mcp).not.toContain(B64(SECRET));
    expect(mcp).not.toContain('enc:');
    expect(JSON.parse(mcp)[0].headers.Authorization).toBeTruthy();
  });

  it('旧版本遗留的明文 mcp.json（含非标准 header）导出时同样被脱敏', () => {
    fs.mkdirSync(path.join(ud, 'extensions'), { recursive: true });
    fs.writeFileSync(
      path.join(ud, 'extensions', 'mcp.json'),
      JSON.stringify([{ ...server, id: 'remote', enabled: true, trust: 'ask', origin: 'user' }]),
    );
    const mcp = exported(makeHub())['settings/mcp.json'];
    expect(mcp).not.toContain(SECRET);
    expect(mcp).not.toContain('mcp.example.com/mcp?');
  });

  it.each([
    ['safeStorage 不可用', () => (safe.available = false)],
    ['encryptString 抛错', () => (safe.throws = true)],
  ])('%s：保存带密钥的 MCP 服务失败关闭，磁盘上没有明文', (_n, arrange) => {
    arrange();
    const ext = makeExt();
    expect(() => ext.upsert(server)).toThrow(/安全存储不可用/);
    expect(() => ext.upsert({ name: 's', command: 'node', env: { API_KEY: SECRET } })).toThrow(
      /安全存储不可用/,
    );
    expect(fs.existsSync(path.join(ud, 'extensions', 'mcp.json'))).toBe(false);
    expect(() =>
      ext.importJson(
        JSON.stringify({
          mcpServers: { s: { url: 'https://a.b/mcp', headers: { Authorization: SECRET } } },
        }),
      ),
    ).toThrow(/安全存储不可用/);
    expect(fs.existsSync(path.join(ud, 'extensions', 'mcp.json'))).toBe(false);
    // 没有密钥的服务不受影响
    expect(() => ext.upsert({ name: 'plain', command: 'node', env: { DEBUG: '1' } })).not.toThrow();
  });

  it('安全存储不可用时，对已有（旧版明文）服务只切启用开关不丢数据、也不被拒', async () => {
    fs.mkdirSync(path.join(ud, 'extensions'), { recursive: true });
    fs.writeFileSync(
      path.join(ud, 'extensions', 'mcp.json'),
      JSON.stringify([
        {
          id: 'old',
          name: 'old',
          transport: 'stdio',
          command: 'x',
          env: { API_KEY: 'legacy' },
          enabled: false,
          trust: 'ask',
          origin: 'user',
        },
      ]),
    );
    safe.available = false;
    const ext = makeExt();
    await expect(ext.toggle('old', false)).resolves.toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(ud, 'extensions', 'mcp.json'), 'utf8'))[0].env.API_KEY,
    ).toBe('legacy');
  });
});
