/**
 * 官方账号 = 账号目录（docs/design/cli-plugin-architecture.md §5.10）：Nomi 不收集、不存储、不中转凭据；
 * 默认账号取代全局切换；多个账号并行；旧保险箱迁移。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AccountService, localAccountId } from '../../../src/cli/accounts/AccountService';
import { claudeKeychainService } from '../../../src/cli/accounts/adapters';
import { canonicalDir, HOME_ENV } from '../../../src/cli/accounts/homes';
import type { AccountKind } from '../../../src/cli/accounts/types';
import { createRecordingAppEvents } from '../../../src/core/appEvents';
import { whenPrivateWritesIdle } from '../../../src/utils/privateFile';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 一个假的用户 HOME：各 CLI 的用户级配置（含会改路由的 env） */
function userHome(): string {
  const home = tmp('acct-home-');
  const w = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  };
  w(
    '.claude/settings.json',
    JSON.stringify({
      theme: 'dark',
      apiKeyHelper: 'echo key',
      env: { ANTHROPIC_BASE_URL: 'http://relay', ANTHROPIC_AUTH_TOKEN: 'x', MY_FLAG: '1' },
    }),
  );
  w('.claude/projects/p1/s.jsonl', '{}\n');
  w('.claude/skills/s/SKILL.md', '# s');
  w(
    '.claude.json',
    JSON.stringify({
      oauthAccount: { emailAddress: 'me@local' },
      mcpServers: { a: { command: 'x' } },
      projects: { '/w': { hasTrustDialogAccepted: true } },
      theme: 'dark',
    }),
  );
  w('.codex/config.toml', 'model = "gpt-5"\n');
  w('.codex/sessions/2026/x.jsonl', '{}\n');
  w('.grok/config.toml', '');
  return home;
}

function mk(
  o: {
    inUse?: number;
    logout?: jest.Mock;
    platform?: NodeJS.Platform;
    live?: 'idle' | 'busy' | 'unknown';
  } = {},
) {
  const home = userHome();
  const root = tmp('acct-root-');
  const changed: AccountKind[] = [];
  const keychain = { get: jest.fn(), set: jest.fn(), remove: jest.fn(async () => undefined) };
  const liveState = o.live ?? 'idle';
  const svc = new AccountService({
    events: createRecordingAppEvents(),
    root,
    logger: { info() {}, warn() {} },
    env: { USER: 'tester', PATH: process.env.PATH } as NodeJS.ProcessEnv,
    home,
    platform: o.platform ?? 'linux',
    keychain: keychain as never,
    onDefaultChanged: (k) => changed.push(k),
    inUse: () => o.inUse ?? 0,
    liveProcesses: async () =>
      liveState === 'busy'
        ? { state: 'busy' as const, pids: [42] }
        : liveState === 'unknown'
          ? { state: 'unknown' as const }
          : { state: 'idle' as const, pids: [] },
    logout: o.logout ?? jest.fn(async () => undefined),
    identity: {
      // CLI 状态命令的替身（真实实现调用 `claude auth status --json` 等）
      run: async (kind, _args, env) => {
        const dir = env[HOME_ENV[kind]];
        if (kind === 'claude' && dir && fs.existsSync(path.join(dir, 'logged-in')))
          return {
            code: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              email: fs.readFileSync(path.join(dir, 'logged-in'), 'utf8'),
              subscriptionType: 'max',
            }),
          };
        if (kind === 'codex' && dir && fs.existsSync(path.join(dir, 'logged-in')))
          return { code: 0, stdout: 'Logged in using ChatGPT' };
        return { code: 1, stdout: kind === 'claude' ? '{"loggedIn":false}' : 'Not logged in' };
      },
      grokAuth: async () => null,
    },
  });
  return { svc, home, root, changed, keychain };
}

