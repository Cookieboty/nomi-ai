/**
 * 隐私 / 封号风险的硬约束（见 docs/features/privacy-security.md「订阅额度」）：
 * Nomi 在读取额度的全过程中，绝不打开任何登录凭据文件、不访问钥匙串、不发起任何 HTTP 请求；
 * 只会运行官方 CLI 的固定参数命令，由 CLI 自己用自己的登录态去取。
 */
jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
}));

const spawned: Array<{ cmd: string; args: string[] }> = [];
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof CP>('node:child_process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { promisify } = require('node:util') as typeof UTIL;
  const rec = (cmd: unknown, args: unknown) =>
    spawned.push({ cmd: String(cmd), args: Array.isArray(args) ? args.map(String) : [] });
  const spawn = ((cmd: string, args: string[], ...r: unknown[]) => {
    rec(cmd, args);
    return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, ...r);
  }) as typeof actual.spawn;
  const execFile = ((cmd: string, args: string[], ...r: unknown[]) => {
    rec(cmd, args);
    return (actual.execFile as (...a: unknown[]) => unknown)(cmd, args, ...r);
  }) as typeof actual.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: string[],
    ...r: unknown[]
  ) => {
    rec(cmd, args);
    return (
      (actual.execFile as unknown as Record<symbol, (...a: unknown[]) => unknown>)[
        promisify.custom
      ] as (...a: unknown[]) => unknown
    )(cmd, args, ...r);
  };
  return { ...actual, spawn, execFile };
});

import type * as CP from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type * as UTIL from 'node:util';

import ts from 'typescript';

import { CLAUDE_USAGE_ARGS } from '../../../src/usage/claudeSubscription';
import { CODEX_APP_SERVER_ARGS } from '../../../src/usage/codexRateLimits';
import { UsageService } from '../../../src/usage/UsageService';

const FORBIDDEN_PATH =
  /auth\.json|\.credentials\.json|credentials|keychain|\.netrc|id_token|\.ssh/i;
const FORBIDDEN_CMD =
  /security|find-generic-password|keychain|secret-tool|credential|auth\.json|cmdkey/i;

const FS_FUNCS = [
  'readFileSync',
  'readFile',
  'openSync',
  'open',
  'createReadStream',
  'statSync',
  'lstatSync',
  'stat',
  'existsSync',
  'accessSync',
  'readdirSync',
  'readlinkSync',
  'realpathSync',
  'copyFileSync',
  'cpSync',
] as const;

