/**
 * 来源隔离（docs/design/cli-plugin-architecture.md §5.10.2、§9.5；计划 P0.5）：
 * 官方账号与第三方供应商两种来源互不干扰。这一版守住现有实现的行为，官方账号目录化（P2）时扩充。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliHarnessService } from '../../../src/cli/CliHarnessService';
import {
  agentLaunch,
  STRIP,
  stripGatewayLeftovers,
  type AgentKind,
} from '../../../src/gateway/agents';
import { testGateway } from '../../helpers/gateway';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 目录树快照：相对路径 → 内容摘要（软链记目标） */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p);
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** 一个装着各 CLI 全局配置与凭据的假 HOME */
function fakeHome(): string {
  const home = tmp('nomi-iso-home-');
  const files: Record<string, string> = {
    '.claude/.credentials.json': '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-secret"}}',
    '.claude/settings.json': '{"theme":"dark"}',
    '.claude.json': '{"oauthAccount":{"emailAddress":"a@example.com"}}',
    '.codex/auth.json': '{"tokens":{"access_token":"secret"}}',
    '.codex/config.toml': 'model = "gpt-5"\n',
    '.codex/models_cache.json': '{"models":[{"slug":"gpt-5"}]}',
    '.grok/auth.json': '{"token":"secret"}',
    '.grok/auth.json.lock': '',
    '.grok/config.toml': '[models]\ndefault = "grok-4"\n',
    '.grok/sessions/x/updates.jsonl': '{}\n',
    '.gemini/oauth_creds.json': '{"access_token":"secret"}',
    '.gemini/settings.json': '{}',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), body);
  }
  return home;
}

const KINDS: AgentKind[] = ['claude', 'codex', 'gemini', 'grok', 'dsh'];

describe('S1 第三方启动不写 CLI 的全局配置与凭据', () => {
  it.each(KINDS)('%s', (kind) => {
    const home = fakeHome();
    const before = snapshot(home);
    const dir = tmp(`nomi-iso-dir-${kind}-`);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(home, '.codex');
    try {
      agentLaunch(kind, {
        url: 'http://127.0.0.1:18721',
        token: 'nomi-gw-iso',
        model: 'zp/glm-5',
        models: {},
        dir,
        home,
      });
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
    expect(snapshot(home)).toEqual(before);
  });
});

describe('S3 官方会话的环境里没有网关残留', () => {
  it('剔除网关地址、令牌与 nomi-gw- 前缀的值，其余不动', () => {
    const env = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18721',
      OPENAI_BASE_URL: 'http://127.0.0.1:18721/v1',
      ANTHROPIC_AUTH_TOKEN: 'nomi-gw-claude-abc',
      NOMI_GROK_API_KEY: 'tok-live',
      PATH: '/usr/bin',
      HOME: '/home/u',
    };
    const out = stripGatewayLeftovers(env, { url: 'http://127.0.0.1:18721', tokens: ['tok-live'] });
    expect(out).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });
});

describe('S4 第三方会话读不到官方凭据', () => {
  it('每个 CLI 的 strip 覆盖会抢鉴权的官方变量', () => {
    expect(STRIP.claude).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']),
    );
    expect(STRIP.codex).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'CODEX_API_KEY']));
    expect(STRIP.grok).toEqual(expect.arrayContaining(['XAI_API_KEY', 'GROK_API_KEY']));
    expect(STRIP.gemini).toEqual(
      expect.arrayContaining(['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']),
    );
  });

  it('Grok 的私有 GROK_HOME 不含凭据与锁文件（也没有指向它们的软链）', () => {
    const home = fakeHome();
    const dir = tmp('nomi-iso-grok-');
    const l = agentLaunch('grok', {
      url: 'http://127.0.0.1:18721',
      token: 'nomi-gw-iso',
      model: 'zp/glm-5',
      models: {},
      dir,
      home,
    });
    expect(l.env.GROK_HOME).toBe(dir);
    const names = fs.readdirSync(dir);
    expect(names).not.toContain('auth.json');
    expect(names.filter((n) => n.endsWith('.lock'))).toEqual([]);
    // 会话历史仍共享（S9）
    expect(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink()).toBe(true);
  });
});

