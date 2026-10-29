#!/usr/bin/env node
/**
 * authMode.ts parity 录制（源码 esbuild 去类型；cliHomes / grokAuth / quotaIdentity 走 tsx 源码，cli/detect 用桩）。
 * Go 回放：internal/core/usage/authmode_parity_test.go。
 * Usage: node --import tsx scripts/parity/record-usage-authmode.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsModule, loadSrc, root } from './usage-src.mjs';

const src = (p) => pathToFileURL(join(root, 'packages/core/src', p)).href;
const detect = jsModule('export const resolveCliBinAsync = async () => null; export const withCliPath = () => ({});');
const { mod } = await loadSrc('usage/authMode', {
  '../cli/detect': detect,
  './cliHomes': src('usage/cliHomes.ts'),
  './grokAuth': src('usage/grokAuth.ts'),
  './quota': src('usage/quota.ts'),
  './quotaIdentity': src('usage/quotaIdentity.ts'),
});
const M = mod;

const texts = [
  '', 'x', 'null', '[]', '5', '{}', '{"authMethod":5}', '{"authMethod":"claude.ai"}', '{"authMethod":"oauth_token","apiProvider":"firstParty"}',
  '{"authMethod":"claude.ai","apiProvider":"bedrock"}', '{"authMethod":"claude.ai","apiProvider":5}', '{"authMethod":"api_key"}', '{"authMethod":"api_key_helper"}',
  '{"authMethod":"third_party"}', '{"authMethod":"none"}', '{"authMethod":"other"}',
  '{"authMethod":"claude.ai","email":"a@b.c","orgId":"o1","subscriptionType":"max"}',
  '{"authMethod":"claude.ai","email":" a@b.c ","organizationId":"o2","subscriptionType":"PRO"}',
  '{"email":"a@b.c","orgId":"","organizationId":"o3","subscriptionType":"ßtier"}',
  '{"email":"","subscriptionType":"max"}', '{"subscriptionType":"   "}', '{"subscriptionType":"aaaaaaaaaaaaaaaaaaaaaaaaa"}', '{"subscriptionType":"aaaaaaaaaaaaaaaaaaaaaaaa"}',
  '{"email":5,"subscriptionType":"éclair"}', '{"email":"x@y","orgId":"' + 'o'.repeat(81) + '"}', '{"email":"x@y","orgId":"' + 'o'.repeat(80) + '"}',
  '{"subscriptionType":"ǆx"}', '{"subscriptionType":"İSTANBUL"}', '{"subscriptionType":"ŉo"}',
  'Logged in using ChatGPT', 'Logged in using an API key - sk-***', 'logged in using a api key', 'Not logged in', 'NOT LOGGED IN\nusing chatgpt', 'Logged in using CHATGPT', 'not  logged in',
  'Logged in using API key', '\u212Aot logged in', 'not logged İn',
];
const parse = texts.map((t) => ({
  t,
  claude: M.parseClaudeAuthStatus(t),
  ident: JSON.stringify(M.parseClaudeIdentity(t, 'salt-1')),
  soClaude: M.isDefinitelySignedOut('claude', t),
  soCodex: M.isDefinitelySignedOut('codex', t),
  codex: M.parseCodexLoginStatus(t),
}));

// 配置场景：files 相对 home；env 里 ~ 开头的路径相对 home
const big = (s) => s;
const cfgs = [
  { files: {}, env: {} },
  { files: { '.claude/settings.json': '{"apiKeyHelper":"x"}' }, env: {} },
  { files: { '.claude/settings.json': '{"apiKeyHelper":"false"}', '.claude/settings.local.json': '{"env":{"ANTHROPIC_BASE_URL":"http://x"}}' }, env: {} },
  { files: { '.claude/settings.json': '[1]', '.claude/settings.local.json': 'nope' }, env: {} },
  { files: { '.claude/settings.json': '{"apiKeyHelper":0,"env":[1]}' }, env: {} },
  { files: { '.claude/settings.json': '{"apiKeyHelper":null,"env":{"CLAUDE_CODE_USE_VERTEX":true}}' }, env: {} },
  { files: { '.claude/settings.json': '{"env":{"CLAUDE_CODE_USE_VERTEX":false,"ANTHROPIC_API_KEY":" 0 "}}' }, env: {} },
  { files: { 'cc/settings.json': '{"apiKeyHelper":"h"}' }, env: { CLAUDE_CONFIG_DIR: '~/cc' } },
  { files: {}, env: { ANTHROPIC_API_KEY: 'FALSE' } },
  { files: {}, env: { ANTHROPIC_AUTH_TOKEN: 'tok' } },
  { files: {}, env: { CLAUDE_CODE_OAUTH_TOKEN: '1' } },
  { files: { '.claude.json': '{"oauthAccount":{"a":1}}' }, env: {} },
  { files: { '.claude.json': '{"oauthAccount":{}}' }, env: {} },
  { files: { '.claude.json': '{"x":1}' }, env: {} },
  { files: { '.claude.json': '[]' }, env: {} },
  { files: { '.claude.json': 'bad' }, env: {} },
  { files: { 'cc/.claude.json': '{"oauthAccount":{"a":1}}', '.claude.json': '{}' }, env: { CLAUDE_CONFIG_DIR: '~/cc' } },
  { files: { '.claude.json': '{"oauthAccount":{"a":1}}' }, env: { CLAUDE_CONFIG_DIR: '~/cc' } },
  { files: { '.codex/config.toml': 'forced_login_method = "api"\n' }, env: {} },
  { files: { '.codex/config.toml': '  forced_login_method="chatgpt"\nmodel_provider = "x"' }, env: {} },
  { files: { '.codex/config.toml': 'forced_login_method = "other"\nmodel_provider = "azure"' }, env: {} },
  { files: { '.codex/config.toml': 'model_provider = "openai"' }, env: {} },
  { files: { '.codex/config.toml': '[profiles.x]\nforced_login_method = "api"' }, env: {} },
  { files: { '.codex/config.toml': 'a=1\n\n  [t]\nmodel_provider = "z"' }, env: {} },
  { files: { '.codex/config.toml': 'model_provider = "z"\r[t]' }, env: {} },
  { files: { '.codex/config.toml': 'x = 1 # forced_login_method = "api"\nmodel_provider\n=\n"multi\nline"' }, env: {} },
  { files: { '.codex/config.toml': '\u2028model_provider = "ls"\n[x]' }, env: {} },
  { files: { '.codex/config.toml': 'a = "[x"\nmodel_provider = "q"' }, env: {} },
  // split(/^\s*\[/m)[0] 的切点：首个表头之前（含表头前的空白行 / 行首空白 / CRLF / 文件开头就是表头）
  { files: { '.codex/config.toml': '[t]\nforced_login_method = "api"' }, env: {} },
  { files: { '.codex/config.toml': '\n\n  [t]\nmodel_provider = "z"' }, env: {} },
  { files: { '.codex/config.toml': 'forced_login_method = "chatgpt"\r\n\r\n[t]\nforced_login_method = "api"' }, env: {} },
  { files: { '.codex/config.toml': 'model_provider = "z"\n[a]\n[b]' }, env: {} },
  { files: { '.codex/config.toml': 'model_provider = "openai"\n  [p]\nmodel_provider = "z"' }, env: {} },
  { files: { '.codex/config.toml': 'model_provider = "ab[c"\n[p]' }, env: {} },
  { files: { '.codex/config.toml': 'model_provider = "a\n[p]\n"' }, env: {} },
  { files: { '.codex/config.toml': 'forced_login_method = "api\n[t]"' }, env: {} },
  { files: { cx: { dir: true }, 'cx/config.toml': 'forced_login_method = "api"' }, env: { CODEX_HOME: '~/cx' } },
  { files: { '.grok/config.toml': '# >>> nomi managed (grok provider) >>>\n' }, env: {} },
  { files: { '.grok/config.toml': 'env_key = "XAI_API_KEY"' }, env: {} },
  { files: { '.grok/config.toml': 'x=1\n  ENV_KEY = "nomi_grok_api_key"' }, env: {} },
  { files: { '.grok/config.toml': 'x=1 env_key = "XAI_API_KEY"' }, env: {} },
  { files: { '.grok/config.toml': 'env_\u212Aey = "XAI_API_KEY"' }, env: {} },
  { files: { '.grok/config.toml': 'env_key = "OTHER"' }, env: {} },
  { files: { '.grok/sessions/a': 'x' }, env: {} },
  { files: {}, env: { XAI_API_KEY: 'k' } },
  { files: {}, env: { GROK_DEPLOYMENT_KEY: '0' } },
];
const writeFiles = (home, files) => {
  for (const [rel, c] of Object.entries(files)) {
    const p = join(home, rel);
    if (typeof c === 'object') { mkdirSync(p, { recursive: true }); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  }
};
const fixEnv = (home, env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('~/') ? join(home, v.slice(2)) : v]));
const cfgOut = cfgs.map(({ files, env }) => {
  const home = mkdtempSync(join(tmpdir(), 'am-'));
  writeFiles(home, files);
  const e = fixEnv(home, env);
  const docs = M.readClaudeSettingsDocs(home, e);
  const r = {
    files, env,
    docs: JSON.stringify(docs),
    custom: M.hasCustomClaudeConfiguration(e, docs),
    oauth: M.claudeOAuthPresent(home, e),
    claude: M.claudeAuthFromConfig(home, e),
    codex: M.codexAuthFromConfig(home, e),
    grokManaged: M.hasManagedGrokConfiguration(home, e),
    grokCustom: M.hasCustomGrokConfiguration(home, e),
    grok: M.grokAuthFromConfig(home, e),
    grokPresence: M.hasGrokLocalPresence(home, e),
  };
  rmSync(home, { recursive: true, force: true });
  return r;
});

// 探测器场景：run 输出 { claude, codex, grok }（null / 字符串 / 'THROW'）；ops 依次执行
const scenarios = [
  { name: 'nomi-dsh-other', files: {}, env: {}, run: {}, ops: [['full', 'nomi'], ['full', 'dsh'], ['full', 'x'], ['passive', 'nomi'], ['passive', 'dsh'], ['passive', 'zz']] },
  { name: 'claude-sub', files: { '.claude.json': '{"oauthAccount":{"a":1}}' }, env: {}, salt: 's', run: { claude: '{"authMethod":"claude.ai","email":"a@b","subscriptionType":"max"}' },
    ops: [['passive', 'claude'], ['full', 'claude'], ['passive', 'claude'], ['snap'], ['tick', 100000], ['full', 'claude'], ['tick', 300000], ['full', 'claude'], ['snap'], ['invalidate', 'claude'], ['passive', 'claude'], ['full', 'claude']] },
  { name: 'claude-signedout-local', files: { '.claude.json': '{}' }, env: {}, run: { claude: '{"authMethod":"claude.ai"}' }, restore: { claude: { mode: 'subscription', fp: 'f' } },
    ops: [['snap'], ['full', 'claude'], ['snap'], ['passive', 'claude'], ['snap'], ['full', 'claude']] },
  { name: 'claude-none', files: {}, env: {}, run: { claude: '{"authMethod":"none"}' }, sub: ['claude'], restore: { claude: { mode: 'api', fp: null }, codex: { mode: 'subscription', fp: null, plan: 'Plus' } },
    ops: [['passive', 'claude'], ['full', 'claude'], ['snap'], ['forget', 'codex'], ['snap']] },
  { name: 'claude-none-env-api', files: {}, env: { ANTHROPIC_API_KEY: 'k' }, run: { claude: '{"authMethod":"none"}' }, ops: [['full', 'claude'], ['passive', 'claude']] },
  { name: 'claude-throw-sub', files: {}, env: {}, run: { claude: 'THROW' }, sub: ['claude'], ops: [['full', 'claude'], ['snap']] },
  { name: 'claude-null', files: {}, env: {}, run: { claude: null }, ops: [['full', 'claude']] },
  { name: 'claude-garbage', files: {}, env: {}, run: { claude: 'garbage' }, ops: [['full', 'claude']] },
  { name: 'claude-api-cfg', files: { '.claude/settings.json': '{"apiKeyHelper":"x"}' }, env: {}, run: { claude: '{"authMethod":"claude.ai"}' }, ops: [['passive', 'claude'], ['full', 'claude'], ['snap']] },
  { name: 'claude-nosalt', files: {}, env: {}, run: { claude: '{"authMethod":"oauth_token","email":"a@b","subscriptionType":"pro"}' }, ops: [['full', 'claude'], ['snap'], ['invalidate'], ['full', 'claude'], ['snap']] },
  { name: 'claude-plan-change', files: {}, env: {}, salt: 's2', runs: { claude: ['{"authMethod":"claude.ai","email":"a@b","subscriptionType":"pro"}', '{"authMethod":"claude.ai","email":"a@b","subscriptionType":"max"}', '{"authMethod":"api_key"}'] },
    ops: [['full', 'claude'], ['invalidate', 'claude'], ['full', 'claude'], ['invalidate'], ['full', 'claude'], ['snap'], ['forget'], ['snap']] },
  { name: 'codex', files: { '.codex/config.toml': 'model_provider = "azure"' }, env: {}, runs: { codex: ['Logged in using ChatGPT', 'Not logged in', 'Logged in using an API key', 'weird'] },
    ops: [['passive', 'codex'], ['full', 'codex'], ['passive', 'codex'], ['snap'], ['invalidate'], ['full', 'codex'], ['snap'], ['invalidate'], ['full', 'codex'], ['invalidate'], ['full', 'codex'], ['snap']] },
  { name: 'codex-signedout', files: {}, env: {}, sub: ['codex'], runs: { codex: ['Not logged in', 'oops'] }, restore: { codex: { mode: 'subscription', fp: null } },
    ops: [['passive', 'codex'], ['full', 'codex'], ['snap'], ['invalidate'], ['full', 'codex']] },
  { name: 'grok-absent', files: {}, env: {}, run: { grok: 'THROW' }, ops: [['passive', 'grok'], ['full', 'grok']] },
  { name: 'grok-managed', files: { '.grok/config.toml': '# >>> nomi managed (grok provider) >>>' }, env: {}, run: { grok: 'x' }, ops: [['passive', 'grok'], ['full', 'grok']] },
  { name: 'grok-env', files: {}, env: { XAI_API_KEY: 'k' }, run: { grok: null }, ops: [['passive', 'grok'], ['full', 'grok']] },
  { name: 'grok-present', files: { '.grok/sessions/x': '' }, env: {}, sub: ['grok'], run: { grok: null }, ops: [['passive', 'grok'], ['full', 'grok'], ['snap']] },
  // TTL 边界：差 299999ms 命中缓存，正好 300000ms 重新探测（now - at < TTL）
  { name: 'ttl-boundary', files: {}, env: {}, runs: { codex: ['Logged in using ChatGPT', 'Logged in using an API key'] },
    ops: [['full', 'codex'], ['tick', 299999], ['full', 'codex'], ['tick', 1], ['full', 'codex'], ['tick', 299999], ['full', 'codex']] },
  // 只换套餐（同一账号指纹）→ known 变化、触发 onKnownChange；同套餐不触发
  { name: 'plan-only', files: {}, env: {}, salt: 's3', runs: { claude: ['{"authMethod":"claude.ai","email":"a@b","subscriptionType":"pro"}', '{"authMethod":"claude.ai","email":"a@b","subscriptionType":"pro"}', '{"authMethod":"claude.ai","email":"a@b","subscriptionType":"max"}', '{"authMethod":"claude.ai","email":"a@b"}', '{"authMethod":"claude.ai","email":"a@b"}'] },
    ops: [['full', 'claude'], ['snap'], ['invalidate'], ['full', 'claude'], ['invalidate'], ['full', 'claude'], ['snap'], ['invalidate'], ['full', 'claude'], ['snap'], ['invalidate'], ['full', 'claude']] },
  // 指纹相同、仅 plan 不同（恢复出来的旧 plan）→ 仍算变化
  { name: 'plan-only-same-fp', files: {}, env: {}, salt: 's3', run: { claude: '{"authMethod":"claude.ai","email":"a@b","subscriptionType":"pro"}' },
    restore: { claude: { mode: 'subscription', fp: '8e358a055c277b34', plan: 'Team' } }, ops: [['snap'], ['full', 'claude'], ['snap']] },
  // 恢复出来的 plan: ''（Node 原样保留：passive 快照里带 plan:''，且与无 plan 的探测结果不等 → 记为变化）
  { name: 'restored-empty-plan', files: {}, env: {}, salt: 's3', run: { claude: '{"authMethod":"claude.ai","email":"a@b"}' },
    restore: { claude: { mode: 'subscription', fp: '8e358a055c277b34', plan: '' }, codex: { mode: 'api', fp: null, plan: '' } }, ops: [['snap'], ['full', 'claude'], ['snap']] },
  { name: 'restored-empty-plan-same', files: {}, env: {}, salt: 's3', run: { claude: '{"authMethod":"claude.ai","email":"a@b","subscriptionType":""}' },
    restore: { claude: { mode: 'subscription', fp: '8e358a055c277b34', plan: '' } }, ops: [['full', 'claude'], ['snap']] },
  { name: 'restored-empty-plan-same-fp', files: {}, env: {}, salt: 's3', run: { claude: '{"authMethod":"claude.ai","email":"a@b"}' },
    restore: { claude: { mode: 'subscription', fp: '2d648b571179f3df', plan: '' } }, ops: [['full', 'claude'], ['snap']] },
  { name: 'plan-drop-same-fp', files: {}, env: {}, salt: 's3', run: { claude: '{"authMethod":"claude.ai","email":"a@b","subscriptionType":"pro"}' },
    restore: { claude: { mode: 'subscription', fp: '8e358a055c277b34', plan: 'Pro' } }, ops: [['full', 'claude'], ['snap']] },
  // 进行中探测共享：同步两次 detectFull 拿到同一个 promise、只跑一次；结算前被动读取看不到缓存
  { name: 'inflight-share', files: {}, env: {}, sub: ['codex'], run: { codex: 'Logged in using ChatGPT' },
    ops: [['start', 'codex'], ['start', 'codex'], ['same'], ['passive', 'codex'], ['snap'], ['awaitAll'], ['passive', 'codex'], ['snap'], ['start', 'codex'], ['start', 'codex'], ['same'], ['awaitAll']] },
  { name: 'inflight-invalidate', files: {}, env: {}, runs: { codex: ['Logged in using ChatGPT', 'Not logged in'] },
    ops: [['start', 'codex'], ['invalidate'], ['start', 'codex'], ['same'], ['awaitAll'], ['full', 'codex'], ['invalidate'], ['start', 'codex'], ['awaitAll'], ['snap']] },
  { name: 'inflight-reject', files: {}, env: {}, salt: 'THROW', runs: { claude: ['{"authMethod":"claude.ai","email":"a@b"}', '{"authMethod":"claude.ai","email":"a@b"}'] },
    ops: [['start', 'claude'], ['start', 'claude'], ['same'], ['awaitAll'], ['passive', 'claude'], ['full', 'claude'], ['snap']] },
  { name: 'envfor', files: { 'acct/settings.json': '{"apiKeyHelper":"x"}' }, env: {}, envFor: { claude: { CLAUDE_CONFIG_DIR: '~/acct' } }, run: { claude: '{"authMethod":"claude.ai"}', codex: 'Logged in using ChatGPT' },
    ops: [['passive', 'claude'], ['full', 'claude'], ['full', 'codex'], ['snap']] },
];
const scenOut = [];
for (const sc of scenarios) {
  const home = mkdtempSync(join(tmpdir(), 'amd-'));
  writeFiles(home, sc.files);
  let t = Date.UTC(2026, 9, 29, 3, 0, 0);
  const runs = {};
  const calls = [];
  const pick = (k) => {
    calls.push(k);
    if (sc.runs?.[k]) { runs[k] = (runs[k] ?? 0) + 1; return sc.runs[k][runs[k] - 1] ?? null; }
    return sc.run?.[k] ?? null;
  };
  const answer = (v) => (v === 'THROW' ? Promise.reject(new Error('x')) : Promise.resolve(v));
  let changes = 0;
  const det = new M.AuthModeDetector({
    home, env: fixEnv(home, sc.env), now: () => t,
    run: async (k) => answer(pick(k)), grokRun: async () => answer(pick('grok')),
    hasSubscriptionData: (id) => (sc.sub ?? []).includes(id),
    ...(sc.salt ? { salt: () => { if (sc.salt === 'THROW') throw new Error('salt boom'); return sc.salt; } } : {}),
    ...(sc.envFor ? { envFor: (id) => (sc.envFor[id] ? fixEnv(home, sc.envFor[id]) : null) } : {}),
  });
  det.setOnKnownChange(() => { changes++; });
  if (sc.restore) det.restoreKnown(sc.restore);
  const out = [];
  let started = [];
  const settleOne = (p) => p.then((v) => JSON.stringify(v), (e) => `REJECT:${e.message}`);
  for (const [op, arg] of sc.ops) {
    if (op === 'full') out.push(await settleOne(det.detectFull(arg)));
    else if (op === 'start') { started.push(det.detectFull(arg)); out.push(null); }
    else if (op === 'same') out.push(started[started.length - 1] === started[started.length - 2]);
    else if (op === 'awaitAll') { out.push(await Promise.all(started.map(settleOne))); started = []; }
    else if (op === 'passive') out.push(JSON.stringify(det.detectPassive(arg)));
    else if (op === 'snap') out.push(JSON.stringify(det.knownSnapshot()));
    else if (op === 'tick') { t += arg; out.push(null); }
    else if (op === 'invalidate') { det.invalidate(arg); out.push(null); }
    else if (op === 'forget') { det.forgetKnown(arg); out.push(null); }
    out.push(changes);
  }
  // 并发去重
  scenOut.push({ ...sc, out, calls });
  rmSync(home, { recursive: true, force: true });
}

const E = (id, status, extra = {}) => ({ id, label: id.toUpperCase(), status, windows: status === 'ok' ? [{ id: 'w', usedPercent: 10 }] : [], ...extra });
const apply = [
  { entries: [E('nomi', 'ok'), E('claude', 'ok', { updatedAt: 5, plan: 'Max' }), E('codex', 'unavailable'), E('grok', 'unavailable'), E('dsh', 'ok'), E('qwen', 'unavailable')],
    modes: { claude: 'api', codex: 'subscription', grok: 'unknown', dsh: 'unknown' }, detected: ['grok', 'qwen'] },
  { entries: [E('claude', 'unavailable'), E('codex', 'ok', { origin: 'session-log', stale: true }), E('grok', 'ok')], modes: { claude: 'api', codex: 'api', grok: 'subscription' }, detected: [] },
  { entries: [E('claude', 'unavailable'), E('codex', 'unavailable')], modes: {}, detected: ['claude'] },
  { entries: [], modes: {}, detected: [] },
];
// 全组合：auth（api / subscription / unknown / 缺省）× status（ok / unavailable / error）× 是否 detected
{
  const modes = {}; const entries = []; const detected = [];
  let i = 0;
  for (const auth of ['api', 'subscription', 'unknown', undefined]) for (const st of ['ok', 'unavailable', 'error']) for (const det of [true, false]) {
    const id = `p${i++}`;
    if (auth) modes[id] = auth;
    if (det) detected.push(id);
    entries.push(E(id, st, { plan: 'X' }));
  }
  apply.push({ entries, modes, detected });
}
const applyOut = apply.map((a) => JSON.stringify(M.applyAuthModes(a.entries, a.modes, new Set(a.detected))));

const out = join(root, 'apps/desktop-go/internal/core/usage/testdata/usage-authmode.json');
writeFileSync(out, JSON.stringify({ parse, cfg: cfgOut, scen: scenOut, apply, applyOut }, null, 1) + '\n');
console.log('authmode golden:', parse.length, 'parse,', cfgOut.length, 'cfg,', scenOut.length, 'scen,', applyOut.length, 'apply');