describe('绝不触碰登录凭据（mock fs / child_process 校验）', () => {
  const touched: string[] = [];
  const spies: jest.SpyInstance[] = [];
  let fetchSpy: jest.SpyInstance | undefined;

  const track = (v: unknown) => {
    if (typeof v === 'string') touched.push(v);
    else if (Buffer.isBuffer(v)) touched.push(v.toString());
    else if (v instanceof URL) touched.push(v.pathname);
  };

  // 放在测试内安装（项目的 jest 配置会在每个用例前还原 spy）
  const install = () => {
    for (const k of FS_FUNCS) {
      const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[k];
      spies.push(
        jest.spyOn(fs as never, k as never).mockImplementation(((...a: unknown[]) => {
          track(a[0]);
          if (k === 'copyFileSync' || k === 'cpSync') track(a[1]);
          return orig.apply(fs, a);
        }) as never),
      );
    }
    for (const k of ['readFile', 'open', 'stat', 'readdir', 'copyFile'] as const) {
      const orig = fs.promises[k] as unknown as (...a: unknown[]) => unknown;
      spies.push(
        jest.spyOn(fs.promises, k as never).mockImplementation(((...a: unknown[]) => {
          track(a[0]);
          return orig.apply(fs.promises, a);
        }) as never),
      );
    }
    fetchSpy = jest.spyOn(globalThis, 'fetch' as never).mockImplementation((() => {
      throw new Error('no network allowed');
    }) as never);
    spies.push(
      jest.spyOn(https, 'request').mockImplementation((() => {
        throw new Error('no network allowed');
      }) as never),
    );
  };
  afterAll(() => {
    for (const s of spies) s.mockRestore();
    fetchSpy?.mockRestore();
  });

  it('完整刷新流程（官方 CLI 为假脚本）：没打开 auth.json / .credentials.json / 钥匙串，没有任何 HTTP，命令只有固定参数', async () => {
    // 假 CLI 脚本靠 shebang + 可执行位启动，仅 POSIX 可用
    if (process.platform === 'win32') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-priv-bin-'));
    const claude = path.join(dir, 'claude');
    const codex = path.join(dir, 'codex');
    const node = process.execPath;
    fs.writeFileSync(
      claude,
      `#!${node}
const a=process.argv.slice(2);
if(a[0]==='auth')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',email:'me@example.com',orgId:'o',subscriptionType:'pro'}));
else console.log(JSON.stringify({type:'result',is_error:false,local_command:'usage',num_turns:0,result:'Current session: 9% used · resets 11pm (UTC)'}));`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      codex,
      `#!${node}
const a=process.argv.slice(2);
if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
let buf='';process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);
if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:3,windowDurationMins:300}},accountId:'a'}}));}});
process.stdin.on('end',()=>process.exit(0));`,
      { mode: 0o755 },
    );
    const prev = { c: process.env.NOMI_CLAUDE_BIN, x: process.env.NOMI_CODEX_BIN };
    process.env.NOMI_CLAUDE_BIN = claude;
    process.env.NOMI_CODEX_BIN = codex;
    try {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-priv-root-'));
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-priv-home-'));
      fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
      fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
      // 把「凭据文件」真的放在默认位置，看 Nomi 会不会碰它
      fs.writeFileSync(
        path.join(home, '.codex', 'auth.json'),
        '{"tokens":{"access_token":"SECRET"}}',
      );
      fs.writeFileSync(
        path.join(home, '.claude', '.credentials.json'),
        '{"claudeAiOauth":"SECRET"}',
      );
      const svc = new UsageService({
        root,
        home,
        dshHome: path.join(home, '.dsh'),
        scanMs: 0,
        logger: { info: jest.fn(), warn: jest.fn() },
      });
      install();
      touched.length = 0;
      spawned.length = 0;
      const r = await svc.refreshQuota();
      await svc.quotaView();
      svc.quotaHookStatus();

      // 流程确实跑通了（不是空转）
      expect(r.entries.find((e) => e.id === 'claude')).toMatchObject({ origin: 'usage-cmd' });
      expect(r.entries.find((e) => e.id === 'codex')).toMatchObject({ origin: 'app-server' });

      expect(touched.length).toBeGreaterThan(0);
      expect(touched.filter((p) => FORBIDDEN_PATH.test(p))).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(https.request).not.toHaveBeenCalled();

      const mine = spawned.filter((s) => s.cmd !== 'which' && s.cmd !== 'where');
      expect(mine.filter((s) => FORBIDDEN_CMD.test([s.cmd, ...s.args].join(' ')))).toEqual([]);
      const claudeCalls = mine.filter((s) => s.cmd === claude).map((s) => s.args);
      const codexCalls = mine.filter((s) => s.cmd === codex).map((s) => s.args);
      expect(mine.every((s) => s.cmd === claude || s.cmd === codex)).toBe(true);
      expect(claudeCalls).toContainEqual(['auth', 'status']);
      expect(claudeCalls).toContainEqual(CLAUDE_USAGE_ARGS);
      expect(
        claudeCalls.every(
          (a) => a.join(' ') === 'auth status' || a.join('\0') === CLAUDE_USAGE_ARGS.join('\0'),
        ),
      ).toBe(true);
      expect(codexCalls).toContainEqual(['login', 'status']);
      expect(codexCalls).toContainEqual(CODEX_APP_SERVER_ARGS);
      expect(
        codexCalls.every(
          (a) =>
            a.join(' ') === 'login status' || a.join('\0') === CODEX_APP_SERVER_ARGS.join('\0'),
        ),
      ).toBe(true);
      // 落盘的数据里没有任何凭据内容
      const saved = fs
        .readdirSync(root)
        .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
        .join('\n');
      expect(saved).not.toContain('SECRET');
      expect(saved).not.toContain('example.com');
    } finally {
      if (prev.c === undefined) delete process.env.NOMI_CLAUDE_BIN;
      else process.env.NOMI_CLAUDE_BIN = prev.c;
      if (prev.x === undefined) delete process.env.NOMI_CODEX_BIN;
      else process.env.NOMI_CODEX_BIN = prev.x;
    }
  }, 30_000);
});

