// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  denyReason,
  guardPath,
  isInside,
  normalizeInput,
  type Scope,
} from '../../../src/desktop/pathGuard';

const scope = (p: string, mode: Scope['mode'] = 'read', kind: Scope['kind'] = 'folder'): Scope => ({
  id: p,
  path: p,
  mode,
  kind,
  grantedAt: 0,
});

describe('pathGuard · syntax', () => {
  const home = '/home/u';
  it.each([
    ['', 'invalid_path'],
    ['relative/file.txt', 'invalid_path'],
    ['\\\\server\\share\\x.txt', 'invalid_path'],
    ['//server/share/x.txt', 'invalid_path'],
    ['/dev/sda', 'invalid_path'],
    ['/proc/self/environ', 'invalid_path'],
    ['/a/b\0c', 'invalid_path'],
  ])('rejects %j', (p, code) => {
    const r = normalizeInput(p, home, 'linux');
    expect(typeof r).toBe('object');
    expect((r as { code: string }).code).toBe(code);
  });

  it('rejects windows UNC / device / driveless paths', () => {
    expect(normalizeInput('\\\\?\\C:\\x', 'C:\\Users\\u', 'win32')).toMatchObject({
      code: 'invalid_path',
    });
    expect(normalizeInput('\\\\.\\PhysicalDrive0', 'C:\\Users\\u', 'win32')).toMatchObject({
      code: 'invalid_path',
    });
    expect(normalizeInput('\\Windows\\x', 'C:\\Users\\u', 'win32')).toMatchObject({
      code: 'invalid_path',
    });
    expect(normalizeInput('C:\\Users\\u\\Docs\\a.txt', 'C:\\Users\\u', 'win32')).toBe(
      'C:\\Users\\u\\Docs\\a.txt',
    );
  });

  it('expands ~ and collapses ..', () => {
    expect(normalizeInput('~/Docs/../Docs/a.md', home, 'linux')).toBe('/home/u/Docs/a.md');
  });

  it('isInside handles prefixes, .. and case-insensitive platforms', () => {
    expect(isInside('/a/bc', '/a/b', 'linux')).toBe(false);
    expect(isInside('/a/b/../c', '/a/b', 'linux')).toBe(false);
    expect(isInside('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(isInside('C:\\Users\\U\\docs', 'c:\\users\\u', 'win32')).toBe(true);
    expect(isInside('/Users/U/Docs', '/users/u', 'darwin')).toBe(true);
    expect(isInside('/Users/U/Docs', '/users/u', 'linux')).toBe(false);
  });
});

describe('pathGuard · denylist', () => {
  it.each([
    '/home/u/.ssh/config',
    '/home/u/.gnupg/pubring.kbx',
    '/home/u/.aws/credentials',
    '/home/u/Docs/id_rsa',
    '/home/u/Docs/id_ed25519.pub',
    '/home/u/Docs/vault.kdbx',
    '/home/u/project/.env',
    '/home/u/project/.env.local',
    '/home/u/certs/server.pem',
    '/home/u/.config/google-chrome/Default/Cookies',
    '/home/u/.mozilla/firefox/x/logins.json',
    '/Users/u/Library/Keychains/login.keychain-db',
    '/Users/u/Library/Application Support/Google/Chrome/Default/Login Data',
  ])('denies %s', (p) => {
    expect(denyReason(p, 'linux')).not.toBeNull();
  });

  it('denies windows credential stores and app data roots', () => {
    expect(
      denyReason('C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data', 'win32'),
    ).not.toBeNull();
    expect(
      denyReason('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Protect\\x', 'win32'),
    ).not.toBeNull();
    expect(
      denyReason('/home/u/.config/nomi/ai-providers.json', 'linux', ['/home/u/.config/nomi']),
    ).toBe('应用私有数据目录');
  });

  it('allows ordinary documents', () => {
    expect(denyReason('/home/u/Documents/report.pdf', 'linux')).toBeNull();
    expect(denyReason('/home/u/Documents/environment.md', 'linux')).toBeNull();
  });
});

describe('pathGuard · real filesystem', () => {
  let root: string;
  let docs: string;
  let outside: string;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));
    docs = path.join(root, 'Docs');
    outside = path.join(root, 'Secret');
    fs.mkdirSync(docs);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(docs, 'a.md'), '# hi');
    fs.writeFileSync(path.join(outside, 'b.txt'), 'secret');
    fs.mkdirSync(path.join(docs, '.ssh'));
    fs.writeFileSync(path.join(docs, '.ssh', 'id_rsa'), 'k');
    try {
      fs.symlinkSync(outside, path.join(docs, 'link'), 'dir');
      fs.symlinkSync(path.join(outside, 'b.txt'), path.join(docs, 'b-link.txt'));
    } catch {
      /* windows without symlink privilege */
    }
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const env = (scopes: Scope[]) => ({
    scopes,
    home: root,
    platform: process.platform,
    realpath: (p: string) => fs.promises.realpath(p),
  });

  it('allows a file inside a granted folder', async () => {
    const r = await guardPath(path.join(docs, 'a.md'), env([scope(docs)]));
    expect(r).toMatchObject({ ok: true, exists: true });
  });

  it('rejects outside scope and ../ traversal', async () => {
    expect(await guardPath(path.join(outside, 'b.txt'), env([scope(docs)]))).toMatchObject({
      ok: false,
      code: 'outside_scope',
    });
    expect(
      await guardPath(`${docs}${path.sep}..${path.sep}Secret${path.sep}b.txt`, env([scope(docs)])),
    ).toMatchObject({
      ok: false,
      code: 'outside_scope',
    });
  });

  it('rejects symlinks that escape the scope', async () => {
    if (!fs.existsSync(path.join(docs, 'link'))) return;
    expect(await guardPath(path.join(docs, 'link', 'b.txt'), env([scope(docs)]))).toMatchObject({
      ok: false,
      code: 'symlink_escape',
    });
    expect(await guardPath(path.join(docs, 'b-link.txt'), env([scope(docs)]))).toMatchObject({
      ok: false,
      code: 'symlink_escape',
    });
  });

  it('denylist wins even inside a granted folder', async () => {
    expect(await guardPath(path.join(docs, '.ssh', 'id_rsa'), env([scope(docs)]))).toMatchObject({
      ok: false,
      code: 'denied',
    });
  });

  it('write needs a read-write scope; missing files allowed only when asked', async () => {
    const target = path.join(docs, 'new.txt');
    expect(
      await guardPath(target, env([scope(docs)]), { need: 'write', allowMissing: true }),
    ).toMatchObject({ code: 'read_only' });
    expect(
      await guardPath(target, env([scope(docs, 'read-write')]), {
        need: 'write',
        allowMissing: true,
      }),
    ).toMatchObject({
      ok: true,
      exists: false,
    });
    expect(
      await guardPath(target, env([scope(docs, 'read-write')]), { need: 'read' }),
    ).toMatchObject({ code: 'not_found' });
  });

  it('single-file scope only grants that file', async () => {
    const f = path.join(docs, 'a.md');
    expect(await guardPath(f, env([scope(f, 'read', 'file')]))).toMatchObject({ ok: true });
    expect(await guardPath(docs, env([scope(f, 'read', 'file')]))).toMatchObject({ ok: false });
  });
});
