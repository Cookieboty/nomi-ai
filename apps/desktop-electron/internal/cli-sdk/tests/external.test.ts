import { describe, expect, it } from 'vitest';

import {
  externalManifest,
  missingExternalEnv,
  normalizeExternalSpec,
  probeAcp,
  renderExternalArgs,
  validateExternalSpec,
  validateManifest,
  type ExternalCliSpec,
} from '../src';

import { FakeChild } from './fakeChild';

const base: ExternalCliSpec = {
  version: 1,
  id: 'my-agent',
  displayName: 'My Agent',
  command: '/usr/local/bin/my-agent',
  args: ['acp', '--cwd', '{cwd}'],
  env: ['MY_AGENT_HOME'],
};

describe('外部插件清单（L1，§5.9）', () => {
  it('合法清单通过；生成的插件清单也通过插件契约校验', () => {
    expect(validateExternalSpec(base, ['claude'])).toEqual([]);
    const m = externalManifest(base);
    expect(validateManifest(m)).toEqual([]);
    expect(m).toMatchObject({
      transport: 'acp',
      capabilities: { officialAccount: false, thirdParty: false, usageQuota: false },
      modelSwitch: 'restart',
    });
    expect(m.capabilities.permissionModes).toEqual([{ mode: 'manual' }]);
  });

  it('不能占用内置 id；id、命令、参数、环境变量名都有约束', () => {
    expect(validateExternalSpec({ ...base, id: 'claude' }, ['claude'])).toContain(
      'id claude is reserved by a built-in plugin',
    );
    expect(validateExternalSpec({ ...base, id: 'Bad Id' })).toContain(
      'id must match [a-z0-9][a-z0-9-]{0,39}',
    );
    expect(validateExternalSpec({ ...base, command: 'a\nrm -rf /' })).toContain(
      'command must not contain control characters',
    );
    expect(validateExternalSpec({ ...base, command: '{home}/bin/x' })).toContain(
      'command must not contain placeholders',
    );
    expect(validateExternalSpec({ ...base, args: ['{token}'] })).toContain(
      'args[0] uses unknown placeholder {token}',
    );
    // 只能写变量名，写成 NAME=value 的直接拒绝（值从不保存）
    expect(validateExternalSpec({ ...base, env: ['KEY=secret'] })).toContain(
      'env[0] must be an environment variable name (no values)',
    );
    expect(validateExternalSpec({ ...base, shell: true })).toContain('unknown field shell');
    expect(validateExternalSpec(null)).toEqual(['spec must be an object']);
  });

  it('参数模板只替换占位符，不二次展开，也不经 shell', () => {
    expect(
      renderExternalArgs(['--dir={cwd}', '{home}', '$(whoami)', '{x}'], {
        cwd: '/w/{home}; rm',
        home: '/h',
      }),
    ).toEqual(['--dir=/w/{home}; rm', '/h', '$(whoami)', '{x}']);
  });

  it('缺少的环境变量名；规范化去重', () => {
    expect(missingExternalEnv(base, {})).toEqual(['MY_AGENT_HOME']);
    expect(missingExternalEnv(base, { MY_AGENT_HOME: '/x' })).toEqual([]);
    expect(normalizeExternalSpec({ ...base, displayName: '  A  ', env: ['X', 'X'] })).toMatchObject(
      { displayName: 'A', env: ['X'] },
    );
  });
});

describe('ACP 试运行（只握手）', () => {
  it('读出身份与能力，之后结束进程；不建会话', async () => {
    const child = new FakeChild();
    child.onLine = (msg) => {
      if (msg.method === 'initialize')
        child.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'mock-acp', version: '0.1.0' },
            agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
            authMethods: [{ id: 'oauth', name: 'Sign in' }],
          },
        });
    };
    const r = await probeAcp(child);
    expect(r).toEqual({
      protocolVersion: 1,
      agent: { name: 'mock-acp', version: '0.1.0' },
      capabilities: { loadSession: true, images: false, audio: false, embeddedContext: false },
      authMethods: ['Sign in'],
    });
    expect(child.messages().map((m) => m.method)).toEqual(['initialize']);
    expect(child.stdin.writable).toBe(false);
  });

  it('不说 ACP 的进程：超时报错并结束进程', async () => {
    const child = new FakeChild();
    await expect(probeAcp(child, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
    expect(child.stdin.writable).toBe(false);
  });
});
