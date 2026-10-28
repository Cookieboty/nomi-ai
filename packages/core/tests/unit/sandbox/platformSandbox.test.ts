import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  planPythonSandbox,
} from '../../../src/sandbox/platformSandbox';

describe('platformSandbox', () => {
  const tmpDir = '/tmp/cd-sbx-test';
  const python = '/usr/bin/python3';
  const script = `${tmpDir}/main.py`;
  const existsAll = () => true;

  it('linux：有 bwrap 时构造 --unshare-net 与只读 bind', () => {
    const plan = planPythonSandbox({
      python,
      scriptPath: script,
      tmpDir,
      platform: 'linux',
      bwrapPath: '/usr/bin/bwrap',
      existsSync: existsAll,
    });
    expect(plan.isolation).toBe('bwrap');
    expect(plan.cmd).toBe('/usr/bin/bwrap');
    expect(plan.args).toContain('--unshare-net');
    expect(plan.args).toContain('--ro-bind');
    expect(plan.args).toContain(tmpDir);
    expect(plan.args.slice(-4)).toEqual(['--', python, '-I', script]);
  });

  it('linux：允许网络时不加 --unshare-net', () => {
    const args = buildBwrapArgs({
      python,
      scriptPath: script,
      tmpDir,
      allowNetwork: true,
      existsSync: existsAll,
    });
    expect(args).not.toContain('--unshare-net');
  });

  it('linux：无 bwrap → fallback 裸 python -I', () => {
    const plan = planPythonSandbox({
      python,
      scriptPath: script,
      tmpDir,
      platform: 'linux',
      bwrapPath: null,
    });
    expect(plan).toMatchObject({
      cmd: python,
      args: ['-I', script],
      isolation: 'fallback',
    });
    expect(plan.reason).toMatch(/bwrap/i);
  });

  it('darwin：sandbox-exec + Seatbelt profile 禁网', () => {
    const plan = planPythonSandbox({
      python,
      scriptPath: script,
      tmpDir,
      platform: 'darwin',
      sandboxExecPath: '/usr/bin/sandbox-exec',
    });
    expect(plan.isolation).toBe('sandbox-exec');
    expect(plan.cmd).toBe('/usr/bin/sandbox-exec');
    expect(plan.args[0]).toBe('-p');
    const profile = plan.args[1];
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain(`(subpath "${tmpDir}")`);
    expect(plan.args.slice(2)).toEqual([python, '-I', script]);
  });

  it('darwin：无 sandbox-exec → fallback', () => {
    const plan = planPythonSandbox({
      python,
      scriptPath: script,
      tmpDir,
      platform: 'darwin',
      sandboxExecPath: null,
    });
    expect(plan.isolation).toBe('fallback');
    expect(plan.cmd).toBe(python);
  });

  it('win32：isolation none，无 FS jail', () => {
    const plan = planPythonSandbox({
      python: 'python',
      scriptPath: 'C:\\\\tmp\\\\main.py',
      tmpDir: 'C:\\\\tmp',
      platform: 'win32',
    });
    expect(plan.isolation).toBe('none');
    expect(plan.reason).toMatch(/windows/i);
  });

  it('buildSeatbeltProfile：允许网络时放行 network*', () => {
    const p = buildSeatbeltProfile({ tmpDir, python, allowNetwork: true });
    expect(p).toContain('(allow network*)');
    expect(p).not.toContain('(deny network*)');
  });
});
