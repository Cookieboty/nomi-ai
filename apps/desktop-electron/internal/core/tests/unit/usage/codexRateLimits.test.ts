jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';

import {
  CODEX_APP_SERVER_ARGS,
  CodexRateLimitReader,
  isCodexAuthError,
  mapCodexRateLimits,
} from '../../../src/usage/codexRateLimits';

import { fakeServer, type Handler } from './fakeCodexServer';

const SALT = 'a'.repeat(32);
const NOW = Date.parse('2026-10-16T02:00:00Z');
const EMAIL = 'someone@example.com';
const ACCOUNT = 'acct-secret-123';

const RATE_RESULT = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_792_137_600 },
    secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1_792_700_000 },
    planType: 'plus',
    credits: { hasCredits: true, unlimited: false, balance: '12.50' },
  },
  rateLimitsByLimitId: null,
  accountId: ACCOUNT,
  email: EMAIL, // 假设服务端多给了邮箱：必须被丢弃
};

const happy: Handler = (m, reply) => {
  if (m.method === 'initialize') {
    // 握手前先来一条通知（真实 app-server 会这样）：必须被忽略
    reply({ method: 'remoteControl/status/changed', params: { installationId: 'inst-secret' } });
    reply({ id: m.id, result: { userAgent: 'x', codexHome: '/home/u/.codex' } });
  } else if (m.method === 'account/rateLimits/read') {
    reply({ id: m.id, result: RATE_RESULT });
  }
};

const mk = (srv: ReturnType<typeof fakeServer>, extra = {}) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-codex-test-'));
  return {
    tmpRoot,
    reader: new CodexRateLimitReader({
      resolveBin: async () => '/fake/codex',
      spawnFn: srv.spawnFn as never,
      env: () => ({ PATH: '/bin' }),
      tmpRoot,
      now: () => NOW,
      salt: () => SALT,
      timeoutMs: 400,
      ...extra,
    }),
  };
};

describe('mapCodexRateLimits：只取百分比 / 窗口 / 重置 / 套餐', () => {
  it('映射 primary / secondary（秒 → 毫秒）、套餐、指纹；邮箱 / 账号 id / 积分不会出现在结果里', () => {
    const m = mapCodexRateLimits(RATE_RESULT, NOW, SALT)!;
    expect(m.reading).toEqual({
      windows: [
        { id: 'primary', usedPercent: 37, windowMinutes: 300, resetAt: 1_792_137_600_000 },
        { id: 'secondary', usedPercent: 8, windowMinutes: 10080, resetAt: 1_792_700_000_000 },
      ],
      updatedAt: NOW,
      origin: 'app-server',
      plan: 'Plus',
    });
    const dump = JSON.stringify(m);
    expect(dump).not.toContain(EMAIL);
    expect(dump).not.toContain(ACCOUNT);
    expect(dump).not.toContain('12.50');
    expect(m.identity).toMatch(/^[0-9a-f]{16}$/);
  });

  it('优先 rateLimitsByLimitId.codex；窗口字段缺失 / 为 null 的丢掉；全空返回 null', () => {
    const m = mapCodexRateLimits(
      {
        rateLimits: { primary: { usedPercent: 1 } },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 50, windowDurationMins: null, resetsAt: null },
            secondary: null,
          },
        },
      },
      NOW,
      SALT,
    )!;
    expect(m.reading.windows).toEqual([{ id: 'primary', usedPercent: 50 }]);
    expect(m.identity).toBeNull();
    expect(
      mapCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, NOW, SALT),
    ).toBeNull();
    expect(mapCodexRateLimits(null, NOW, SALT)).toBeNull();
    expect(mapCodexRateLimits({}, NOW, SALT)).toBeNull();
  });

  it('planType unknown 不展示；百分比封顶 100', () => {
    const m = mapCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 140 }, planType: 'unknown' } },
      NOW,
      SALT,
    )!;
    expect(m.reading.windows[0]!.usedPercent).toBe(100);
    expect(m.reading.plan).toBeUndefined();
  });
});

describe('isCodexAuthError', () => {
  it('官方未登录 / API Key 账号的错误文案属于认证类', () => {
    expect(
      isCodexAuthError(-32600, 'codex account authentication required to read rate limits'),
    ).toBe(true);
    expect(isCodexAuthError(-32600, 'chatgpt authentication required to read rate limits')).toBe(
      true,
    );
    expect(isCodexAuthError(-32603, 'internal error')).toBe(false);
  });
});