describe('源码级约束：用量模块里没有凭据路径 / 未文档接口 / 网络调用', () => {
  const dir = path.resolve(__dirname, '../../../src/usage');
  // 去掉注释后再扫（注释里允许写「不碰 auth.json」这样的说明）
  const code = (f: string) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    return ts.createPrinter({ removeComments: true }).printFile(sf);
  };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const FORBIDDEN = [
    'wham',
    'oauth/usage',
    'backend-api',
    'chatgpt.com',
    'api.anthropic.com',
    'auth.json',
    '.credentials.json',
    'find-generic-password',
    'Authorization',
    'access_token',
    'refresh_token',
  ];

  it.each(files)('%s', (f) => {
    const c = code(f);
    for (const bad of FORBIDDEN) expect(c).not.toContain(bad);
    // 不是 `.fetch(`（本模块里 Fetcher 的方法名），而是全局 fetch(...) 调用
    // 唯一例外：priceSync.ts（用户手动点「同步价格」才下载 models.dev 的公开价格表，见下一条测试）
    if (f !== 'priceSync.ts') expect(c).not.toMatch(/(?<![.\w])(?<!async )fetch\s*\(/);
    expect(c).not.toMatch(/globalThis\.fetch|XMLHttpRequest|WebSocket/);
    expect(c).not.toMatch(/node:https?['"]/);
    expect(c).not.toMatch(/from 'electron'.*\bnet\b/);
  });
});

describe('源码级约束：价格同步（priceSync.ts）只做一次公开 GET', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../src/usage/priceSync.ts'), 'utf8');
  const sf = ts.createSourceFile('priceSync.ts', text, ts.ScriptTarget.Latest, true);
  const code = ts.createPrinter({ removeComments: true }).printFile(sf);

  it('只有一个 URL（models.dev），GET，不带 cookie / 凭据 / 请求体 / 定时器', () => {
    expect(code.match(/https?:\/\/[^'"`\s]+/g)).toEqual(['https://models.dev/api.json']);
    expect(code).toContain("method: 'GET'");
    expect(code).toContain("credentials: 'omit'");
    expect(code).not.toMatch(/[,{]\s*body\s*:/);
    expect(code).not.toMatch(/cookie|setInterval|setTimeout\(.*sync|method: '(POST|PUT|PATCH)'/i);
    // 全局 fetch 只在「默认 fetchImpl」里出现一次
    expect(code.match(/(?<![.\w])fetch\s*\(/g)).toHaveLength(1);
  });

  it('只被用户点击触发：UsageService 里只有 IPC 处理器调用 syncPrices，没有定时 / 启动调用', () => {
    const svc = fs.readFileSync(
      path.resolve(__dirname, '../../../src/usage/UsageService.ts'),
      'utf8',
    );
    const calls = svc.match(/syncPrices\(|priceSync\.sync\(/g) ?? [];
    expect(calls).toHaveLength(3); // 方法定义 + 其中的 priceSync.sync() + IPC 处理器
    expect(svc).toMatch(/handle\('ai:usage:price-sync', \(\) => this\.syncPrices\(\)\)/);
  });
});

describe('源码级约束：SQLite 来源（sqliteRead.ts）只读、只取记账列', () => {
  const text = fs.readFileSync(path.resolve(__dirname, '../../../src/usage/sqliteRead.ts'), 'utf8');
  const sf = ts.createSourceFile('sqliteRead.ts', text, ts.ScriptTarget.Latest, true);
  const code = ts.createPrinter({ removeComments: true }).printFile(sf);

  it('只以 readOnly 打开，所有 SQL 都是 SELECT，没有写操作 / PRAGMA / ATTACH', () => {
    expect(code).toContain('readOnly: true');
    expect(code.match(/new Ctor\(/g)).toHaveLength(1);
    const sqls = [...code.matchAll(/`(\s*SELECT[^`]*)`/g)].map((m) => m[1]!);
    expect(sqls).toHaveLength(2);
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH|VACUUM)\b/,
    );
    expect(code).not.toMatch(/\.exec\(|DatabaseSync\s*\(/);
  });

  it('SELECT 里只出现记账列：没有 data 整列、没有凭据 / 内容类字段', () => {
    const sqls = [...code.matchAll(/`(\s*SELECT[^`]*)`/g)].map((m) => m[1]!).join('\n');
    const bare = sqls.replace(/json_(extract|valid)\(data(,'[^']+')?\)/g, '');
    expect(bare).not.toMatch(/SELECT\s+\*|\bdata\b/i);
    expect(sqls).not.toMatch(
      /token\b|secret|password|api_?key|auth|cookie|content|prompt|text|summary/i,
    );
    // json_extract 只取这些路径
    const paths = [...sqls.matchAll(/json_extract\(data,'([^']+)'\)/g)].map((m) => m[1]);
    expect(new Set(paths)).toEqual(
      new Set([
        '$.role',
        '$.time.created',
        '$.modelID',
        '$.providerID',
        '$.tokens.input',
        '$.tokens.output',
        '$.tokens.reasoning',
        '$.tokens.cache.read',
        '$.tokens.cache.write',
        '$.path.cwd',
      ]),
    );
  });
});
