jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AuthModeDetector,
  applyAuthModes,
  claudeAuthFromConfig,
  codexAuthFromConfig,
  grokAuthFromConfig,
  hasGrokAuthFile,
  hasCustomGrokConfiguration,
  isDefinitelySignedOut,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
} from '../../../src/usage/authMode';
import { parseGrokAuthStatus } from '../../../src/usage/grokAuth';
import type { QuotaEntry } from '../../../src/usage/quota';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-auth-'));
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s);
};

describe('parseClaudeAuthStatus：官方 `claude auth status` 的 authMethod', () => {
  it('claude.ai / oauth_token = 订阅；api_key / api_key_helper / third_party = API；none = 未知', () => {
    const j = (m: string) => JSON.stringify({ loggedIn: true, authMethod: m, email: 'x@y.z' });
    expect(parseClaudeAuthStatus(j('claude.ai'))).toBe('subscription');
    expect(parseClaudeAuthStatus(j('oauth_token'))).toBe('subscription');
    expect(parseClaudeAuthStatus(j('api_key'))).toBe('api');
    expect(parseClaudeAuthStatus(j('api_key_helper'))).toBe('api');
    expect(parseClaudeAuthStatus(j('third_party'))).toBe('api');
    expect(parseClaudeAuthStatus(j('none'))).toBe('unknown');
  });
  it('不是 JSON / 没有 authMethod / 未知取值：null（交给兜底）', () => {
    expect(parseClaudeAuthStatus('Logged in as foo')).toBeNull();
    expect(parseClaudeAuthStatus('{"loggedIn":true}')).toBeNull();
    expect(parseClaudeAuthStatus('{"authMethod":"future-method"}')).toBeNull();
  });
});

describe('parseCodexLoginStatus：官方 `codex login status`', () => {
  it('ChatGPT = 订阅；API key = API；Not logged in = 未知', () => {
    expect(parseCodexLoginStatus('Logged in using ChatGPT')).toBe('subscription');
    expect(parseCodexLoginStatus('Logged in using an API key - sk-proj-***abcd')).toBe('api');
    expect(parseCodexLoginStatus('Not logged in')).toBe('unknown');
    expect(parseCodexLoginStatus('something else')).toBeNull();
  });
});

describe('parseGrokAuthStatus：官方 ACP initialize', () => {
  it('cached_token = 官方账号登录；API key = API；登录入口本身保持未知', () => {
    const base = {
      authMethods: [
        { id: 'cached_token', description: 'Cached token from ~/.grok/auth.json' },
        { id: 'grok.com', description: 'Sign in with Grok' },
      ],
    };
    expect(
      parseGrokAuthStatus(
        JSON.stringify({
          id: 1,
          result: { ...base, _meta: { defaultAuthMethodId: 'cached_token' } },
        }),
      ),
    ).toBe('subscription');
    expect(
      parseGrokAuthStatus(
        JSON.stringify({ result: { ...base, _meta: { defaultAuthMethodId: 'api_key' } } }),
      ),
    ).toBe('api');
    expect(
      parseGrokAuthStatus(
        JSON.stringify({ result: { ...base, _meta: { defaultAuthMethodId: 'grok.com' } } }),
      ),
    ).toBeNull();
  });

  it('只接受 ACP JSON，忽略日志行，不读取 token 内容', () => {
    expect(
      parseGrokAuthStatus(
        `warn: starting\n${JSON.stringify({ result: { authMethods: [{ id: 'cached_token' }] } })}`,
      ),
    ).toBe('subscription');
    expect(parseGrokAuthStatus('not json')).toBeNull();
  });
});

