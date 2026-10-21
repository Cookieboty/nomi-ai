/**
 * #58：从 Claude Code / Codex 导入 MCP 服务器与技能。
 * - 发现：用户 / 本机项目 / 项目作用域、Codex TOML、技能目录；
 * - 安全（#16）：符号链接逃逸、改名成凭据文件、凭据类文件不复制；~/.claude.json 其余内容不外泄；
 * - 导入：跳过 / 重命名 / 覆盖；密钥走 safeStorage，不可用时拒绝（#35）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

const safe = { available: true };

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  ClipboardItem: class {},
  clipboard: {},
  dialog: {},
  nativeImage: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => Buffer.from(`CIPHER<${s}>`),
    decryptString: (b: Buffer) =>
      b
        .toString('utf8')
        .replace(/^CIPHER</, '')
        .replace(/>$/, ''),
  },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExtensionsService } from '../../../src/extensions/ExtensionsService';
import { isSecretValue } from '../../../src/extensions/mcpConfig';
import {
  discoverMigrations,
  fromClaudeEntry,
  fromCodexEntry,
  nomiSkillName,
  readConfigFile,
} from '../../../src/extensions/migrate';

const SECRET = 'sk-ant-TESTSECRET0123456789abcdef';
let tmp: string;
let home: string;
let proj: string;
let ud: string;

const w = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const skill = (dir: string, md: string, extra: Record<string, string> = {}) => {
  w(path.join(dir, 'SKILL.md'), md);
  for (const [k, v] of Object.entries(extra)) w(path.join(dir, k), v);
};
const canLink = (() => {
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'));
    fs.symlinkSync(d, path.join(d, 'x'));
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();
const itLink = canLink ? it : it.skip;

beforeEach(() => {
  safe.available = true;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-migrate-')));
  home = path.join(tmp, 'home');
  proj = path.join(tmp, 'proj');
  ud = path.join(tmp, 'ud');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function claudeJson() {
  w(
    path.join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        emailAddress: 'me@example.com',
        accessToken: 'ACCOUNT_TOKEN_SHOULD_NOT_LEAK',
      },
      mcpServers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET },
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: `Bearer ${SECRET}` },
        },
        legacy: { url: 'https://old.example.com/mcp' },
        socket: { type: 'ws', url: 'wss://x.example.com' },
        envref: { command: 'node', args: ['${HOME}/srv.js'], env: { KEY: '${API_KEY}' } },
      },
      projects: {
        '/work/app': { mcpServers: { db: { command: 'pg-mcp' } }, history: ['secret prompt'] },
      },
    }),
  );
}

describe('discoverMigrations', () => {
  it('Claude Code：user / local / project 作用域，只取 mcpServers', () => {
    claudeJson();
    w(
      path.join(proj, '.mcp.json'),
      JSON.stringify({ mcpServers: { files: { command: 'fs-mcp' } } }),
    );
    const scan = discoverMigrations({ home, env: {}, projectDir: proj });
    const by = Object.fromEntries(scan.mcp.map((c) => [`${c.scope}:${c.name}`, c]));
    expect(Object.keys(by).sort()).toEqual(
      [
        'local:db',
        'project:files',
        'user:envref',
        'user:github',
        'user:legacy',
        'user:remote',
        'user:socket',
      ].sort(),
    );
    expect(by['user:github']!.server).toMatchObject({ transport: 'stdio', command: 'npx' });
    expect(by['user:remote']!.server).toMatchObject({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
    });
    expect(by['user:legacy']!.warnings.join()).toContain('缺少 type');
    expect(by['user:socket']!.error).toContain('ws');
    expect(by['user:envref']!.warnings.join()).toContain('${API_KEY}');
    expect(by['local:db']!.where).toContain('/work/app');
    // 账号信息 / 历史不在结果里
    expect(JSON.stringify(scan)).not.toContain('ACCOUNT_TOKEN_SHOULD_NOT_LEAK');
    expect(JSON.stringify(scan)).not.toContain('secret prompt');
    // 不暴露真实主目录
    expect(scan.sources.map((s) => s.where)).toContain('~/.claude.json');
  });

  it('CLAUDE_CONFIG_DIR 与 CODEX_HOME', () => {
    const cdir = path.join(home, 'cfg-claude');
    const xdir = path.join(home, 'cfg-codex');
    w(path.join(cdir, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    w(path.join(xdir, 'config.toml'), '[mcp_servers.b]\ncommand = "b"\n');
    const scan = discoverMigrations({ home, env: { CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir } });
    expect(scan.mcp.map((c) => `${c.tool}:${c.name}`).sort()).toEqual(['claude:a', 'codex:b']);
  });

  it('两个 Claude 配置文件里的同名条目：key 各不相同，配置各自来自自己的文件（#74）', () => {
    const cdir = path.join(home, 'cfg-claude');
    const both = (cmd: string) =>
      JSON.stringify({
        mcpServers: { docs: { command: cmd } },
        projects: { '/work/app': { mcpServers: { db: { command: `${cmd}-db` } } } },
      });
    w(path.join(cdir, '.claude.json'), both('custom-mcp'));
    w(path.join(home, '.claude.json'), both('default-mcp'));
    const scan = discoverMigrations({ home, env: { CLAUDE_CONFIG_DIR: cdir } });
    const docs = scan.mcp.filter((c) => c.name === 'docs');
    const db = scan.mcp.filter((c) => c.name === 'db');
    expect(docs).toHaveLength(2);
    expect(db).toHaveLength(2);
    expect(new Set(scan.mcp.map((c) => c.key)).size).toBe(scan.mcp.length);
    const custom = docs.find((c) => c.where.includes('cfg-claude'))!;
    const dflt = docs.find((c) => c.where === '~/.claude.json')!;
    expect(custom.server).toMatchObject({ command: 'custom-mcp' });
    expect(dflt.server).toMatchObject({ command: 'default-mcp' });
    expect(db.find((c) => c.where.includes('cfg-claude'))!.server).toMatchObject({
      command: 'custom-mcp-db',
    });
    // key 里没有路径；重扫后不变
    expect(scan.mcp.map((c) => c.key).join()).not.toContain(home);
    const again = discoverMigrations({ home, env: { CLAUDE_CONFIG_DIR: cdir } });
    expect(again.mcp.map((c) => c.key)).toEqual(scan.mcp.map((c) => c.key));
  });

  it('Codex config.toml：stdio / http、停用、env 转发与 bearer 提示', () => {
    w(
      path.join(home, '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        '[mcp_servers.docs]',
        'command = "npx"',
        'args = ["-y", "docs-mcp"]',
        'env_vars = ["PATH_EXTRA"]',
        'cwd = "/tmp"',
        '[mcp_servers.docs.env]',
        `API_KEY = "${SECRET}"`,
        '[mcp_servers.figma]',
        'url = "https://mcp.figma.com/mcp"',
        'bearer_token_env_var = "FIGMA_TOKEN"',
        'enabled = false',
        '[mcp_servers.figma.http_headers]',
        'X-Region = "us"',
      ].join('\n'),
    );
    w(path.join(proj, '.codex', 'config.toml'), '[mcp_servers.local]\ncommand = "x"\n');
    const scan = discoverMigrations({ home, env: {}, projectDir: proj });
    const by = Object.fromEntries(scan.mcp.map((c) => [`${c.scope}:${c.name}`, c]));
    expect(by['user:docs']!.server).toMatchObject({ transport: 'stdio', env: { API_KEY: SECRET } });
    expect(by['user:docs']!.warnings.join()).toMatch(/PATH_EXTRA[\s\S]*cwd/);
    expect(by['user:figma']!.server).toMatchObject({
      transport: 'http',
      headers: { 'X-Region': 'us' },
    });
    expect(by['user:figma']!.warnings.join()).toMatch(/FIGMA_TOKEN[\s\S]*停用/);
    expect(by['project:local']).toBeDefined();
  });

  it('TOML / JSON 写坏了只报这个来源', () => {
    w(path.join(home, '.codex', 'config.toml'), '[mcp_servers.x\ncommand=');
    w(path.join(home, '.claude.json'), '{nope');
    const scan = discoverMigrations({ home, env: {} });
    expect(scan.mcp).toEqual([]);
    expect(
      scan.sources
        .filter((s) => s.error)
        .map((s) => s.where)
        .sort(),
    ).toEqual(['~/.claude.json', '~/.codex/config.toml']);
  });

  it('技能：Claude / Codex 目录、名称规整、凭据文件跳过、脚本提示', () => {
    skill(
      path.join(home, '.claude', 'skills', 'PDF Tools'),
      '---\nname: PDF Tools\ndescription: >\n  Work with PDFs\nallowed-tools: Bash\n---\n# PDF\nBody',
      {
        'scripts/run.py': 'print(1)',
        '.env': `KEY=${SECRET}`,
        id_rsa: 'PRIVATE',
      },
    );
    skill(
      path.join(home, '.agents', 'skills', 'review'),
      '---\nname: review\ndescription: Code review\n---\nDo it',
    );
    skill(
      path.join(home, '.agents', 'skills', 'nodesc'),
      '---\nname: nodesc\n---\n\n# First line here\n',
    );
    w(path.join(home, '.agents', 'skills', 'notaskill', 'README.md'), 'x');
    const scan = discoverMigrations({ home, env: {} });
    const by = Object.fromEntries(scan.skills.map((c) => [c.name, c]));
    expect(Object.keys(by).sort()).toEqual(['nodesc', 'pdf-tools', 'review']);
    const pdf = by['pdf-tools']!;
    expect(pdf.tool).toBe('claude');
    expect(pdf.normalize).toBe(true);
    expect(pdf.files).toEqual(['scripts/run.py']);
    expect(pdf.warnings.join()).toMatch(/id_rsa[\s\S]*脚本[\s\S]*allowed-tools/);
    expect(pdf.warnings.join()).toContain('名称已调整');
    expect(by.review!.normalize).toBe(false);
    expect(by.nodesc!.description).toBe('First line here');
  });

  itLink('项目技能链接到项目外被拒；用户技能可以链接到别处', () => {
    const outside = path.join(tmp, 'outside', 'evil');
    skill(outside, '---\nname: evil\ndescription: x\n---\n');
    fs.mkdirSync(path.join(proj, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(proj, '.claude', 'skills', 'evil'));
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, '.claude', 'skills', 'shared'));
    const scan = discoverMigrations({ home, env: {}, projectDir: proj });
    const user = scan.skills.find((c) => c.scope === 'user')!;
    const project = scan.skills.find((c) => c.scope === 'project')!;
    expect(user.error).toBeUndefined();
    expect(project.error).toContain('符号链接');
  });

  itLink('配置文件是指向凭据 / 主目录外的符号链接时拒读', () => {
    w(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(home, '.claude.json'));
    const out = path.join(tmp, 'elsewhere', 'config.toml');
    w(out, '[mcp_servers.a]\ncommand="a"\n');
    fs.mkdirSync(path.join(home, '.codex'));
    fs.symlinkSync(out, path.join(home, '.codex', 'config.toml'));
    const scan = discoverMigrations({ home, env: {} });
    expect(scan.mcp).toEqual([]);
    expect(scan.sources.filter((s) => s.error)).toHaveLength(2);
    expect(JSON.stringify(scan)).not.toContain('PRIVATE');
    // 改名伪装：链接到一个叫 .claude.json 的 .credentials 目录里的文件也不行
    const cred = path.join(home, '.aws', '.claude.json');
    w(cred, '{"mcpServers":{}}');
    expect(readConfigFile(cred, 1024, [home])).toHaveProperty('error');
  });

  it('readConfigFile：缺失 / 太大 / 不是普通文件', () => {
    expect(readConfigFile(path.join(home, 'none.json'), 10, [home])).toEqual({ missing: true });
    w(path.join(home, 'big.json'), 'x'.repeat(100));
    expect(readConfigFile(path.join(home, 'big.json'), 10, [home])).toHaveProperty('error');
    fs.mkdirSync(path.join(home, 'dir.json'));
    expect(readConfigFile(path.join(home, 'dir.json'), 10, [home])).toHaveProperty('error');
    w(path.join(tmp, 'x.json'), '{}');
    expect(readConfigFile(path.join(tmp, 'x.json'), 10, [home])).toHaveProperty('error');
  });
});

describe('converters', () => {
  it('Claude 条目', () => {
    expect(fromClaudeEntry('a', { type: 'sse', url: 'https://a/sse' }).raw).toMatchObject({
      transport: 'sse',
    });
    expect(fromClaudeEntry('a', { type: 'streamable-http', url: 'https://a' }).raw).toMatchObject({
      transport: 'http',
    });
    expect(fromClaudeEntry('a', { type: 'sdk' }).error).toBeTruthy();
    expect(fromClaudeEntry('a', 'nope').error).toBeTruthy();
    expect(
      fromClaudeEntry('a', { url: 'https://a', oauth: { clientId: 'x' }, headersHelper: 'x.sh' })
        .warnings,
    ).toHaveLength(3);
  });
  it('Codex 条目', () => {
    expect(fromCodexEntry('a', { url: 'https://a/sse' }).raw).toMatchObject({ transport: 'sse' });
    expect(
      fromCodexEntry('a', { url: 'https://a', env_http_headers: { 'X-Key': 'K' } }).warnings.join(),
    ).toContain('X-Key');
    expect(fromCodexEntry('a', { command: 'x', enabled: false }).disabled).toBe(true);
  });
  it('技能名规整', () => {
    expect(nomiSkillName('My  Cool_Skill!')).toBe('my-cool-skill');
    expect(nomiSkillName('---')).toBe('');
  });
  it('isSecretValue', () => {
    expect(isSecretValue(SECRET)).toBe(true);
    expect(isSecretValue('Bearer abcdefgh12')).toBe(true);
    expect(isSecretValue('Bearer x')).toBe(false);
    expect(isSecretValue('ghp_abcdefghijklmnop')).toBe(true);
    expect(isSecretValue('https://u:p@a.b')).toBe(true);
    expect(isSecretValue('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(true);
    expect(isSecretValue('1')).toBe(false);
    expect(isSecretValue('us-east-1')).toBe(false);
    expect(isSecretValue('/usr/local/bin/some-long-command-path')).toBe(false);
  });
});

describe('ExtensionsService migrate', () => {
  function makeExt(
    pick: string | null = null,
    env: Record<string, string> = {},
  ): ExtensionsService {
    return new ExtensionsService({
      root: path.join(ud, 'extensions'),
      skillsRoot: path.join(ud, 'skills'),
      logger: { info() {}, warn() {}, error() {} } as never,
      desktop: { audit: { append: jest.fn() } } as never,
      home: () => home,
      env: () => env,
      pickDir: async () => pick,
    });
  }
  const mcpFile = () => fs.readFileSync(path.join(ud, 'extensions', 'mcp.json'), 'utf8');

  it('扫描结果脱敏、不含路径；导入后默认不连接、密钥加密落盘', async () => {
    claudeJson();
    const ext = makeExt();
    const scan = await ext.migrateScan();
    const text = JSON.stringify(scan);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(home);
    const gh = scan.mcp.find((m) => m.name === 'github')!;
    expect(gh.preview!.env!.GITHUB_PERSONAL_ACCESS_TOKEN).not.toBe(SECRET);
    const r = await ext.migrateImport([
      { key: gh.key },
      { key: scan.mcp.find((m) => m.name === 'remote')!.key },
    ]);
    expect(r.imported.map((x) => x.name)).toEqual(['github', 'remote']);
    expect(mcpFile()).not.toContain(SECRET);
    expect(mcpFile()).toContain('enc:');
    const listed = ext.listMcp().servers;
    expect(listed.every((s) => s.enabled === false)).toBe(true);
    // 重新加载后能解出原值
    const again = makeExt();
    expect(JSON.stringify((again as unknown as { servers: unknown[] }).servers)).toContain(SECRET);
  });

  it('选中自定义配置目录里的那一行，导入的就是它的配置（#74）', async () => {
    const cdir = path.join(home, 'cfg-claude');
    w(
      path.join(cdir, '.claude.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'custom-mcp' } } }),
    );
    w(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'default-mcp' } } }),
    );
    const ext = makeExt(null, { CLAUDE_CONFIG_DIR: cdir });
    const scan = await ext.migrateScan();
    const rows = scan.mcp.filter((m) => m.name === 'docs');
    expect(rows).toHaveLength(2);
    const custom = rows.find((m) => m.where.includes('cfg-claude'))!;
    expect(custom.preview!.command).toBe('custom-mcp');
    const r = await ext.migrateImport([{ key: custom.key }]);
    expect(r.imported).toHaveLength(1);
    const saved = ext.listMcp().servers.find((s) => s.name === 'docs')!;
    expect(saved.command).toBe('custom-mcp');
    expect(saved.enabled).toBe(false);
  });

  it('safeStorage 不可用时拒绝导入带密钥的服务，不写明文', async () => {
    claudeJson();
    safe.available = false;
    const ext = makeExt();
    const scan = await ext.migrateScan();
    const pick = (n: string) => ({ key: scan.mcp.find((m) => m.name === n)!.key });
    const r = await ext.migrateImport([pick('github'), pick('legacy')]);
    expect(r.failed.map((x) => x.name)).toEqual(['github']);
    expect(r.failed[0]!.error).toMatch(/安全存储不可用/);
    expect(r.imported.map((x) => x.name)).toEqual(['legacy']);
    expect(mcpFile()).not.toContain(SECRET);
  });

  it('MCP 同名冲突：跳过 / 重命名 / 覆盖', async () => {
    w(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { files: { command: 'new-cmd' } } }),
    );
    const ext = makeExt();
    ext.upsert({ name: 'files', command: 'old-cmd' });
    const scan = await ext.migrateScan();
    const key = scan.mcp[0]!.key;
    expect(scan.mcp[0]!.conflict).toBe(true);
    expect((await ext.migrateImport([{ key }])).skipped).toHaveLength(1);
    expect((await ext.migrateImport([{ key, action: 'rename' }])).imported[0]!.name).toBe(
      'files (Claude Code)',
    );
    await ext.migrateScan();
    await ext.migrateImport([{ key, action: 'overwrite' }]);
    const list = ext.listMcp().servers;
    expect(list.find((s) => s.id === 'files')!.command).toBe('new-cmd');
    expect(list.filter((s) => s.name.startsWith('files'))).toHaveLength(2);
  });

  it('技能：复制快照、不复制凭据文件；跳过 / 重命名 / 覆盖', async () => {
    const src = path.join(home, '.claude', 'skills', 'trip');
    skill(src, '---\nname: trip\ndescription: |\n  Plan trips\n---\n# Trip\nbody', {
      'ref/notes.md': 'notes',
      '.env': 'SECRET=1',
      'credentials.json': '{}',
    });
    const ext = makeExt();
    let scan = await ext.migrateScan();
    const key = scan.skills[0]!.key;
    expect((await ext.migrateImport([{ key }])).imported[0]!.name).toBe('trip');
    const dest = path.join(ud, 'skills', 'trip');
    expect(fs.readFileSync(path.join(dest, 'ref', 'notes.md'), 'utf8')).toBe('notes');
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'credentials.json'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toMatch(/description: Plan trips/);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    // 原文件之后的修改不影响已导入的副本
    fs.writeFileSync(path.join(src, 'ref', 'notes.md'), 'changed');
    expect(fs.readFileSync(path.join(dest, 'ref', 'notes.md'), 'utf8')).toBe('notes');

    scan = await ext.migrateScan();
    expect(scan.skills[0]!.conflict).toBe(true);
    expect((await ext.migrateImport([{ key }])).skipped).toHaveLength(1);
    const renamed = await ext.migrateImport([{ key, action: 'rename' }]);
    expect(renamed.failed).toEqual([]);
    expect(renamed.imported[0]!.name).toBe('trip-claude');
    expect(fs.readFileSync(path.join(ud, 'skills', 'trip-claude', 'SKILL.md'), 'utf8')).toContain(
      'name: trip-claude',
    );
    await ext.migrateImport([{ key, action: 'overwrite' }]);
    expect(fs.readFileSync(path.join(dest, 'ref', 'notes.md'), 'utf8')).toBe('changed');
    const names = ext.listSkills().map((s) => s.name);
    expect(names.filter((n) => n.startsWith('trip')).sort()).toEqual(['trip', 'trip-claude']);
    expect(ext.listSkills().every((s) => !s.error)).toBe(true);
    expect(fs.readdirSync(path.join(ud, 'skills')).filter((n) => n.startsWith('.import-'))).toEqual(
      [],
    );
  });

  itLink('技能：扫描后源目录被换成链接则拒绝', async () => {
    const src = path.join(home, '.claude', 'skills', 'x');
    skill(src, '---\nname: x\ndescription: d\n---\n', { 'a.md': 'a' });
    const ext = makeExt();
    const scan = await ext.migrateScan();
    fs.rmSync(path.join(src, 'a.md'));
    w(path.join(home, 'secret.txt'), 'S');
    fs.symlinkSync(path.join(home, 'secret.txt'), path.join(src, 'a.md'));
    const r = await ext.migrateImport([{ key: scan.skills[0]!.key }]);
    expect(r.failed).toHaveLength(1);
    expect(fs.existsSync(path.join(ud, 'skills', 'x'))).toBe(false);
  });

  it('项目文件夹由主进程对话框选择，界面只看到文件夹名', async () => {
    w(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { p: { command: 'p' } } }));
    skill(path.join(proj, '.agents', 'skills', 'ps'), '---\nname: ps\ndescription: d\n---\n');
    const ext = makeExt(proj);
    const scan = await ext.migrateScan({ pickProject: true });
    expect(scan.project).toBe('proj');
    expect(scan.mcp.map((m) => m.name)).toEqual(['p']);
    expect(scan.skills.map((s) => `${s.tool}:${s.name}`)).toEqual(['codex:ps']);
    expect(JSON.stringify(scan)).not.toContain(tmp);
    const cleared = await ext.migrateScan({ clearProject: true });
    expect(cleared.project).toBeNull();
    expect(cleared.mcp).toEqual([]);
  });

  it('未知 key 被忽略', async () => {
    const ext = makeExt();
    await ext.migrateScan();
    expect(await ext.migrateImport([{ key: 'nope' }, null as never])).toEqual({
      imported: [],
      skipped: [],
      failed: [],
    });
  });
});
