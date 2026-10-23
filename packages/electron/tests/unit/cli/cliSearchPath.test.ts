/**
 * #76：从 Dock 启动时 PATH 很短，npm 装在 nvm / volta / 自定义 prefix 等目录下的 CLI 找不到。
 * 覆盖：登录 shell PATH 的解析与合并、兜底搜索目录、记住的目录、安装方式判断。
 */
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cliSearchDirs,
  findOnPath,
  guessInstallMethod,
  npmPrefixBinDir,
  rememberCliDir,
  resetCliBinCache,
} from '../../../src/cli/detect';
import {
  LOGIN_SHELL_ARGS,
  loadLoginShellPath,
  mergePath,
  parseShellPath,
  resetShellPathForTest,
} from '../../../src/cli/shellPath';

const posix = process.platform === 'win32' ? it.skip : it;

describe('login shell PATH', () => {
  it('takes the PATH between the markers and ignores rc-file noise', () => {
    const out =
      'Welcome to zsh\nnvm: using v22\n__NOMI_PATH_START__/a/bin:/usr/bin__NOMI_PATH_END__';
    expect(parseShellPath(out)).toBe('/a/bin:/usr/bin');
    expect(parseShellPath('no markers here')).toBeNull();
    expect(parseShellPath('__NOMI_PATH_START____NOMI_PATH_END__')).toBeNull();
  });

  it('appends only new directories, keeping the current order first', () => {
    expect(mergePath('/usr/bin:/bin', '/opt/n/bin:/usr/bin::/bin:/x', ':')).toBe(
      '/usr/bin:/bin:/opt/n/bin:/x',
    );
    expect(mergePath('', '/a:/a', ':')).toBe('/a');
  });
});