describe('AccountService（账号目录）', () => {
  it('每个 CLI 都有「本机登录」，默认账号就是它', () => {
    const { svc } = mk();
    for (const kind of ['claude', 'codex', 'grok', 'gemini'] as const) {
      const list = svc.list(kind);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: localAccountId(kind), local: true, active: true });
    }
  });

  it('新建账号：建好账号目录，共享会话历史等，生成的配置不含路由与鉴权键（S3、S9、S11）', () => {
    const { svc, home } = mk();
    const a = svc.create('claude');
    const dir = svc.officialLaunch('claude', a.id).dir!;
    expect(dir).toBe(canonicalDir(dir));
    // 共享：会话历史、技能
    expect(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(dir, 'projects'))).toBe(
      fs.realpathSync(path.join(home, '.claude', 'projects')),
    );
    expect(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink()).toBe(true);
    // 私有：实例记录、凭据都不链
    for (const n of ['.credentials.json', 'sessions', 'ide', 'statsig'])
      expect(fs.existsSync(path.join(dir, n))).toBe(false);
    // settings.json 是副本：去掉 env 里的路由与鉴权键和 apiKeyHelper，其余保留
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    expect(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(settings).toEqual({ theme: 'dark', env: { MY_FLAG: '1' } });
    // .claude.json：同步用户级的 MCP / 项目信任 / 主题，但不带用户的 oauthAccount
    const cj = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(cj.mcpServers).toEqual({ a: { command: 'x' } });
    expect(cj.projects).toEqual({ '/w': { hasTrustDialogAccepted: true } });
    expect(cj.oauthAccount).toBeUndefined();
  });

  it('启动前同步保留账号目录自己的身份字段（S11）', () => {
    const { svc } = mk();
    const a = svc.create('claude');
    const dir = svc.officialLaunch('claude', a.id).dir!;
    fs.writeFileSync(
      path.join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'work@x' } }),
    );
    svc.officialLaunch('claude', a.id);
    const cj = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
    expect(cj.oauthAccount).toEqual({ emailAddress: 'work@x' });
    expect(cj.mcpServers).toEqual({ a: { command: 'x' } });
  });

  it('启动注入：本机账号不设目录变量、保留用户自己的；指定账号设目录变量并关掉 Agent View', () => {
    const { svc } = mk();
    const local = svc.officialLaunch('claude', null);
    expect(local.env).toEqual({});
    expect(local.strip).toContain('ANTHROPIC_BASE_URL');
    expect(local.strip).not.toContain('CLAUDE_CONFIG_DIR');
    const a = svc.create('claude');
    const l = svc.officialLaunch('claude', a.id);
    expect(l.env.CLAUDE_CONFIG_DIR).toBe(l.dir);
    expect(l.env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe('1');
    expect(l.strip).toContain('CLAUDE_CONFIG_DIR');
    expect(l.sig).not.toBe(local.sig);
    const c = svc.create('codex');
    expect(svc.officialLaunch('codex', c.id).args).toEqual([
      '-c',
      'cli_auth_credentials_store="file"',
    ]);
    // 标签记的账号被删了：回到默认账号
    expect(svc.officialLaunch('claude', 'gone').sig).toBe(local.sig);
  });

  it('终端命令：设凭据目录变量再运行 CLI（Anthropic 文档的多账号用法），不含凭据', () => {
    const { svc } = mk();
    const a = svc.create('claude');
    const view = svc.list('claude').find((x) => x.id === a.id)!;
    const dir = svc.officialLaunch('claude', a.id).dir!;
    expect(view.terminalCommand).toBe(`CLAUDE_CONFIG_DIR='${dir}' claude`);
    expect(svc.list('claude').find((x) => x.local)?.terminalCommand).toBeUndefined();
    const win = mk({ platform: 'win32' });
    const w = win.svc.create('codex');
    expect(win.svc.list('codex').find((x) => x.id === w.id)?.terminalCommand).toMatch(
      /^\$env:CODEX_HOME='.+'; codex$/,
    );
  });

  it('默认账号：改了才通知编排层（只重启跟随默认的标签，S5）', () => {
    const { svc, changed } = mk();
    const a = svc.create('claude');
    svc.setDefault('claude', localAccountId('claude'));
    expect(changed).toEqual([]);
    svc.setDefault('claude', a.id);
    expect(changed).toEqual(['claude']);
    expect(svc.list('claude').find((x) => x.id === a.id)?.active).toBe(true);
    expect(svc.officialLaunch('claude', null).sig).toBe(`official:${a.id}`);
    expect(() => svc.setDefault('codex', a.id)).toThrow();
  });

  it('身份：用 CLI 自己的状态命令读，不读凭据（S7）；同一身份登录在两处时提示（S10）', async () => {
    const { svc } = mk();
    const a = svc.create('claude');
    const b = svc.create('claude');
    const dirA = svc.officialLaunch('claude', a.id).dir!;
    const dirB = svc.officialLaunch('claude', b.id).dir!;
    fs.writeFileSync(path.join(dirA, 'logged-in'), 'work@x');
    fs.writeFileSync(path.join(dirB, 'logged-in'), 'work@x');
    const va = await svc.refresh(a.id);
    expect(va).toMatchObject({
      loggedIn: true,
      label: 'work@x',
      identity: { email: 'work@x', plan: 'max' },
    });
    const vb = await svc.refresh(b.id);
    expect(vb.duplicateOf).toBe('work@x');
    expect(svc.identityKey('claude', a.id)).toBe('work@x');
  });

  it('删除：liveProcesses unknown 未 force 时拒绝；force 后删除', async () => {
    const s = mk({ live: 'unknown' });
    const a = s.svc.create('codex', 'X');
    const dir = s.svc.officialLaunch('codex', a.id).dir!;
    await expect(s.svc.remove(a.id)).rejects.toThrow(/无法确认|强制删除/);
    expect(fs.existsSync(dir)).toBe(true);
    await s.svc.remove(a.id, { force: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('删除：本机登录不能删；有标签在用不能删；否则在目录里登出、删钥匙串条目、删目录，默认账号回到本机', async () => {
    const logout = jest.fn(async () => undefined);
    const t = mk({ logout, platform: 'darwin' });
    await expect(t.svc.remove(localAccountId('claude'))).rejects.toThrow();
    const a = t.svc.create('claude');
    const dir = t.svc.officialLaunch('claude', a.id).dir!;
    fs.writeFileSync(path.join(dir, 'logged-in'), 'work@x');
    await t.svc.refresh(a.id);
    t.svc.setDefault('claude', a.id);
    t.changed.length = 0;
    await t.svc.remove(a.id);
    expect(logout).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ CLAUDE_CONFIG_DIR: dir }),
    );
    expect(t.keychain.remove).toHaveBeenCalledWith(
      claudeKeychainService({ CLAUDE_CONFIG_DIR: dir }, dir),
      'tester',
    );
    expect(fs.existsSync(dir)).toBe(false);
    expect(t.svc.list('claude')).toHaveLength(1);
    expect(t.changed).toEqual(['claude']);

    const busy = mk({ inUse: 2 });
    const b = busy.svc.create('codex');
    await expect(busy.svc.remove(b.id)).rejects.toThrow(/2 个标签/);
  });

  it('会话归属（S9）：记下会话跑在哪个账号里，重启后还在；账号删除后不再标注', async () => {
    const { svc, root } = mk();
    const b = svc.create('claude', 'Work');
    svc.noteSession('claude', 's-local', null);
    svc.noteSession('claude', 's-work', b.id);
    expect(svc.sessionAccount('claude', 's-local')).toEqual({
      id: localAccountId('claude'),
      label: expect.any(String),
    });
    expect(svc.sessionAccount('claude', 's-work')).toEqual({ id: b.id, label: 'Work' });
    expect(svc.sessionAccount('codex', 's-work')).toBeUndefined();
    // 文件里只有会话 id → 账号 id
    await whenPrivateWritesIdle();
    const raw = fs.readFileSync(path.join(root, 'session-accounts.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      sessions: [
        ['claude:s-local', localAccountId('claude')],
        ['claude:s-work', b.id],
      ],
    });
    const again = new AccountService({
      events: createRecordingAppEvents(),
      root,
      logger: { info() {}, warn() {} },
    });
    expect(again.sessionAccount('claude', 's-work')?.id).toBe(b.id);
    await svc.remove(b.id);
    expect(svc.sessionAccount('claude', 's-work')).toBeUndefined();
  });

  it('旧保险箱：账号转成「需要重新登录」，凭据、备份、暂存目录全部删除（§5.10.9）', () => {
    const home = userHome();
    const root = tmp('acct-legacy-');
    fs.writeFileSync(
      path.join(root, 'codex.json'),
      JSON.stringify({
        accounts: [
          {
            id: 'old',
            label: '工作',
            identity: { key: 'k', email: 'w@x' },
            credEnc: 'CIPHER',
            createdAt: 1,
          },
        ],
        activeId: 'old',
      }),
    );
    fs.mkdirSync(path.join(root, 'backups', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backups', 'codex', '1.enc'), 'x');
    fs.mkdirSync(path.join(root, 'staging', 'abc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'staging', 'abc', 'auth.json'), '{"tokens":{}}');
    const svc = new AccountService({
      events: createRecordingAppEvents(),
      root,
      logger: { info() {}, warn() {} },
      home,
      env: {},
    });
    const list = svc.list('codex');
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      label: '工作',
      needsLogin: true,
      loggedIn: false,
      local: false,
    });
    expect(fs.existsSync(path.join(root, 'codex.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'staging'))).toBe(false);
    const stored = fs.readFileSync(path.join(root, 'accounts.json'), 'utf8');
    expect(stored).not.toMatch(/credEnc|CIPHER/);
  });

  it('旧保险箱解析失败：写可恢复 stub 并归档，不静默删除（§5.10.9）', () => {
    const home = userHome();
    const root = tmp('acct-legacy-bad-');
    fs.writeFileSync(
      path.join(root, 'claude.json'),
      '{not-json, "email":"recover@x.com", "label":"Recovered"}',
    );
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backups', 'x.enc'), 'x');
    const warns: unknown[] = [];
    const svc = new AccountService({
      events: createRecordingAppEvents(),
      root,
      logger: {
        info() {},
        warn(_m, d) {
          warns.push(d);
        },
      },
      home,
      env: {},
    });
    const list = svc.list('claude').filter((x) => !x.local);
    expect(
      list.some(
        (x) => x.needsLogin && /recover@x\.com|Recovered/.test(x.label + (x.identity?.email ?? '')),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, 'claude.json'))).toBe(false);
    const archived = fs.existsSync(path.join(root, 'vault-unreadable'))
      ? fs.readdirSync(path.join(root, 'vault-unreadable'))
      : [];
    expect(archived.length).toBeGreaterThan(0);
    // 有 stub 写出后才清 backups
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
  });

  it('旧保险箱写盘失败：保留保险箱与备份，不删（§5.10.9）', () => {
    const home = userHome();
    const root = tmp('acct-legacy-wfail-');
    fs.writeFileSync(
      path.join(root, 'codex.json'),
      JSON.stringify({
        accounts: [
          { label: 'Work', identity: { key: 'k', email: 'w@x' }, credEnc: 'CIPHER', createdAt: 1 },
        ],
      }),
    );
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(root, 'backups', '1.enc'), 'x');
    // 让 accounts.json 无法原子写（同名目录占位 → writeFileSync 失败）
    fs.mkdirSync(path.join(root, 'accounts.json'));
    const svc = new AccountService({
      events: createRecordingAppEvents(),
      root,
      logger: { info() {}, warn() {} },
      home,
      env: {},
    });
    void svc.list('codex');
    expect(fs.existsSync(path.join(root, 'codex.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'backups', '1.enc'))).toBe(true);
    // accounts.json 仍是占位目录，不是迁移写出的文件
    expect(fs.statSync(path.join(root, 'accounts.json')).isDirectory()).toBe(true);
  });
});

describe('S7：账号与用量模块不读凭据文件（静态检查）', () => {
  it('源码里没有读取凭据文件 / 钥匙串内容的调用', () => {
    const roots = ['../../../src/cli/accounts', '../../../src/usage'].map((r) =>
      path.resolve(__dirname, r),
    );
    const offenders: string[] = [];
    for (const dir of roots)
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        if (/readFileSync\([^)]*(\.credentials\.json|auth\.json|oauth_creds)/.test(src))
          offenders.push(f);
        if (/readText\([^)]*(\.credentials\.json|auth\.json|oauth_creds)/.test(src))
          offenders.push(f);
        if (/keychain\.get\(/.test(src)) offenders.push(f);
        // keychain.ts 只允许 dead stub / remove；禁止真正的 find-generic-password / add-generic-password
        if (
          f === 'keychain.ts' &&
          (/find-generic-password/.test(src) || /add-generic-password/.test(src))
        )
          offenders.push(f);
      }
    expect(offenders).toEqual([]);
  });
});
