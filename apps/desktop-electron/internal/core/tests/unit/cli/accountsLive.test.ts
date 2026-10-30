/**
 * 官方账号（docs/design/cli-plugin-architecture.md §5.10）：
 * - P2.7 删除账号前检查 Nomi 之外还在用账号目录的 CLI 进程；
 * - Codex 身份经官方 app-server 的 account/read（邮箱 / 套餐 / 账号 id），不读凭据。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AccountService } from '../../../src/cli/accounts/AccountService';
import { mapCodexAccount, readCodexAccount } from '../../../src/cli/accounts/codexAccount';
import { codexIdentity } from '../../../src/cli/accounts/identity';
import { liveProcesses, type LiveCheck } from '../../../src/cli/accounts/liveProcesses';
import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { fakeServer, type Handler } from '../usage/fakeCodexServer';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('liveProcesses（P2.7）', () => {
  it('Claude：没有 sessions 目录时按 idle（不改走 lsof）', async () => {
    const dir = tmp('live-claude-nosess-');
    expect(await liveProcesses('claude', dir, { alive: () => true, platform: 'win32' })).toEqual({
      state: 'idle',
    });
  });

  it('Claude：按 sessions/<pid>.json 里还活着的 pid 判断；*.key 不读', async () => {
    const dir = tmp('live-claude-');
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(path.join(dir, 'sessions', '111.json'), JSON.stringify({ pid: 111 }));
    fs.writeFileSync(path.join(dir, 'sessions', '222.json'), JSON.stringify({ pid: 222 }));
    fs.writeFileSync(path.join(dir, 'sessions', '333.abc.key'), 'secret');
    const seen: number[] = [];
    const alive = (pid: number) => (seen.push(pid), pid === 222);
    expect(await liveProcesses('claude', dir, { alive })).toEqual({ state: 'busy', pids: [222] });
    expect(seen.sort()).toEqual([111, 222]);
    expect(await liveProcesses('claude', dir, { alive: () => false })).toEqual({ state: 'idle' });
  });

  it('Codex / Grok / Gemini：看打开了账号目录私有文件的进程；查不了时 unknown', async () => {
    const dir = tmp('live-codex-');
    fs.mkdirSync(path.join(dir, '.gemini'));
    const openFiles = jest.fn(async () => [4242, process.pid]);
    expect(await liveProcesses('codex', dir, { openFiles })).toEqual({
      state: 'busy',
      pids: [4242],
    });
    await liveProcesses('gemini', dir, { openFiles });
    expect(openFiles).toHaveBeenLastCalledWith(path.join(dir, '.gemini'));
    expect(await liveProcesses('grok', dir, { openFiles: async () => null })).toEqual({
      state: 'unknown',
    });
    expect(await liveProcesses('grok', dir, { platform: 'win32' })).toEqual({ state: 'unknown' });
  });

  (process.platform === 'win32' ? it.skip : it)(
    '真实 lsof：另一个进程打开着账号目录里的文件 → busy',
    async () => {
      const dir = tmp('live-lsof-');
      const file = path.join(dir, 'state_5.sqlite');
      fs.writeFileSync(file, '');
      const child = spawn(
        process.execPath,
        ['-e', `require('fs').openSync(${JSON.stringify(file)}, 'r'); setTimeout(() => {}, 20000)`],
        { stdio: 'ignore' },
      );
      try {
        let r: LiveCheck = { state: 'idle' };
        for (let i = 0; i < 50 && r.state !== 'busy'; i++) {
          await new Promise((res) => setTimeout(res, 50));
          r = await liveProcesses('codex', dir);
        }
        if (r.state === 'unknown') return; // 没装 lsof 的环境
        expect(r).toEqual({ state: 'busy', pids: [child.pid] });
      } finally {
        child.kill();
      }
    },
  );
});

function mkService(live: LiveCheck, codexAccount?: jest.Mock) {
  const root = tmp('acct-live-root-');
  const home = tmp('acct-live-home-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  return new AccountService({
    events: createRecordingAppEvents(),
    root,
    logger: { info() {}, warn() {} },
    env: { USER: 'tester', PATH: process.env.PATH } as NodeJS.ProcessEnv,
    home,
    platform: 'linux',
    inUse: () => 0,
    logout: jest.fn(async () => undefined),
    liveProcesses: async () => live,
    identity: {
      run: async () => ({ code: 1, stdout: 'Not logged in' }),
      grokAuth: async () => null,
      ...(codexAccount ? { codexAccount } : {}),
    },
  });
}

describe('删除账号：终端里还有进程在用', () => {
  it('busy → 拒绝并给出进程号；unknown → 须 force，否则拒绝', async () => {
    const busy = mkService({ state: 'busy', pids: [101, 202] });
    const a = busy.create('claude');
    await expect(busy.remove(a.id)).rejects.toThrow(/101, 202/);
    expect(busy.list('claude').some((x) => x.id === a.id)).toBe(true);

    const unknown = mkService({ state: 'unknown' });
    const b = unknown.create('codex');
    const dir = unknown.officialLaunch('codex', b.id).dir!;
    await expect(unknown.remove(b.id)).rejects.toThrow(/无法确认|强制删除/);
    expect(fs.existsSync(dir)).toBe(true);
    await unknown.remove(b.id, { force: true });
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe('Codex 身份（app-server account/read）', () => {
  it('映射：ChatGPT 账号给邮箱 / 套餐；null = 未登录；API Key 没有订阅身份', () => {
    expect(
      mapCodexAccount({
        account: { type: 'chatgpt', email: 'Me@X.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({ loggedIn: true, email: 'Me@X.com', plan: 'plus' });
    expect(mapCodexAccount({ account: null, requiresOpenaiAuth: true })).toEqual({
      loggedIn: false,
    });
    expect(mapCodexAccount({ account: { type: 'apiKey' } })).toEqual({
      loggedIn: true,
      apiKey: true,
    });
    expect(mapCodexAccount('nope')).toBeNull();
    expect(
      codexIdentity({ loggedIn: true, email: 'Me@X.com', accountId: 'acct-9' }, true),
    ).toMatchObject({ key: 'me@x.com|acct-9', accountIdChecked: true });
  });

  it('握手 → account/read；要账号 id 时才读 rateLimits，额度数字丢弃；参数带账号目录的文件存储', async () => {
    const handler: Handler = (m, reply) => {
      if (m.method === 'initialize') return reply({ id: m.id, result: {} });
      if (m.method === 'account/read')
        return reply({
          id: m.id,
          result: { account: { type: 'chatgpt', email: 'w@x', planType: 'pro' } },
        });
      if (m.method === 'account/rateLimits/read')
        reply({ id: m.id, result: { accountId: 'acct-1', rateLimits: { primary: {} } } });
    };
    const once = async (withAccountId: boolean) => {
      const f = fakeServer(handler);
      const r = await readCodexAccount(
        { CODEX_HOME: '/acct/c' },
        ['-c', 'cli_auth_credentials_store="file"'],
        { withAccountId },
        { resolveBin: async () => '/fake/codex', spawnFn: f.spawnFn as never, timeoutMs: 2000 },
      );
      return { r, f };
    };
    const a = await once(false);
    expect(a.r).toEqual({ loggedIn: true, email: 'w@x', plan: 'pro' });
    expect(a.f.sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'account/read']);
    const spawnCall = (a.f.spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: object },
    ])!;
    expect(spawnCall[1].slice(0, 2)).toEqual(['-c', 'cli_auth_credentials_store="file"']);
    expect(spawnCall[2].env).toEqual({ CODEX_HOME: '/acct/c' });
    const b = await once(true);
    expect(b.r).toEqual({ loggedIn: true, email: 'w@x', plan: 'pro', accountId: 'acct-1' });
  });

  it('app-server 不回应：超时返回 null（调用方退回 login status）', async () => {
    const f = fakeServer(() => undefined);
    const r = await readCodexAccount(
      {},
      [],
      { withAccountId: false },
      { resolveBin: async () => '/fake/codex', spawnFn: f.spawnFn as never, timeoutMs: 50 },
    );
    expect(r).toBeNull();
  });

  it('账号服务：账号 id 只读一次并保留；会话的 creator_account_id 能对上；同邮箱两处登录提示（S10）', async () => {
    const codexAccount = jest.fn(
      async (_env: NodeJS.ProcessEnv, _args: readonly string[], o: { withAccountId: boolean }) => ({
        loggedIn: true,
        email: 'w@x',
        plan: 'pro',
        ...(o.withAccountId ? { accountId: 'acct-1' } : {}),
      }),
    );
    const svc = mkService({ state: 'idle' }, codexAccount);
    const a = svc.create('codex');
    await svc.refresh(a.id);
    await svc.refresh(a.id);
    expect(codexAccount.mock.calls.map((c) => c[2].withAccountId)).toEqual([true, false]);
    expect(svc.identityKey('codex', a.id)).toBe('w@x|acct-1');
    expect(svc.findByAccountId('codex', 'acct-1')?.id).toBe(a.id);
    const b = svc.create('codex');
    const vb = await svc.refresh(b.id);
    expect(vb.duplicateOf).toBe('w@x');
  });
});
