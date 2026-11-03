jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConnectionService, IDENTITY_TTL_MS } from '../../../src/connections/ConnectionService';
import {
  buildReadRequest,
  ghEnv,
  parseAuthStatus,
  wideScopes,
} from '../../../src/connections/github';

const authJson = (login: string, scopes = 'gist, read:org, repo, workflow', state = 'success') =>
  JSON.stringify({
    hosts: {
      'github.com': [
        { active: true, host: 'github.com', login, scopes, state, tokenSource: 'keyring' },
      ],
    },
  });

function setup(opts: { login?: string | null; installed?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-'));
  let login: string | null = opts.login === undefined ? 'octo' : opts.login;
  let clock = 1;
  const calls: string[][] = [];
  const fetched: { url: string; auth: string }[] = [];
  const svc = new ConnectionService({
    file: path.join(dir, 'connections.json'),
    secrets: {
      canEncrypt: () => true,
      encrypt: (v) => `enc:${Buffer.from(v).toString('base64')}`,
      decrypt: (v) => (v?.startsWith('enc:') ? Buffer.from(v.slice(4), 'base64').toString() : ''),
    },
    events: { publish: () => undefined },
    logger: { warn: () => undefined },
    now: () => clock,
    runGh: async (args) => {
      calls.push(args);
      if (opts.installed === false) return { stdout: '', code: 127 };
      if (args[0] === 'auth')
        return { stdout: login ? authJson(login) : JSON.stringify({ hosts: {} }), code: 0 };
      if (args[0] === 'api') {
        const p = args[args.length - 1]!;
        if (p.startsWith('/notifications'))
          return {
            stdout: JSON.stringify([
              { id: '1', repository: { full_name: 'o/r' } },
              { id: '2', repository: { full_name: 'x/y' } },
            ]),
            code: 0,
          };
        return { stdout: JSON.stringify({ path: p }), code: 0 };
      }
      return { stdout: '', code: 1 };
    },
    fetch: async (url, init) => {
      fetched.push({ url, auth: init.headers.Authorization! });
      return {
        ok: init.headers.Authorization === 'Bearer good',
        status: init.headers.Authorization === 'Bearer good' ? 200 : 401,
        headers: { get: (n: string) => (n === 'x-oauth-scopes' ? null : null) },
        json: async () => (url.endsWith('/user') ? { login: 'tok-user' } : { url }),
      };
    },
  });
  return {
    dir,
    svc,
    calls,
    fetched,
    setLogin: (l: string | null) => (login = l),
    advance: (ms: number) => (clock += ms),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('GitHub 适配器', () => {
  it('解析 gh auth status（不含令牌），标出宽权限', () => {
    const a = parseAuthStatus(authJson('octo'));
    expect(a).toEqual([
      {
        host: 'github.com',
        login: 'octo',
        scopes: ['gist', 'read:org', 'repo', 'workflow'],
        tokenSource: 'keyring',
        active: true,
        state: 'success',
      },
    ]);
    expect(wideScopes(a[0]!.scopes)).toEqual(['repo', 'workflow']);
    expect(wideScopes(['read:org', 'admin:org'])).toEqual(['admin:org']);
    expect(parseAuthStatus('not json')).toEqual([]);
  });

  it('只拼模板内的请求，拒绝注入', () => {
    expect(buildReadRequest({ endpoint: 'issues', repo: 'o/r', state: 'open' })).toEqual({
      path: '/repos/o/r/issues',
      query: { per_page: '50', state: 'open' },
    });
    expect(buildReadRequest({ endpoint: 'check_runs', repo: 'o/r', ref: 'main' }).path).toBe(
      '/repos/o/r/commits/main/check-runs',
    );
    for (const bad of [
      { endpoint: 'repo', repo: '../../user' },
      { endpoint: 'repo', repo: 'o/r?x=1' },
      { endpoint: 'issue', repo: 'o/r', number: -1 },
      { endpoint: 'issues', repo: 'o/r', since: 'yesterday' },
      { endpoint: 'check_runs', repo: 'o/r', ref: 'a b' },
    ] as const)
      expect(() => buildReadRequest(bad as never)).toThrow('invalid');
  });

  it('子进程环境不带任何令牌变量，关交互', () => {
    const env = ghEnv({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', SECRET: 'z' });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1',
    });
  });
});

describe('ConnectionService', () => {
  it('复用 gh 登录：记下账号与宽权限；没装 / 没登录时报错', async () => {
    const h = setup();
    const c = await h.svc.addGithub({ mode: 'gh' });
    expect(c).toMatchObject({
      label: 'GitHub · octo',
      auth: { kind: 'cli-login', cli: 'gh', host: 'github.com' },
      account: { login: 'octo' },
      wideScopes: ['repo', 'workflow'],
      status: 'ok',
    });
    expect(h.calls[0]).toEqual([
      'auth',
      'status',
      '--json',
      'hosts',
      '--no-refresh',
      '--hostname',
      'github.com',
    ]);
    expect(h.calls.flat()).not.toContain('token');
    h.done();
    await expect(setup({ installed: false }).svc.addGithub({ mode: 'gh' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(setup({ login: null }).svc.addGithub({ mode: 'gh' })).rejects.toMatchObject({
      code: 'needs_login',
    });
  });

  it('前台只读；后台按授权的连接 / 能力 / 仓库收窄；通知只留授权仓库', async () => {
    const h = setup();
    const c = await h.svc.addGithub({ mode: 'gh' });
    expect(await h.svc.githubRead({ endpoint: 'repo', repo: 'any/repo' }, null)).toEqual({
      path: '/repos/any/repo',
    });
    const grant = [{ connectionId: c.id, capabilities: ['github.read'], resources: ['o/r'] }];
    expect(await h.svc.githubRead({ endpoint: 'issues', repo: 'O/R' }, grant)).toEqual({
      path: '/repos/O/R/issues?per_page=50',
    });
    await expect(
      h.svc.githubRead({ endpoint: 'issues', repo: 'x/y' }, grant),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(
      h.svc.githubRead({ endpoint: 'issues', repo: 'o/r' }, [{ ...grant[0]!, capabilities: [] }]),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(h.svc.githubRead({ endpoint: 'issues', repo: 'o/r' }, [])).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await h.svc.githubRead({ endpoint: 'notifications' }, grant)).toEqual([
      { id: '1', repository: { full_name: 'o/r' } },
    ]);
    h.done();
  });

  it('换了账号 / 登出：needs_login，之后的调用拒绝（不悄悄换账号）', async () => {
    const h = setup();
    const c = await h.svc.addGithub({ mode: 'gh' });
    h.setLogin('someone-else');
    expect((await h.svc.check(c.id)).status).toBe('needs_login');
    await expect(h.svc.githubRead({ endpoint: 'repo', repo: 'o/r' }, null)).rejects.toMatchObject({
      code: 'not_found',
    });
    h.setLogin('octo');
    expect((await h.svc.check(c.id)).status).toBe('ok');
    h.done();
  });

  it('执行前复核 gh 当前账号：没手动复核也拒绝，不用别的身份发请求（#233）', async () => {
    const h = setup();
    const c = await h.svc.addGithub({ mode: 'gh' });
    const grant = [
      { connectionId: c.id, capabilities: ['github.read', 'github.comment'], resources: ['o/r'] },
    ];
    const apiCalls = () => h.calls.filter((a) => a[0] === 'api').length;
    h.setLogin('someone-else');
    // 写：每次发送前都复核（即使刚检查过）
    await expect(
      h.svc.githubWrite('github.comment', { repo: 'o/r', number: 1, body: 'hi' }, null, null),
    ).rejects.toMatchObject({ code: 'needs_login' });
    expect(apiCalls()).toBe(0);
    expect(h.svc.get(c.id)!.status).toBe('needs_login');
    // 换回原账号：复核过就能读；读在短时间内沿用复核结果
    h.setLogin('octo');
    await h.svc.check(c.id);
    await h.svc.githubRead({ endpoint: 'repo', repo: 'o/r', connectionId: c.id }, grant);
    expect(apiCalls()).toBe(1);
    // 过了缓存时间再切账号：读也拒绝
    h.setLogin('someone-else');
    h.advance(IDENTITY_TTL_MS + 1);
    await expect(
      h.svc.githubRead({ endpoint: 'repo', repo: 'o/r', connectionId: c.id }, grant),
    ).rejects.toMatchObject({ code: 'needs_login' });
    expect(apiCalls()).toBe(1);
    h.done();
  });

  it('粘贴令牌：加密保存、列表不带密钥；坏令牌拒绝；请求在内核里带上认证头', async () => {
    const h = setup();
    await expect(h.svc.addGithub({ mode: 'token', token: 'bad' })).rejects.toMatchObject({
      code: 'needs_login',
    });
    const c = await h.svc.addGithub({ mode: 'token', token: ' good ' });
    expect(c).toMatchObject({ auth: { kind: 'keychain' }, account: { login: 'tok-user' } });
    expect(JSON.stringify(h.svc.list())).not.toContain('good');
    const raw = fs.readFileSync(path.join(h.dir, 'connections.json'), 'utf8');
    expect(raw).not.toContain('"good"');
    expect(raw).toContain('enc:');
    await h.svc.githubRead({ endpoint: 'repo', repo: 'o/r', connectionId: c.id }, null);
    expect(h.fetched.at(-1)).toEqual({
      url: 'https://api.github.com/repos/o/r',
      auth: 'Bearer good',
    });
    expect(h.svc.remove(c.id)).toBe(true);
    h.done();
  });

  it('github_read 工具：取后台授权、成功后标外部内容、错误带码', async () => {
    const h = setup();
    const c = await h.svc.addGithub({ mode: 'gh' });
    const marked: unknown[] = [];
    const grant = [{ connectionId: c.id, capabilities: ['github.read'], resources: ['o/r'] }];
    const [tool] = h.svc.tools({ grantOf: () => grant, markRead: (s) => marked.push(s ?? 'none') });
    expect(tool!.name).toBe('github_read');
    expect(await tool!.execute({ endpoint: 'repo', repo: 'o/r' }, {})).toEqual({
      ok: true,
      data: { path: '/repos/o/r' },
    });
    expect(marked).toHaveLength(1);
    expect(await tool!.execute({ endpoint: 'repo', repo: 'x/y' }, {})).toMatchObject({
      ok: false,
      error: { code: 'not_allowed' },
    });
    h.done();
  });
});

describe('应用与账号：重复添加、替换 / 保留、gh 换账号', () => {
  it('gh 登录每个主机只能接一条', async () => {
    const h = setup();
    await h.svc.addGithub({ mode: 'gh' });
    await expect(h.svc.addGithub({ mode: 'gh' })).rejects.toMatchObject({ code: 'duplicate' });
    expect(h.svc.list()).toHaveLength(1);
    h.done();
  });

  it('同一账号的令牌：不说怎么办就报重复；替换保留 id；保留两个带名字', async () => {
    const h = setup();
    const first = await h.svc.addGithub({ mode: 'token', token: 'good' });
    await expect(h.svc.addGithub({ mode: 'token', token: 'good' })).rejects.toMatchObject({
      code: 'duplicate',
    });
    const kept = await h.svc.addGithub({
      mode: 'token',
      token: 'good',
      onDuplicate: 'keep',
      name: '只读',
    });
    expect(kept.id).not.toBe(first.id);
    expect(kept.label).toBe('GitHub · tok-user（只读）');
    const replaced = await h.svc.addGithub({
      mode: 'token',
      token: 'good',
      onDuplicate: 'replace',
    });
    expect(replaced.id).toBe(first.id);
    expect(h.svc.list()).toHaveLength(2);
    h.done();
  });

  it('gh 换了账号：复核记下当前账号；改用后连接 id 不变、状态恢复', async () => {
    const h = setup();
    const c = await h.svc.addGithub({ mode: 'gh' });
    h.setLogin('mona');
    const checked = await h.svc.check(c.id);
    expect(checked).toMatchObject({ status: 'needs_login', currentLogin: 'mona' });
    const rebound = await h.svc.rebind(c.id);
    expect(rebound).toMatchObject({ id: c.id, status: 'ok', label: 'GitHub · mona' });
    expect(rebound.currentLogin).toBeUndefined();
    h.done();
  });
});
