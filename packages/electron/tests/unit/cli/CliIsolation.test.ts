jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCliEnv, isNomiInternalEnv } from '../../../src/cli/cliEnv';
import { CliHarnessService } from '../../../src/cli/CliHarnessService';
import { claudeSettingsPath, codexAuthPath, codexConfigPath } from '../../../src/cli/configPatch';
import { TEST_GATEWAY_TOKEN, TEST_GATEWAY_URL, testGateway } from '../../helpers/gateway';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

const logger = { info() {}, warn() {} };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe('buildCliEnv', () => {
  it('drops Nomi internal variables but keeps the user environment', () => {
    const env = buildCliEnv({
      PATH: '/bin',
      HOME: '/h',
      OPENAI_API_KEY: 'user-own',
      NOMI_USE_MOCK_CLI: '1',
      NOMI_DSH_API_KEY: 'leak',
      NOMI_MOCK_DELAY_MS: '5',
      NOMI_PROVIDER: 'amux',
      IG_AI_PROFILE: 'waifu',
      CD_LOCALE: 'zh',
      MCP_SERVERS: '[]',
    });
    expect(env.PATH).toBe('/bin');
    expect(env.OPENAI_API_KEY).toBe('user-own');
    expect(env.NOMI_MOCK_DELAY_MS).toBe('5');
    expect(env.NOMI_USE_MOCK_CLI).toBeUndefined();
    expect(env.NOMI_DSH_API_KEY).toBeUndefined();
    expect(env.NOMI_PROVIDER).toBeUndefined();
    expect(env.IG_AI_PROFILE).toBeUndefined();
    expect(env.CD_LOCALE).toBeUndefined();
    expect(env.MCP_SERVERS).toBeUndefined();
    expect(env.NO_COLOR).toBe('1');
  });

  it('lets the backend own profile inject its variable', () => {
    const env = buildCliEnv({ NOMI_DSH_API_KEY: 'stale' }, { NOMI_DSH_API_KEY: 'dsh-own' });
    expect(env.NOMI_DSH_API_KEY).toBe('dsh-own');
    expect(isNomiInternalEnv('NOMI_ANYTHING')).toBe(true);
    expect(isNomiInternalEnv('NOMI_MOCK_X')).toBe(false);
  });
});

describe('provider isolation: Nomi key never reaches CLI launches', () => {
  const NOMI_KEY = 'sk-nomi-amux-SECRET';

  it('spawned CLI sees no Nomi key / config', async () => {
    // 模拟 Nomi 自有 ai-providers.json（含 Amux key）与 Nomi 相关环境变量
    const userData = tmp('nomi-ud-');
    fs.writeFileSync(
      path.join(userData, 'ai-providers.json'),
      JSON.stringify({ providers: [{ id: 'amux', apiKey: NOMI_KEY }] }),
    );
    const home = tmp('nomi-home-');

    // CLI 打印自己看到的环境，以及 ~/.codex 是否被写
    const dir = tmp('nomi-envcli-');
    const bin = path.join(dir, 'env-codex.mjs');
    fs.writeFileSync(
      bin,
      [
        "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "emit({ type: 'thread.started', thread_id: 't1' });",
        "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify(process.env) } });",
        "emit({ type: 'turn.completed', usage: {} });",
      ].join('\n'),
    );
    const saved = { ...process.env };
    process.env.NOMI_CODEX_BIN = bin;
    process.env.NOMI_PROVIDER_KEY = NOMI_KEY;
    process.env.NOMI_USE_MOCK_CLI = '0';
    try {
      const h = new CliHarnessService({
        root: path.join(dir, 'root'),
        logger,
        defaultCwd: dir,
      });
      h.setBackend('codex');
      const r = await h.send('hi');
      const seen = JSON.parse(r.text) as Record<string, string>;
      expect(JSON.stringify(seen)).not.toContain(NOMI_KEY);
      expect(seen.NOMI_USE_MOCK_CLI).toBeUndefined();
      expect(seen.NOMI_PROVIDER_KEY).toBeUndefined();
      // .mjs 经 process.execPath 启动时必须带上，Windows Electron 否则 stdin 失效
      expect(seen.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(fs.existsSync(codexConfigPath(home))).toBe(false);
      expect(fs.existsSync(codexAuthPath(home))).toBe(false);
      expect(fs.existsSync(claudeSettingsPath(home))).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('third-party tabs get only the gateway token; inherited keys are stripped; official tabs drop gateway leftovers', async () => {
    const home = tmp('nomi-home-');
    const dir = tmp('nomi-envcli-');
    const bin = path.join(dir, 'env-codex.mjs');
    fs.writeFileSync(
      bin,
      [
        "const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "emit({ type: 'thread.started', thread_id: 't1' });",
        "emit({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify({ env: process.env, argv: process.argv.slice(2) }) } });",
        "emit({ type: 'turn.completed', usage: {} });",
      ].join('\n'),
    );
    const saved = { ...process.env };
    process.env.NOMI_CODEX_BIN = bin;
    process.env.NOMI_USE_MOCK_CLI = '0';
    process.env.OPENAI_API_KEY = 'sk-user-own-openai';
    process.env.ANTHROPIC_BASE_URL = TEST_GATEWAY_URL;
    try {
      const h = new CliHarnessService({
        root: path.join(dir, 'root'),
        logger,
        defaultCwd: dir,
        home,
        gateway: testGateway(),
      });
      const third = h.createTab({ backend: 'codex', source: 'thirdParty' });
      const r = JSON.parse((await h.sendTab(third.id, 'hi')).text) as {
        env: Record<string, string>;
        argv: string[];
      };
      expect(r.env.NOMI_GATEWAY_KEY).toBe(TEST_GATEWAY_TOKEN);
      expect(r.env.OPENAI_API_KEY).toBeUndefined();
      expect(r.argv.join(' ')).toContain('model_provider="nomi_gateway"');
      expect(r.argv.join(' ')).toContain('model="gw/main"');
      const official = h.createTab({ backend: 'codex' });
      const o = JSON.parse((await h.sendTab(official.id, 'hi')).text) as {
        env: Record<string, string>;
        argv: string[];
      };
      // 用户自己的 Key 照旧继承；指向网关的残留被剔除；不带网关参数
      expect(o.env.OPENAI_API_KEY).toBe('sk-user-own-openai');
      expect(o.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(o.env.NOMI_GATEWAY_KEY).toBeUndefined();
      expect(o.argv.join(' ')).not.toContain('nomi_gateway');
      expect(fs.existsSync(codexConfigPath(home))).toBe(false);
      expect(fs.existsSync(codexAuthPath(home))).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
