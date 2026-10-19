jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  geminiPathKey,
  geminiTrustedFoldersPath,
  isBroadGeminiFolder,
  stripJsonComments,
  trustGeminiFolder,
} from '../../../src/cli/gemini/trustedFolders';

describe('Gemini trustedFolders.json', () => {
  let home: string;
  let file: string;
  let proj: string;
  const env = (): NodeJS.ProcessEnv => ({});
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gtf-'));
    file = path.join(home, '.gemini', 'trustedFolders.json');
    proj = path.join(home, 'work', 'proj');
    fs.mkdirSync(proj, { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  const real = (p: string) => fs.realpathSync(p);

  it('resolves the file like Gemini: GEMINI_CLI_TRUSTED_FOLDERS_PATH > GEMINI_CLI_HOME > home', () => {
    expect(geminiTrustedFoldersPath('/h', {})).toBe(
      path.join('/h', '.gemini', 'trustedFolders.json'),
    );
    expect(geminiTrustedFoldersPath('/h', { GEMINI_CLI_HOME: '/g' })).toBe(
      path.join(path.resolve('/g'), '.gemini', 'trustedFolders.json'),
    );
    expect(
      geminiTrustedFoldersPath('/h', {
        GEMINI_CLI_HOME: '/g',
        GEMINI_CLI_TRUSTED_FOLDERS_PATH: '/x/t.json',
      }),
    ).toBe(path.resolve('/x/t.json'));
  });

  it('creates the file with just that folder as TRUST_FOLDER, private (0600), no temp files left', async () => {
    const r = await trustGeminiFolder(proj, { home, env: env() });
    expect(r).toEqual({ folder: real(proj), file, previous: null });
    expect(read()).toEqual({ [real(proj)]: 'TRUST_FOLDER' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['trustedFolders.json']);
    // 父目录没有被信任
    expect(Object.keys(read())).not.toContain(real(path.dirname(proj)));
  });

  it('keeps every existing entry (including other levels) and does not duplicate', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ '/a': 'TRUST_PARENT', '/b': 'DO_NOT_TRUST', '/c': 'SOMETHING_ELSE' }),
    );
    await trustGeminiFolder(proj, { home, env: env() });
    await trustGeminiFolder(proj, { home, env: env() });
    expect(read()).toEqual({
      '/a': 'TRUST_PARENT',
      '/b': 'DO_NOT_TRUST',
      '/c': 'SOMETHING_ELSE',
      [real(proj)]: 'TRUST_FOLDER',
    });
  });

  it('updates an existing entry for the same folder (e.g. DO_NOT_TRUST) in place', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [real(proj)]: 'DO_NOT_TRUST' }));
    const r = await trustGeminiFolder(proj, { home, env: env() });
    expect(r.previous).toBe('DO_NOT_TRUST');
    expect(read()).toEqual({ [real(proj)]: 'TRUST_FOLDER' });
  });

  it('matches existing keys the way Gemini compares them (case-insensitive on macOS / Windows)', () => {
    expect(geminiPathKey('/Users/A/Proj', 'darwin')).toBe('/users/a/proj');
    expect(geminiPathKey('/Users/A/Proj', 'linux')).toBe('/Users/A/Proj');
    expect(geminiPathKey('C:\\Users\\A\\Proj', 'win32')).toBe('c:/users/a/proj');
  });

  it('accepts comments (JSONC) like Gemini does', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{\n  // mine\n  "/a": "TRUST_FOLDER" /* x */\n}\n');
    await trustGeminiFolder(proj, { home, env: env() });
    expect(read()).toEqual({ '/a': 'TRUST_FOLDER', [real(proj)]: 'TRUST_FOLDER' });
    expect(stripJsonComments('{"u":"http://x/*y*/"}')).toBe('{"u":"http://x/*y*/"}');
  });

  it.each([['{ not json'], ['[]'], ['"str"']])(
    'refuses to touch a malformed file (%s)',
    async (content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      await expect(trustGeminiFolder(proj, { home, env: env() })).rejects.toThrow('格式有误');
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    },
  );

  it('rejects missing folders, files and relative paths', async () => {
    await expect(trustGeminiFolder(path.join(home, 'nope'), { home, env: env() })).rejects.toThrow(
      '工作目录无效',
    );
    fs.writeFileSync(path.join(home, 'f.txt'), '');
    await expect(trustGeminiFolder(path.join(home, 'f.txt'), { home, env: env() })).rejects.toThrow(
      '工作目录无效',
    );
    await expect(trustGeminiFolder('rel/dir', { home, env: env() })).rejects.toThrow(
      '工作目录无效',
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  it('explains when an env var forces Gemini to distrust everything', async () => {
    await expect(
      trustGeminiFolder(proj, { home, env: { GEMINI_CLI_TRUST_WORKSPACE: 'false' } }),
    ).rejects.toThrow('GEMINI_CLI_TRUST_WORKSPACE=false');
    await expect(
      trustGeminiFolder(proj, { home, env: { GEMINI_RESTRICTED_MODE: 'true' } }),
    ).rejects.toThrow('GEMINI_RESTRICTED_MODE=true');
  });

  it("waits for Gemini's lock, and clears a stale one", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    const lock = `${file}.lock`;
    fs.mkdirSync(lock);
    const p = trustGeminiFolder(proj, { home, env: env() });
    await new Promise((r) => setTimeout(r, 250));
    expect(read()).toEqual({}); // 还在等锁
    fs.rmdirSync(lock);
    await p;
    expect(read()).toEqual({ [real(proj)]: 'TRUST_FOLDER' });
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await trustGeminiFolder(path.join(home, 'work'), { home, env: env() });
    expect(Object.keys(read())).toHaveLength(2);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('flags broad folders: root, home, top-level home folders and the default chat folder', () => {
    expect(isBroadGeminiFolder('/', '/home/u', [], 'linux')).toBe(true);
    expect(isBroadGeminiFolder('/home/u', '/home/u', [], 'linux')).toBe(true);
    expect(isBroadGeminiFolder('/home/u/Documents', '/home/u', [], 'linux')).toBe(true);
    expect(isBroadGeminiFolder('/home/u/Documents/proj', '/home/u', [], 'linux')).toBe(false);
    expect(isBroadGeminiFolder('/srv/x/y', '/home/u', ['/srv/x/y'], 'linux')).toBe(true);
    expect(isBroadGeminiFolder('C:\\', 'C:\\Users\\u', [], 'win32')).toBe(true);
    expect(isBroadGeminiFolder('C:\\Users\\U\\Documents', 'C:\\Users\\u', [], 'win32')).toBe(true);
    expect(isBroadGeminiFolder('C:\\Users\\u\\Documents\\p', 'C:\\Users\\u', [], 'win32')).toBe(
      false,
    );
  });
});
