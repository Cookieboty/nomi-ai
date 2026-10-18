jest.unmock('fs');
jest.unmock('path');

import {
  ProcessFailure,
  resolveCliLaunch,
  runLimited,
  unwrapWindowsCmdShim,
  windowsShimLaunch,
} from '../../../src/usage/limitedProcess';

const node = process.execPath;
const base = { cwd: process.cwd(), env: { ...process.env }, timeoutMs: 5000, maxBytes: 1024 };
const run = (code: string, o: Partial<typeof base> = {}) =>
  runLimited(node, ['-e', code], { ...base, ...o });

describe('runLimited：受限子进程', () => {
  it('正常：收 stdout 和退出码；stderr 被丢弃', async () => {
    const r = await run("console.log('hi'); console.error('SECRET-ON-STDERR'); process.exit(3)");
    expect(r.stdout.trim()).toBe('hi');
    expect(r.code).toBe(3);
    expect(r.stdout).not.toContain('SECRET');
  });

  it('stdin 是关闭的（读 stdin 立即 EOF，不会挂住）', async () => {
    const r = await run(
      "let n=0;process.stdin.on('data',c=>n+=c.length).on('end',()=>console.log('eof',n))",
    );
    expect(r.stdout.trim()).toBe('eof 0');
  });

  it('超时：终止子进程并抛 timeout', async () => {
    const t0 = Date.now();
    await expect(run('setInterval(()=>{},1000)', { timeoutMs: 300 })).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('输出上限：超过 maxBytes 立即终止并抛 output-limit', async () => {
    await expect(
      run("process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)", { maxBytes: 1000 }),
    ).rejects.toMatchObject({ kind: 'output-limit' });
    // 刚好不超过上限的可以通过
    const r = await run("process.stdout.write('y'.repeat(1000))", { maxBytes: 1000 });
    expect(r.stdout).toHaveLength(1000);
  });

  it('找不到可执行文件：not-installed', async () => {
    await expect(runLimited('/nonexistent/definitely-not-claude', [], base)).rejects.toBeInstanceOf(
      ProcessFailure,
    );
    await expect(runLimited('/nonexistent/definitely-not-claude', [], base)).rejects.toMatchObject({
      kind: 'not-installed',
    });
  });
});

describe('Windows .cmd 垫片：逐参数加引号（空参数不丢）', () => {
  it('拼出 cmd.exe /d /s /c "…"，--tools "" 保留为 ""', () => {
    const l = windowsShimLaunch(
      'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd',
      ['-p', '/usage', '--tools', '', '--setting-sources', ''],
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    )!;
    expect(l.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(l.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(l.args[3]).toBe(
      '""C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd" "-p" "/usage" "--tools" "" "--setting-sources" """',
    );
  });

  it('参数 / 路径里含引号、百分号、换行：拒绝（防注入）', () => {
    expect(windowsShimLaunch('a.cmd', ['x"y'], {})).toBeNull();
    expect(windowsShimLaunch('a%PATH%.cmd', [], {})).toBeNull();
    expect(windowsShimLaunch('a.cmd', ['x\ny'], {})).toBeNull();
  });
});

describe('unwrapWindowsCmdShim / resolveCliLaunch：Windows ACP stdin', () => {
  it('把 npm .cmd 垫片解成 node + script（stdin ACP 可用）', () => {
    const dir = '/tmp/npm-shim';
    const script = `${dir}/node_modules/@xai-official/grok/bin/grok.js`;
    const node = `${dir}/node.exe`;
    const files = new Set([script, node]);
    const u = unwrapWindowsCmdShim(`${dir}/grok.cmd`, {
      readFile: () =>
        'endLocal & "%_prog%"  "%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok.js" %*\n',
      exists: (p) => files.has(p),
    });
    expect(u).toEqual({ node, script });
  });

  it('resolveCliLaunch：win32 优先 node-script，非 Windows 保持原命令', () => {
    const dir = '/tmp/npm-shim2';
    const script = `${dir}/node_modules/@xai-official/grok/bin/grok.js`;
    const launch = resolveCliLaunch(
      `${dir}/grok.cmd`,
      ['agent', 'stdio'],
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      'win32',
      {
        readFile: () => '"%_prog%"  "%dp0%/node_modules/@xai-official/grok/bin/grok.js" %*',
        exists: (p) => p === script,
      },
    )!;
    expect(launch.via).toBe('node-script');
    expect(launch.args).toEqual([script, 'agent', 'stdio']);
    expect(launch.file).toBe('node.exe');

    expect(resolveCliLaunch('/usr/local/bin/grok', ['agent', 'stdio'], {}, 'linux')).toEqual({
      file: '/usr/local/bin/grok',
      args: ['agent', 'stdio'],
      via: 'direct',
    });
  });

  it('解不出脚本时回退到 cmd.exe /c 垫片', () => {
    const launch = resolveCliLaunch(
      'C:\\npm\\grok.cmd',
      ['agent', 'stdio'],
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      'win32',
      { readFile: () => '@echo off', exists: () => false },
    )!;
    expect(launch.via).toBe('cmd-shim');
    expect(launch.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });
});
