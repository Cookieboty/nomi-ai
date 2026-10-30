#!/usr/bin/env node
/**
 * GatewayStore / migrateLegacy golden（D-B4d-5 消除）：真实 GatewayService.init() 在临时 userData 上跑
 * 固定场景（2.0.4 ai-providers.json v1/v2、cli-providers/<kind>/store.json、routing.json、损坏文件、
 * 已有 .migrated、解不开的 Key、重启后改写），录下每个场景最终目录里的全部文件。
 * 密码器用确定性的假 safeStorage（`base64("ss:"+明文)`），时间 / uuid / randomBytes 固定。
 * Go 侧 apps/desktop-go/internal/core/gwstore/parity_test.go 回放比对。
 * Usage: TZ=Asia/Shanghai npx tsx scripts/parity/record-gwstore.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.env.TZ !== 'Asia/Shanghai') throw new Error('run with TZ=Asia/Shanghai');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

let clock = 1793500000000;
Date.now = () => clock;
let uuid = 0,
  rb = 0;
crypto.randomUUID = () => {
  const n = (++uuid).toString(16).padStart(8, '0');
  return `${n}-0000-4000-8000-000000000000`;
};
crypto.randomBytes = (n) => {
  rb++;
  return Buffer.alloc(n, rb);
};
syncBuiltinESMExports();

const { GatewayService } = await imp(
  'apps/desktop-electron/internal/core/src/gateway/GatewayService.ts',
);
const { migrateStoreData } = await imp(
  'apps/desktop-electron/internal/ai-runtime/src/providers/ProviderStore.ts',
);
const { legacyCliKeyDecryptor } = await imp(
  'apps/desktop-electron/internal/core/src/cli/legacyCliKey.ts',
);

const enc = (p) => Buffer.from('ss:' + p).toString('base64');
const dec = (s) => {
  const t = Buffer.from(s, 'base64').toString('utf8');
  if (!t.startsWith('ss:')) throw new Error('bad');
  return t.slice(3);
};
const cipher = { kind: 'safeStorage', encrypt: enc, decrypt: dec };
const secrets = { available: () => true, decrypt: (buf) => dec(buf.toString('base64')) };
const fakeProc = {
  send() {},
  bindTabs() {},
  ensureStarted() {},
  getStatus: () => ({ state: 'idle' }),
  apply() {},
  whenReady: async () => {},
  stop() {},
  retry() {},
};

function service(ud) {
  return new GatewayService({
    root: join(ud, 'gateway'),
    cipher,
    logger: { info() {}, warn() {} },
    process: fakeProc,
    lazy: true,
    legacy: {
      nomiFile: join(ud, 'ai-providers.json'),
      cliRoot: join(ud, 'cli-providers'),
      cliDecrypt: legacyCliKeyDecryptor(secrets),
      normalizeNomi: (raw) => migrateStoreData(raw).data,
      token: () => null,
      routeListening: () => false,
    },
    env: {},
  });
}

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(dir, p).split('\\').join('/');
        // 绝对路径（migratedFrom.files）换成 <UD>，Go 侧同样替换
        out[rel] = fs.readFileSync(p, 'utf8').split(dir).join('<UD>');
      }
    }
  };
  walk(dir);
  return out;
}

const write = (ud, rel, v) => {
  const p = join(ud, rel);
  fs.mkdirSync(dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
};

const v2 = {
  version: 2,
  activeProviderId: 'p-ds',
  routes: {
    'agent-tools': { providerId: 'p-oai', model: 'gpt-4o-mini' },
    summary: { providerId: 'p-ds' },
  },
  providers: [
    {
      id: 'p-ds',
      name: 'DeepSeek',
      presetId: 'deepseek',
      protocol: 'openai-chat',
      baseURL: 'https://api.deepseek.com/v1',
      fullUrl: false,
      defaultModel: 'deepseek-chat',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      fetchedModels: [{ id: 'deepseek-chat' }, { id: 'deepseek-coder' }],
      keys: [
        {
          id: 'k1',
          secret: enc('sk-deepseek-1234567890'),
          encryption: 'safeStorage',
          label: 'main',
        },
        {
          id: 'k2',
          secret: Buffer.from('sk-plain-abcdefgh').toString('base64'),
          encryption: 'none',
        },
      ],
      enabled: true,
      headers: { 'X-Team': 'nomi' },
    },
    {
      id: 'p-oai',
      name: 'OpenAI Proxy',
      presetId: 'custom',
      protocol: 'openai-responses',
      baseURL: 'https://proxy.example.com/v1/responses',
      fullUrl: true,
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini'],
      keys: [{ id: 'k3', secret: enc('sk-proxy-shared-key-9999'), encryption: 'safeStorage' }],
      enabled: true,
      userAgent: 'nomi/2.0.4',
      modelMap: [{ from: 'a', to: 'b' }],
    },
    {
      id: 'p-ant',
      name: 'Claude',
      presetId: 'anthropic',
      protocol: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      defaultModel: 'claude-sonnet-4',
      models: [],
      keys: [{ id: 'k4', secret: 'not-base64-ss', encryption: 'safeStorage' }],
      enabled: false,
    },
    {
      id: 'p-ollama',
      name: 'Ollama',
      presetId: 'ollama',
      protocol: 'openai-chat',
      baseURL: 'http://127.0.0.1:11434/v1',
      defaultModel: 'qwen3',
      models: ['qwen3'],
      keys: [],
      enabled: true,
    },
  ],
  usage: {},
};
const cli = {
  claude: {
    profiles: [
      {
        id: 'c1',
        name: 'Proxy for claude',
        baseUrl: 'https://proxy.example.com/v1/messages',
        model: 'claude-x',
        apiFormat: 'anthropic_messages',
        keyEnc: enc('sk-proxy-shared-key-9999'),
        active: true,
      },
      {
        id: 'c2',
        name: '',
        baseUrl: 'https://kimi.example.cn/anthropic',
        model: 'kimi-k2',
        apiFormat: 'anthropic_messages',
        keyEnc: Buffer.from('sk-kimi-plain-0000').toString('base64'),
        active: false,
        presetId: 'kimi',
      },
    ],
  },
  codex: {
    profiles: [
      {
        id: 'x1',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiFormat: 'openai_chat_completions',
        keyEnc: enc('sk-deepseek-1234567890'),
        active: true,
        presetId: 'deepseek',
      },
      {
        id: 'x2',
        name: 'nokey',
        baseUrl: 'http://192.168.1.20:8000/v1',
        model: 'local',
        apiFormat: 'openai_responses',
        keyEnc: '',
        active: false,
      },
      { id: '', baseUrl: 'https://skip.example.com' },
    ],
  },
  gemini: {
    profiles: [
      {
        id: 'g1',
        name: 'Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-pro',
        apiFormat: 'x',
        keyEnc: enc('AIza-gem-key-000111'),
        active: true,
      },
    ],
  },
  grok: 'not json',
};

const scenarios = [];
async function scenario(name, setup, after) {
  const ud = fs.mkdtempSync(join(os.tmpdir(), 'gwstore-'));
  clock = 1793500000000;
  uuid = 0;
  rb = 0;
  const seed = setup(ud);
  const s = service(ud);
  s.init();
  const steps = [];
  if (after) await after(ud, steps);
  scenarios.push({ name, seed, steps, files: tree(ud) });
}
const seedAll = (ud, files) => {
  for (const [k, v] of Object.entries(files)) write(ud, k, v);
  return tree(ud);
};

await scenario('fresh empty', (ud) => seedAll(ud, {}));
await scenario('migrate v2 + cli + routing', (ud) =>
  seedAll(ud, {
    'ai-providers.json': v2,
    'cli-providers/claude/store.json': cli.claude,
    'cli-providers/codex/store.json': cli.codex,
    'cli-providers/gemini/store.json': cli.gemini,
    'cli-providers/grok/store.json': cli.grok,
    'cli-providers/routing.json': { port: 18555 },
  }),
);
await scenario('migrate v1', (ud) =>
  seedAll(ud, {
    'ai-providers.json': {
      version: 1,
      activeProviderId: 'old',
      routes: { chat: { providerId: 'old', model: 'glm-4' } },
      providers: [
        {
          id: 'old',
          name: 'Zhipu',
          backend: 'openai-compatible',
          presetId: 'zhipu',
          baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
          defaultModel: 'glm-3',
          keys: [{ id: 'k', secret: enc('zp-key-abcdefghijkl'), encryption: 'safeStorage' }],
        },
        {
          id: 'g',
          name: 'Google',
          backend: 'google',
          baseURL: 'https://generativelanguage.googleapis.com/v1beta',
          defaultModel: 'gemini-pro',
          keys: [],
        },
        {
          id: 'm',
          name: 'Moon',
          backend: 'anthropic',
          presetId: 'moonshot',
          baseURL: 'https://api.moonshot.cn/anthropic',
          keys: [{ id: 'k', secret: enc('mk'), encryption: 'safeStorage' }],
        },
      ],
    },
    'cli-providers/routing.json': { port: 18721 },
  }),
);
await scenario('migrated exists → timestamped archive', (ud) =>
  seedAll(ud, {
    'ai-providers.json': { version: 2, providers: [], routes: {} },
    'ai-providers.json.migrated': 'old',
    'cli-providers/dsh/store.json': { profiles: [] },
  }),
);
await scenario('corrupt store moved aside', (ud) =>
  seedAll(ud, { 'gateway/store.json': '{not json', 'ai-providers.json': v2 }),
);
await scenario('wrong version moved aside', (ud) =>
  seedAll(ud, { 'gateway/store.json': JSON.stringify({ version: 2, providers: [] }) }),
);
await scenario('existing store: leftover legacy archived, cli assignment normalized', (ud) =>
  seedAll(ud, {
    'gateway/store.json': JSON.stringify(
      {
        version: 1,
        providers: [
          {
            id: 'a',
            name: 'A',
            enabled: true,
            urls: { chat: 'https://a.example.com' },
            keys: [],
            models: [],
            source: 'user',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        clients: {
          nomi: { models: {}, tokenEnc: enc('nomi-gw-nomi-tok'), tokenEncryption: 'safeStorage' },
          claude: {
            models: { main: 'a/m' },
            tokenEnc: 'garbage',
            tokenEncryption: 'safeStorage',
            newTabSource: 'official',
            newTabAccountId: 'acc',
          },
          codex: {
            models: {},
            tokenEnc: Buffer.from('nomi-gw-codex-plain').toString('base64'),
            tokenEncryption: 'none',
            newTabSource: 'thirdParty',
          },
        },
        learned: { a: { x: 1 } },
        allowedPrivateHosts: [],
        port: 18721,
        extra: 'kept',
      },
      null,
      2,
    ),
    'cli-providers/codex/store.json': cli.codex,
  }),
);
await scenario(
  'restart: reload, mutate, reload',
  (ud) => seedAll(ud, { 'ai-providers.json': v2 }),
  async (ud, steps) => {
    clock += 1000;
    const s2 = service(ud);
    s2.init();
    steps.push({ after: 'second init', files: tree(ud) });
    const st = s2.store;
    clock += 1000;
    st.upsertProvider({
      id: st.uniqueProviderId('DeepSeek'),
      name: 'DeepSeek 2',
      enabled: true,
      urls: { chat: 'https://x.example.com' },
      keys: [st.makeKey('sk-new-key-1234567', { name: 'n', wire: 'chat' }), st.makeKey('short')],
      models: [{ id: 'm', enabled: true }],
      modelsSource: 'manual',
      source: 'user',
      createdAt: clock,
      updatedAt: 0,
    });
    st.setClient('nomi', {
      models: { main: 'deepseek-2/m', tools: null, summary: '' },
      newTabAccountId: null,
    });
    st.setClient('claude', {
      models: { main: 'x/y' },
      newTabSource: 'thirdParty',
      newTabAccountId: 'acc-1',
    });
    st.resetToken('codex');
    st.removeProvider('deepseek');
    st.setLearned('openai-proxy', { chat: { ok: true } });
    steps.push({
      tokens: Object.fromEntries(
        ['nomi', 'claude', 'codex', 'gemini', 'grok', 'dsh'].map((c) => [c, st.clientToken(c)]),
      ),
      privacyKey: st.privacyKey(),
      port: st.port(),
      unique: st.uniqueProviderId('Open AI Proxy!'),
    });
    st.save();
    clock += 1000;
    const s3 = service(ud);
    s3.init();
    steps.push({
      after: 'third init',
      files: tree(ud),
      providers: s3.store.providers().map((p) => p.id),
    });
  },
);

const out = join(root, 'apps/desktop-go/internal/core/gwstore/testdata/gwstore.json');
fs.writeFileSync(out, JSON.stringify({ scenarios }, null, 1));
console.log('wrote', out, scenarios.length);