describe('loadLoginShellPath (real child process, fake shell)', () => {
  const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
  let dir = '';
  beforeEach(() => {
    resetShellPathForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-shell-'));
  });
  afterEach(() => {
    process.env.PATH = saved.PATH;
    process.env.SHELL = saved.SHELL;
    resetShellPathForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  posix('asks the login shell for PATH and merges it after the current one', async () => {
    process.env.SHELL = '/opt/fake/zsh';
    process.env.PATH = '/usr/bin:/bin';
    const calls: Array<[string, string[]]> = [];
    const added: string[][] = [];
    await loadLoginShellPath((a) => added.push(a), {
      run: async (shell, args) => {
        calls.push([shell, args]);
        return parseShellPath(
          'rc noise\n__NOMI_PATH_START__/fake/nvm/bin:/usr/bin:/bin__NOMI_PATH_END__',
        );
      },
    });
    expect(calls).toEqual([['/opt/fake/zsh', LOGIN_SHELL_ARGS]]);
    expect(LOGIN_SHELL_ARGS[0]).toBe('-ilc');
    expect(process.env.PATH).toBe('/usr/bin:/bin:/fake/nvm/bin');
    expect(added).toEqual([['/fake/nvm/bin']]);
  });

  posix(
    'really runs the shell with -ilc (integration)',
    async () => {
      // 假 shell：打印 rc 噪音，再按登录 shell 的 PATH 执行传进来的命令。
      // 超时放宽：全仓并行跑测试时拉起 shell 可能很慢，这里只验证参数与引号能被真实 shell 正确执行
      const shell = path.join(dir, 'fake-shell');
      fs.writeFileSync(
        shell,
        '#!/bin/sh\necho "rc noise"\nPATH=/fake/nvm/bin:/usr/bin:/bin\nexport PATH\nexec /bin/sh -c "$2"\n',
        { mode: 0o755 },
      );
      process.env.SHELL = shell;
      process.env.PATH = '/usr/bin:/bin';
      await loadLoginShellPath(undefined, { timeoutMs: 30_000 });
      expect(process.env.PATH).toBe('/usr/bin:/bin:/fake/nvm/bin');
    },
    40_000,
  );

  posix('keeps PATH unchanged when the shell fails', async () => {
    process.env.SHELL = path.join(dir, 'missing-shell');
    process.env.PATH = '/usr/bin:/bin';
    await loadLoginShellPath();
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });
});

describe('CLI search directories', () => {
  let home = '';
  beforeEach(() => {
    resetCliBinCache();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dirs-'));
  });
  afterEach(() => {
    resetCliBinCache();
    fs.rmSync(home, { recursive: true, force: true });
  });

  posix('includes version managers, custom npm prefix and the newest nvm node first', () => {
    for (const v of ['v18.20.0', 'v22.11.0', 'v20.1.0'])
      fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true });
    const dirs = cliSearchDirs(home, 'darwin', { NPM_CONFIG_PREFIX: '/opt/npm-global' });
    const nvm = dirs.filter((d) => d.includes(`${path.sep}.nvm${path.sep}`));
    expect(nvm.map((d) => path.basename(path.dirname(d)))).toEqual([
      'v22.11.0',
      'v20.1.0',
      'v18.20.0',
    ]);
    for (const d of [
      '/opt/npm-global/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.npm-packages', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ])
      expect(dirs).toContain(d);
  });

  it('remembered directories (npm global bin) come first and are de-duplicated', () => {
    rememberCliDir('/custom/prefix/bin');
    rememberCliDir('/custom/prefix/bin');
    const dirs = cliSearchDirs(home, 'linux', {});
    expect(dirs[0]).toBe('/custom/prefix/bin');
    expect(dirs.filter((d) => d === '/custom/prefix/bin')).toHaveLength(1);
  });

  it('npm global bin is prefix/bin on POSIX and the prefix itself on Windows', () => {
    expect(npmPrefixBinDir('/opt/n', 'darwin')).toBe(path.join('/opt/n', 'bin'));
    expect(npmPrefixBinDir('C:\\Users\\me\\AppData\\Roaming\\npm', 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm',
    );
  });
});

describe('findOnPath (PATH 目录扫描，替代 where/which)', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-on-path-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('POSIX：在 PATH 目录里找到同名文件', () => {
    const bin = path.join(dir, 'dsh');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(findOnPath('dsh', { PATH: dir }, 'linux')).toBe(bin);
    expect(findOnPath('dsh', { PATH: '/nonexistent' }, 'linux')).toBeNull();
  });

  it('Windows：按 PATHEXT 找到 .cmd，并优先于无扩展名脚本', () => {
    const shim = path.join(dir, 'dsh.cmd');
    const script = path.join(dir, 'dsh');
    fs.writeFileSync(script, '#!/bin/sh\n');
    fs.writeFileSync(shim, '@echo off\r\n');
    const found = findOnPath('dsh', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32');
    expect(found).toBe(shim);
  });

  it('Windows：大小写不敏感的文件系统也返回磁盘上的真实文件名（PATHEXT 为大写）', () => {
    const shim = path.join(dir, 'dsh.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');
    // 模拟 NTFS / macOS 默认卷：existsSync 不区分大小写（本测试所在 FS 可能区分）
    const ciExists = (p: string) =>
      fs
        .readdirSync(path.dirname(p))
        .some((n) => n.toLowerCase() === path.basename(p).toLowerCase());
    expect(
      findOnPath('dsh', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32', ciExists),
    ).toBe(shim);
  });

  it('Windows：已带扩展名的命令只匹配精确文件名', () => {
    fs.writeFileSync(path.join(dir, 'npm.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(dir, 'npm.exe'), 'MZ');
    expect(findOnPath('npm.cmd', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(
      path.join(dir, 'npm.cmd'),
    );
  });

  it('Windows：无扩展名命中时经 windowsExecutable 升到旁边的 .cmd', () => {
    // PATHEXT 故意不含 .CMD，只能先命中无扩展名，再升级
    fs.writeFileSync(path.join(dir, 'dsh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'dsh.cmd'), '@echo off\r\n');
    expect(findOnPath('dsh', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBe(
      path.join(dir, 'dsh.cmd'),
    );
  });
});

describe('install method', () => {
  it('treats version-manager installs as npm, not native', () => {
    expect(guessInstallMethod('/Users/x/.nvm/versions/node/v22.1.0/bin/claude')).toBe('npm');
    expect(guessInstallMethod('/Users/x/.volta/bin/codex')).toBe('npm');
    expect(guessInstallMethod('/Users/x/.bun/bin/codex')).toBe('npm');
    // 原生安装器仍是 native
    expect(guessInstallMethod('/Users/x/.local/share/claude/versions/2.1.0')).toBe('native');
    expect(guessInstallMethod('/usr/local/lib/node_modules/@openai/codex/bin/codex')).toBe('npm');
  });
});