describe('本地兜底：只看键名 / 字段，不读凭据值', () => {
  it('Claude：settings.json 的 env 出现 API 相关键名 → api；环境变量同理；否则 null', () => {
    const home = tmpHome();
    expect(claudeAuthFromConfig(home, {})).toBeNull();
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { FOO: '1' } }));
    expect(claudeAuthFromConfig(home, {})).toBeNull();
    write(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }),
    );
    expect(claudeAuthFromConfig(home, {})).toBe('api');
    expect(claudeAuthFromConfig(tmpHome(), { ANTHROPIC_API_KEY: 'x' })).toBe('api');
  });

  it('Codex：forced_login_method / 自定义 model_provider；不会去打开 auth.json', () => {
    const home = tmpHome();
    // auth.json 里放一个会让解析炸掉的内容：兜底不应读它
    write(path.join(home, '.codex', 'auth.json'), '{{{ not json');
    expect(codexAuthFromConfig(home, {})).toBeNull();
    write(path.join(home, '.codex', 'config.toml'), 'forced_login_method = "chatgpt"\n');
    expect(codexAuthFromConfig(home, {})).toBe('subscription');
    write(
      path.join(home, '.codex', 'config.toml'),
      'model_provider = "nomi"\n[model_providers.nomi]\nname="n"\n',
    );
    expect(codexAuthFromConfig(home, {})).toBe('api');
    write(path.join(home, '.codex', 'config.toml'), 'model_provider = "openai"\n');
    expect(codexAuthFromConfig(home, {})).toBeNull();
    // 只认顶层键：表里的 model_provider 不算
    write(path.join(home, '.codex', 'config.toml'), '[profiles.x]\nmodel_provider = "other"\n');
    expect(codexAuthFromConfig(home, {})).toBeNull();
  });

  it('Grok：API key / Nomi provider 配置 → api；普通官方配置不误判', () => {
    const home = tmpHome();
    expect(grokAuthFromConfig(home, {})).toBeNull();
    expect(hasCustomGrokConfiguration(home, { XAI_API_KEY: 'x' })).toBe(true);
    write(
      path.join(home, '.grok', 'config.toml'),
      '# >>> nomi managed (grok provider) >>>\n[model.nomi]\nenv_key = "NOMI_GROK_API_KEY"\n',
    );
    expect(grokAuthFromConfig(home, {})).toBe('api');
  });

  it('Grok：本机有 config/sessions 才认为装过 CLI（不碰凭据文件）', () => {
    const home = tmpHome();
    expect(hasGrokAuthFile(home, {})).toBe(false);
    write(path.join(home, '.grok', 'config.toml'), '# empty\n');
    expect(hasGrokAuthFile(home, {})).toBe(true);
  });
});