describe('CodexRateLimitReader：app-server 流程（mock）', () => {
  it('握手顺序：initialize → initialized → account/rateLimits/read；不开 thread、不读 account、不发对话', async () => {
    const srv = fakeServer(happy);
    const { reader } = mk(srv);
    const out = await reader.fetch();
    expect(out).toMatchObject({ kind: 'ok', reading: { plan: 'Plus', origin: 'app-server' } });
    expect(srv.sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    expect(srv.sent[0]).toMatchObject({
      id: 1,
      params: { clientInfo: { name: 'nomi_usage' } },
    });
    expect(srv.sent[1]).not.toHaveProperty('id'); // 通知没有 id
    expect(srv.sent[2]).not.toHaveProperty('params'); // 不传任何参数
  });

  it('受限启动：read-only、不审批、关分析；cwd 是临时目录并在结束后清理；stderr 丢弃；用完关 stdin 并终止', async () => {
    const srv = fakeServer(happy);
    const { reader, tmpRoot } = mk(srv);
    await reader.fetch();
    const [file, args, opts] = srv.spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; stdio: unknown[]; env: Record<string, string> },
    ];
    expect(file).toBe('/fake/codex');
    expect(args).toEqual(CODEX_APP_SERVER_ARGS);
    expect(args.slice(0, 4)).toEqual(['-s', 'read-only', '-a', 'never']);
    expect(args[args.length - 1]).toBe('app-server');
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(path.dirname(opts.cwd)).toBe(tmpRoot);
    expect(fs.existsSync(opts.cwd)).toBe(false);
    expect((srv.child.stdin as Writable).writableEnded).toBe(true);
    expect(srv.child.kill).toHaveBeenCalled();
  });

  it('未登录：认证类错误（-32600 authentication required）', async () => {
    const srv = fakeServer((m, reply) => {
      if (m.method === 'initialize') reply({ id: m.id, result: {} });
      if (m.method === 'account/rateLimits/read')
        reply({
          id: m.id,
          error: {
            code: -32600,
            message: 'codex account authentication required to read rate limits',
          },
        });
    });
    expect(await mk(srv).reader.fetch()).toEqual({ kind: 'auth', reason: 'not-signed-in' });
  });

  it('API Key 账号：chatgpt authentication required → api-account（认证类）', async () => {
    const srv = fakeServer((m, reply) => {
      if (m.method === 'initialize') reply({ id: m.id, result: {} });
      if (m.method === 'account/rateLimits/read')
        reply({
          id: m.id,
          error: { code: -32600, message: 'chatgpt authentication required to read rate limits' },
        });
    });
    expect(await mk(srv).reader.fetch()).toEqual({ kind: 'auth', reason: 'api-account' });
  });

  it('其它 RPC 错误：暂时性（bad-output）', async () => {
    const srv = fakeServer((m, reply) => {
      if (m.method === 'initialize') reply({ id: m.id, result: {} });
      else if (m.method === 'account/rateLimits/read')
        reply({ id: m.id, error: { code: -32603, message: 'upstream 502' } });
    });
    expect(await mk(srv).reader.fetch()).toEqual({ kind: 'transient', reason: 'bad-output' });
  });

  it('超时：服务端不回应 → timeout，并终止进程', async () => {
    const srv = fakeServer((m, reply) => {
      if (m.method === 'initialize') reply({ id: m.id, result: {} });
      // account/rateLimits/read 永不回应
    });
    const out = await mk(srv, { timeoutMs: 150 }).reader.fetch();
    expect(out).toEqual({ kind: 'transient', reason: 'timeout' });
    expect(srv.child.kill).toHaveBeenCalled();
  });

  it('输出上限：单行 / 总量超过 256KB → output-limit', async () => {
    const srv = fakeServer((m, reply) => {
      if (m.method === 'initialize') reply('x'.repeat(300 * 1024));
    });
    const out = await mk(srv, { timeoutMs: 2000 }).reader.fetch();
    expect(out).toEqual({ kind: 'transient', reason: 'output-limit' });
  });

  it('额度字段全空 → no-limits（暂时性）', async () => {
    const srv = fakeServer((m, reply) => {
      if (m.method === 'initialize') reply({ id: m.id, result: {} });
      else if (m.method === 'account/rateLimits/read')
        reply({ id: m.id, result: { rateLimits: { primary: null, secondary: null } } });
    });
    expect(await mk(srv).reader.fetch()).toEqual({ kind: 'transient', reason: 'no-limits' });
  });

  it('进程提前退出 / 非 JSON 行 / 没有 codex：都安静降级', async () => {
    const srv = fakeServer((m, reply) => {
      reply('this is a log line, not json');
      if (m.method === 'initialize') srv.child.emit('close', 1);
    });
    expect(await mk(srv).reader.fetch()).toEqual({ kind: 'transient', reason: 'spawn-failed' });

    const none = new CodexRateLimitReader({
      resolveBin: async () => null,
      salt: () => SALT,
    });
    expect(await none.fetch()).toEqual({ kind: 'transient', reason: 'not-installed' });

    const srv2 = fakeServer(happy);
    srv2.spawnFn.mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    expect(await mk(srv2).reader.fetch()).toEqual({ kind: 'transient', reason: 'not-installed' });
  });

  it('日志 / 结果里不记录原始输出：邮箱、账号 id、通知里的 installationId 不会出现在返回值中', async () => {
    const srv = fakeServer(happy);
    const out = await mk(srv).reader.fetch();
    const dump = JSON.stringify(out);
    for (const secret of [EMAIL, ACCOUNT, 'inst-secret', '/home/u/.codex'])
      expect(dump).not.toContain(secret);
  });
});

describe('真实子进程（假的 codex 脚本）', () => {
  it('脚本经 stdio 走完握手；结束后进程退出', async () => {
    // 假 CLI 脚本靠 shebang + 可执行位启动，仅 POSIX 可用
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-fakecodex-'));
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(
      bin,
      `#!${process.execPath}
let buf='';
process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
 if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:21,windowDurationMins:300,resetsAt:1792137600},planType:'pro'}}}));}});
process.stdin.on('end',()=>process.exit(0));`,
      { mode: 0o755 },
    );
    const reader = new CodexRateLimitReader({
      resolveBin: async () => bin,
      env: () => ({ ...process.env }),
      salt: () => SALT,
      now: () => NOW,
      timeoutMs: 5000,
    });
    const out = await reader.fetch();
    expect(out).toMatchObject({
      kind: 'ok',
      reading: { plan: 'Pro', windows: [{ id: 'primary', usedPercent: 21 }] },
    });
  });
});