describe('S5 换官方账号只影响官方标签', () => {
  const saved = { ...process.env };
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });

  it('recycleBackend 只拆官方标签的长驻进程，第三方标签的进程保留', () => {
    process.env.NOMI_CLAUDE_BIN = path.resolve(
      __dirname,
      '../../../scripts/mock-cli/mock-claude.mjs',
    );
    delete process.env.NOMI_USE_MOCK_CLI;
    const h = new CliHarnessService({
      root: tmp('nomi-iso-harness-'),
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      gateway: testGateway(),
      prewarmClaude: true,
    });
    made.push(h);
    const official = h.createTab({ backend: 'claude' });
    const third = h.createTab({ backend: 'claude', source: 'thirdParty' });
    const live = (h as unknown as { claudeLive: Map<string, unknown> }).claudeLive;
    const thirdBefore = live.get(third.id);
    expect(live.has(official.id)).toBe(true);
    expect(thirdBefore).toBeDefined();
    h.recycleBackend('claude');
    expect(live.has(official.id)).toBe(false);
    expect(live.get(third.id)).toBe(thirdBefore);
  });
});

describe('多个官方账号（§5.10.8）：编排层', () => {
  const saved = { ...process.env };
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });

  const mkHarness = (noted: Array<[string, string, string | null | undefined]> = []) => {
    process.env.NOMI_CLAUDE_BIN = path.resolve(
      __dirname,
      '../../../scripts/mock-cli/mock-claude.mjs',
    );
    delete process.env.NOMI_USE_MOCK_CLI;
    const h = new CliHarnessService({
      root: tmp('nomi-iso-acct-'),
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      gateway: testGateway(),
      prewarmClaude: true,
      accounts: {
        launch: (kind, accountId) => {
          const id = accountId ?? 'local';
          return {
            env: (accountId ? { CLAUDE_CONFIG_DIR: `/acct/${accountId}` } : {}) as Record<
              string,
              string
            >,
            strip: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
            args: [],
            sig: `official:${id}`,
          };
        },
        noteSession: (kind, sessionId, accountId) => noted.push([kind, sessionId, accountId]),
      },
    });
    made.push(h);
    const live = (h as unknown as { claudeLive: Map<string, unknown> }).claudeLive;
    const launchFor = (id: string) =>
      (
        h as unknown as { launchFor(t: unknown): { env: Record<string, string>; sig: string } }
      ).launchFor(h.listTabs().tabs.find((x) => x.id === id));
    return { h, live, launchFor };
  };

  it('官方标签按账号目录启动；第三方标签不经过账号服务', () => {
    const { h, launchFor } = mkHarness();
    const a = h.createTab({ backend: 'claude' });
    const b = h.createTab({ backend: 'claude' });
    h.setTabAccount(b.id, 'work');
    expect(launchFor(a.id)).toMatchObject({ sig: 'official:local', env: {} });
    expect(launchFor(b.id)).toMatchObject({
      sig: 'official:work',
      env: { CLAUDE_CONFIG_DIR: '/acct/work' },
    });
    const third = h.createTab({ backend: 'claude', source: 'thirdParty' });
    expect(launchFor(third.id).sig).toMatch(/^\["thirdParty"/);
    expect(h.officialAccountTabs('claude').sort()).toEqual([null, 'work'].sort());
  });

  it('改默认账号：只重启跟随默认的官方标签；指定了账号的标签与第三方标签保留（S5）', () => {
    const { h, live } = mkHarness();
    const follow = h.createTab({ backend: 'claude' });
    const pinned = h.createTab({ backend: 'claude' });
    h.setTabAccount(pinned.id, 'work');
    h.setActiveTab(pinned.id);
    const third = h.createTab({ backend: 'claude', source: 'thirdParty' });
    const pinnedLive = live.get(pinned.id);
    const thirdLive = live.get(third.id);
    expect(live.has(follow.id)).toBe(true);
    h.recycleDefaultAccount('claude');
    expect(live.has(follow.id)).toBe(false);
    expect(live.get(pinned.id)).toBe(pinnedLive);
    expect(live.get(third.id)).toBe(thirdLive);
  });

  it('给一个标签换账号：只重启这个标签', () => {
    const { h, live } = mkHarness();
    const a = h.createTab({ backend: 'claude' });
    const b = h.createTab({ backend: 'claude' });
    const bLive = live.get(b.id);
    expect(live.has(a.id)).toBe(true);
    h.setTabAccount(a.id, 'personal');
    expect(live.has(a.id)).toBe(false);
    expect(live.get(b.id)).toBe(bLive);
    expect(() => h.setTabAccount(h.createTab({ backend: 'dsh' }).id, 'x')).toThrow();
  });

  it('会话归属（S9）：打开历史按原账号续接；已绑定会话的标签换账号时记到新账号；第三方不记', () => {
    const noted: Array<[string, string, string | null | undefined]> = [];
    const { h, launchFor } = mkHarness(noted);
    const { tab } = h.openHistorySession({
      backend: 'claude',
      sessionId: 'sess-1',
      cwd: os.tmpdir(),
      title: 't',
      messages: [],
      accountId: 'work',
    });
    expect(launchFor(tab.id)).toMatchObject({ sig: 'official:work' });
    h.setTabAccount(tab.id, 'personal');
    expect(noted).toEqual([['claude', 'sess-1', 'personal']]);
    const third = h.openHistorySession({
      backend: 'claude',
      sessionId: 'sess-2',
      cwd: os.tmpdir(),
      title: 't',
      messages: [],
      source: 'thirdParty',
      accountId: 'work',
    });
    expect(third.tab.accountId ?? null).toBeNull();
  });
});