describe('AuthModeDetector', () => {
  it('nomi / dsh 固定 API；未知工具不调用任何命令', async () => {
    const run = jest.fn();
    const d = new AuthModeDetector({ home: tmpHome(), env: {}, run });
    expect(await d.detect('nomi')).toBe('api');
    expect(await d.detect('dsh')).toBe('api');
    expect(await d.detect('cursor')).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
  });

  it('Grok 官方 ACP 返回 cached_token 时识别为订阅登录', async () => {
    const home = tmpHome();
    // 与生产一致：本机需有 Grok 配置/会话痕迹才会拉起 ACP
    write(path.join(home, '.grok', 'config.toml'), '# empty\n');
    const grokRun = jest.fn(async () =>
      JSON.stringify({
        result: {
          authMethods: [{ id: 'cached_token' }],
          _meta: { defaultAuthMethodId: 'cached_token' },
        },
      }),
    );
    const d = new AuthModeDetector({ home, env: {}, grokRun });
    expect(await d.detect('grok')).toBe('subscription');
    expect(grokRun).toHaveBeenCalledTimes(1);
  });

  it('官方命令结论优先；5 分钟内缓存；invalidate 后重新探测', async () => {
    let now = 1_000;
    const run = jest.fn(async () => JSON.stringify({ authMethod: 'claude.ai' }));
    const d = new AuthModeDetector({ home: tmpHome(), env: {}, now: () => now, run });
    expect(await d.detect('claude')).toBe('subscription');
    expect(await d.detect('claude')).toBe('subscription');
    expect(run).toHaveBeenCalledTimes(1);
    now += 6 * 60_000;
    await d.detect('claude');
    expect(run).toHaveBeenCalledTimes(2);
    d.invalidate();
    await d.detect('claude');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('命令不可用 / 抛错：走本地兜底，再看已有额度数据，最后 unknown', async () => {
    const home = tmpHome();
    const has = { codex: false };
    const d = new AuthModeDetector({
      home,
      env: {},
      run: async () => {
        throw new Error('spawn ENOENT');
      },
      hasSubscriptionData: (id) => id === 'codex' && has.codex,
    });
    expect(await d.detect('codex')).toBe('unknown');
    d.invalidate();
    has.codex = true;
    expect(await d.detect('codex')).toBe('subscription');
    d.invalidate();
    write(path.join(home, '.codex', 'config.toml'), 'model_provider = "x"\n');
    expect(await d.detect('codex')).toBe('api');
  });

  it('官方命令说没登录，但配置里是 API Key 方式：判 api', async () => {
    const d = new AuthModeDetector({
      home: tmpHome(),
      env: { ANTHROPIC_API_KEY: 'x' },
      run: async () => JSON.stringify({ loggedIn: false, authMethod: 'none' }),
    });
    expect(await d.detect('claude')).toBe('api');
  });
});

describe('applyAuthModes：只有订阅登录的工具展示额度', () => {
  const E = (id: string, status: QuotaEntry['status'] = 'unavailable'): QuotaEntry => ({
    id,
    label: id,
    status,
    windows: status === 'ok' ? [{ id: 'primary', usedPercent: 10 }] : [],
  });
  const all = [E('codex', 'ok'), E('claude'), E('dsh'), E('nomi')];
  const detected = new Set(['claude', 'codex', 'dsh']);

  it('订阅：有数据 ok、没数据 unavailable；API：api 且清空窗口；Nomi 不出现', () => {
    const r = applyAuthModes(
      all,
      { codex: 'subscription', claude: 'subscription', dsh: 'api', nomi: 'api' },
      detected,
    );
    expect(r.map((e) => [e.id, e.status, e.auth])).toEqual([
      ['codex', 'ok', 'subscription'],
      ['claude', 'unavailable', 'subscription'],
      ['dsh', 'api', 'api'],
    ]);
  });

  it('API Key 登录的 Claude / Codex：显示 api，旧额度快照不再展示', () => {
    const r = applyAuthModes(
      all,
      { codex: 'api', claude: 'api', dsh: 'api', nomi: 'api' },
      detected,
    );
    expect(r.every((e) => e.status === 'api' && e.windows.length === 0)).toBe(true);
  });

  it('判断不了：没数据的不出现；有数据的保留；没检测到的工具不出现', () => {
    const r = applyAuthModes(
      all,
      { codex: 'unknown', claude: 'unknown', dsh: 'api', nomi: 'api' },
      new Set(['codex', 'claude']),
    );
    expect(r.map((e) => e.id)).toEqual(['codex']);
  });
});

describe('身份指纹 / 自定义 provider 检测 / CLAUDE_CONFIG_DIR', () => {
  const SALT = 'b'.repeat(32);
  const status = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'me@example.com',
      orgId: 'org-1',
      subscriptionType: 'max',
      ...over,
    });

  it('账号登录但 apiProvider 不是 firstParty（Bedrock / Vertex）→ API', () => {
    expect(parseClaudeAuthStatus(status())).toBe('subscription');
    expect(parseClaudeAuthStatus(status({ apiProvider: 'bedrock' }))).toBe('api');
  });

  it('parseClaudeIdentity：邮箱 / 组织 id 只进指纹；套餐可展示；缺邮箱 = 没有身份', async () => {
    const { parseClaudeIdentity } = await import('../../../src/usage/authMode');
    const a = parseClaudeIdentity(status(), SALT);
    expect(a.plan).toBe('Max');
    expect(a.fp).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(a)).not.toContain('example.com');
    expect(parseClaudeIdentity(status({ email: 'you@example.com' }), SALT).fp).not.toBe(a.fp);
    expect(parseClaudeIdentity(status({ orgId: 'org-2' }), SALT).fp).not.toBe(a.fp);
    expect(parseClaudeIdentity(status({ email: undefined }), SALT).fp).toBeNull();
    expect(parseClaudeIdentity('not json', SALT)).toEqual({ fp: null });
  });

  it('hasCustomClaudeConfiguration：env / settings.env / apiKeyHelper；空值、0、false 不算配置', async () => {
    const { hasCustomClaudeConfiguration } = await import('../../../src/usage/authMode');
    expect(hasCustomClaudeConfiguration({}, [])).toBe(false);
    expect(hasCustomClaudeConfiguration({ ANTHROPIC_API_KEY: 'k' }, [])).toBe(true);
    expect(hasCustomClaudeConfiguration({ ANTHROPIC_API_KEY: '' }, [])).toBe(false);
    expect(hasCustomClaudeConfiguration({ CLAUDE_CODE_USE_BEDROCK: '0' }, [])).toBe(false);
    expect(hasCustomClaudeConfiguration({ CLAUDE_CODE_USE_BEDROCK: '1' }, [])).toBe(true);
    expect(hasCustomClaudeConfiguration({}, [{ env: { ANTHROPIC_BASE_URL: 'https://x' } }])).toBe(
      true,
    );
    expect(hasCustomClaudeConfiguration({}, [{ env: { ANTHROPIC_BASE_URL: 'false' } }])).toBe(
      false,
    );
    expect(hasCustomClaudeConfiguration({}, [{ apiKeyHelper: '/bin/get-key' }])).toBe(true);
    expect(hasCustomClaudeConfiguration({}, [{ apiKeyHelper: '' }, null, 'x', [1]])).toBe(false);
  });

  it('claudeAuthFromConfig：settings.local.json 与 apiKeyHelper；尊重 CLAUDE_CONFIG_DIR（含 ~/）', () => {
    const home = tmpHome();
    write(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'x' }));
    expect(claudeAuthFromConfig(home, {})).toBe('api');
    const other = path.join(home, 'cfg');
    // 指到别的目录后，默认目录里的配置不再生效
    expect(claudeAuthFromConfig(home, { CLAUDE_CONFIG_DIR: other })).toBeNull();
    write(
      path.join(other, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 't' } }),
    );
    expect(claudeAuthFromConfig(home, { CLAUDE_CONFIG_DIR: other })).toBe('api');
    expect(claudeAuthFromConfig(home, { CLAUDE_CONFIG_DIR: '~/cfg' })).toBe('api');
  });

  it('codexAuthFromConfig 尊重 CODEX_HOME', () => {
    const home = tmpHome();
    const ch = path.join(home, 'codex-alt');
    write(path.join(ch, 'config.toml'), 'forced_login_method = "api"\n');
    expect(codexAuthFromConfig(home, {})).toBeNull();
    expect(codexAuthFromConfig(home, { CODEX_HOME: ch })).toBe('api');
  });

  it('AuthModeDetector.detectFull：同一次官方命令输出带出指纹 / 套餐；自定义配置优先于 CLI 结论', async () => {
    const home = tmpHome();
    const run = jest.fn(async () => status());
    const det = new AuthModeDetector({ home, env: {}, run, salt: () => SALT });
    const a = await det.detectFull('claude');
    expect(a).toMatchObject({ mode: 'subscription', plan: 'Max' });
    expect(a.fp).toMatch(/^[0-9a-f]{16}$/);
    await det.detectFull('claude');
    expect(run).toHaveBeenCalledTimes(1); // 5 分钟内走缓存

    write(path.join(home, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'x' }));
    det.invalidate();
    run.mockClear();
    expect(await det.detectFull('claude')).toEqual({ mode: 'api', fp: null });
    expect(run).not.toHaveBeenCalled(); // 自定义供应商：连官方命令都不用跑
  });
});

describe('明确退出登录 vs 探测失败', () => {
  it('isDefinitelySignedOut：只认官方明确的退出状态', () => {
    expect(isDefinitelySignedOut('claude', '{"loggedIn":false,"authMethod":"none"}')).toBe(true);
    expect(isDefinitelySignedOut('claude', '{"authMethod":"claude.ai"}')).toBe(false);
    expect(isDefinitelySignedOut('claude', 'garbage')).toBe(false);
    expect(isDefinitelySignedOut('codex', 'Not logged in')).toBe(true);
    expect(isDefinitelySignedOut('codex', 'Logged in using ChatGPT')).toBe(false);
  });

  it('退出登录时即使有历史订阅数据也不恢复成 subscription；探测失败仍可用历史数据兜底', async () => {
    const home = tmpHome();
    const mk = (text: string | null) =>
      new AuthModeDetector({
        home,
        env: {},
        run: async () => text,
        hasSubscriptionData: () => true,
      });
    const out = await mk('Not logged in').detectFull('codex');
    expect(out).toMatchObject({ mode: 'unknown', signedOut: true });
    const cl = await mk('{"loggedIn":false,"authMethod":"none"}').detectFull('claude');
    expect(cl).toMatchObject({ mode: 'unknown', signedOut: true });
    // 命令不存在 / 超时（null）：不是退出登录，保留旧的兜底行为
    expect(await mk(null).detectFull('codex')).toEqual({ mode: 'subscription', fp: null });
    expect((await mk(null).detectFull('codex')).signedOut).toBeUndefined();
  });

  it('退出登录但本地明确配了 API：按 API 解释', async () => {
    const home = tmpHome();
    write(path.join(home, '.codex', 'config.toml'), 'forced_login_method = "api"\n');
    const d = new AuthModeDetector({ home, env: {}, run: async () => 'Not logged in' });
    expect(await d.detectFull('codex')).toEqual({ mode: 'api', fp: null });
  });
});