describe('S6 第三方操作 / 网关侧变更不影响官方账号', () => {
  const saved = { ...process.env };
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });

  it('换模型、改来源、仅回收第三方：官方标签进程与账号目录 / 用户 HOME 不变', () => {
    process.env.NOMI_CLAUDE_BIN = path.resolve(
      __dirname,
      '../../../scripts/mock-cli/mock-claude.mjs',
    );
    delete process.env.NOMI_USE_MOCK_CLI;
    const home = fakeHome();
    const acctRoot = tmp('nomi-iso-acct-dirs-');
    const workDir = path.join(acctRoot, 'homes', 'claude', 'work');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'marker.txt'), 'official-keep');
    const beforeHome = snapshot(home);
    const beforeAcct = snapshot(acctRoot);

    const h = new CliHarnessService({
      root: tmp('nomi-iso-s6-'),
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      gateway: testGateway({ home }),
      prewarmClaude: true,
      accounts: {
        launch: (kind, accountId) => ({
          env: (accountId
            ? { CLAUDE_CONFIG_DIR: path.join(acctRoot, 'homes', kind, accountId) }
            : {}) as Record<string, string>,
          strip: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
          args: [],
          sig: `official:${accountId ?? 'local'}`,
        }),
        noteSession: () => undefined,
      },
    });
    made.push(h);

    // 官方标签钉在 work 账号上创建（避免 setTabAccount 拆掉预热进程后再断言同一引用）
    const official = h.createTab({ backend: 'claude', accountId: 'work' });
    const third = h.createTab({ backend: 'claude', source: 'thirdParty' });
    const live = (h as unknown as { claudeLive: Map<string, unknown> }).claudeLive;
    const officialLive = live.get(official.id);
    expect(officialLive).toBeDefined();
    expect(live.has(third.id)).toBe(true);

    h.setTabModel(third.id, 'gw/other');
    // recycleBackend 只动官方；过滤成第三方 = 空操作，官方进程应保留
    h.recycleBackend('claude', (tab) => tab.source === 'thirdParty');

    expect(live.get(official.id)).toBe(officialLive);
    expect(snapshot(home)).toEqual(beforeHome);
    expect(snapshot(acctRoot)).toEqual(beforeAcct);
    expect(fs.readFileSync(path.join(workDir, 'marker.txt'), 'utf8')).toBe('official-keep');
  });
});
