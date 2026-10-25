import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CliMainHost } from '@nomi-ai/cli-sdk';
import { checkPlugin, type HistoryFixture } from '@nomi-ai/cli-sdk/testing';
import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_IDS, BUILTIN_MANIFESTS, BUILTIN_RENDERER, terminalLine } from '../src';
import { BUILTIN_PLUGINS, claude, codex, dsh, gemini, grok } from '../src/main';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const touch = (f: string) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{}\n');
};
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

const FIXTURES = path.resolve(__dirname, '../fixtures/history');
const HOST: CliMainHost = {
  logger: { info() {}, warn() {} },
  dataDir: os.tmpdir(),
  home: os.tmpdir(),
  env: {},
  platform: 'linux',
};

function fixturesOf(id: string): HistoryFixture[] {
  const dir = path.join(FIXTURES, id);
  const out: HistoryFixture[] = [];
  for (const version of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const expect = JSON.parse(fs.readFileSync(path.join(dir, version, 'expect.json'), 'utf8'));
    for (const [file, e] of Object.entries(expect as Record<string, HistoryFixture['expect']>))
      out.push({
        name: `${id}/${version}/${file}`,
        path: path.join(dir, version, file),
        text: fs.readFileSync(path.join(dir, version, file), 'utf8'),
        expect: e,
      });
  }
  return out;
}

describe('内置插件契约（§9.1）', () => {
  for (const id of BUILTIN_CLI_IDS)
    it(`${id}：清单、能力位与实现、启动注入、权限、账号目录、历史夹具`, async () => {
      const historyFixtures = fixturesOf(id);
      expect(historyFixtures.length).toBeGreaterThan(0);
      expect(await checkPlugin(BUILTIN_PLUGINS[id], { historyFixtures })).toEqual([]);
      expect(BUILTIN_MANIFESTS[id].id).toBe(id);
      expect(BUILTIN_RENDERER[id].id).toBe(id);
    });

  // 转录解析搬进插件后逐条消息不变（快照；CLI 改格式时新增版本目录，旧快照保留）
  for (const id of BUILTIN_CLI_IDS)
    it(`${id}：历史夹具逐条解析结果`, async () => {
      const parse = (await BUILTIN_PLUGINS[id].main!(HOST)).history!.parse!;
      const out = fixturesOf(id).map((f) => ({
        name: f.name,
        parsed: parse(f.text, { path: f.path!, mtime: 0, size: f.text.length }),
      }));
      expect(out).toMatchSnapshot();
    });

  it("modelSwitch 'gateway' 必须有占位模型名，且与网关客户端规格一致（§6.7）", async () => {
    expect(BUILTIN_MANIFESTS.grok.modelSwitch).toBe('gateway');
    const missing = await checkPlugin(BUILTIN_PLUGINS.grok, {
      extend: (impl) => ({ ...impl, launch: { ...impl.launch, placeholderModel: undefined } }),
    });
    expect(missing).toContain("modelSwitch 'gateway' requires launch.placeholderModel");
    const differ = await checkPlugin(BUILTIN_PLUGINS.grok, {
      extend: (impl) => ({ ...impl, launch: { ...impl.launch, placeholderModel: 'other' } }),
    });
    expect(differ).toContain('launch.placeholderModel (other) differs from clientSpec (nomi)');
  });

  it('生成的 id 列表是最新的', () => {
    const script = path.resolve(__dirname, '../scripts/gen-ids.mjs');
    expect(() => execFileSync(process.execPath, [script, '--check'])).not.toThrow();
  });
});

describe('权限档位（与迁移前主进程的结果一致）', () => {
  it('Claude / Grok / Gemini / Codex / dsh 的启动注入与 mode id', () => {
    expect(claude.permissions.launch('bypass').args).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(grok.permissions.launch('bypass').args).toEqual(['--yolo']);
    expect(grok.permissions.modeId!('manual')).toBe('default');
    expect(gemini.permissions.modeId!('acceptEdits')).toBe('autoEdit');
    expect(codex.permissions.launch('auto').args).toEqual([
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'approvals_reviewer="auto_review"',
    ]);
    expect(codex.permissions.launch('acceptEdits', { network: false }).args).toEqual([
      '-c',
      'sandbox_mode="workspace-write"',
    ]);
    expect(dsh.permissions.launch('plan').env).toEqual({ DSH_PERMISSION_MODE: 'read-only' });
    // Codex 的 on-request 是自动审批，其它 CLI 是逐项确认
    expect(codex.permissions.fromModeId!('on-request')).toBe('auto');
    expect(claude.permissions.fromModeId!('on-request')).toBe('manual');
    // 不支持的档位只往更安全的一侧降
    expect(dsh.permissions.fromModeId!('default')).toBe('plan');
    expect(grok.permissions.fromModeId!('auto')).toBe('acceptEdits');
  });
});

describe('历史会话扫描（只读目录，不读内容）', () => {
  it('五个 CLI 各自的目录布局', async () => {
    const home = tmp('cli-plugins-home-');
    touch(path.join(home, '.claude/projects/-w/aaa.jsonl'));
    touch(path.join(home, '.claude/projects/-w/notes.txt'));
    touch(path.join(home, '.codex/sessions/2026/10/24/rollout-1.jsonl'));
    touch(path.join(home, '.codex/sessions/2026/10/24/rollout-2.jsonl.zst'));
    touch(path.join(home, '.grok/sessions/w/s1/updates.jsonl'));
    touch(path.join(home, '.gemini/tmp/p/chats/session-1.jsonl'));
    touch(path.join(home, '.gemini/tmp/p/chats/sub/x.jsonl'));
    touch(path.join(home, '.dsh/sessions/w/session-1/session.v4.jsonl'));
    const env = {};
    const names = async (h: typeof claude.history) =>
      (await collect(h.scan(h.roots(env, home)[0]!))).map((f) => path.basename(f.path)).sort();
    expect(await names(claude.history)).toEqual(['aaa.jsonl']);
    expect(await names(codex.history)).toEqual(['rollout-1.jsonl', 'rollout-2.jsonl.zst']);
    expect(await names(grok.history)).toEqual(['updates.jsonl']);
    expect(await names(gemini.history)).toEqual(['session-1.jsonl']);
    expect(await names(dsh.history)).toEqual(['session.v4.jsonl']);
    const [g] = await collect(grok.history.scan(grok.history.roots(env, home)[0]!));
    expect(g!.dirId).toBe('s1');
    // 尊重 CLI 的目录变量
    expect(claude.history.roots({ CLAUDE_CONFIG_DIR: '/x/claude' }, home)).toEqual([
      path.resolve('/x/claude/projects'),
    ]);
    // 目录不存在不报错
    expect(await collect(claude.history.scan(path.join(home, 'nope')))).toEqual([]);
  });
});

describe('模型覆盖参数与斜杠命令布局（与迁移前主进程的结果一致）', () => {
  it('modelArgs：Claude / Codex / Grok 各自的参数；Gemini / dsh 没有', () => {
    expect(claude.modelArgs({ model: 'opus', effort: 'high' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
    expect(codex.modelArgs({ model: 'gpt-"5"', effort: 'low' })).toEqual([
      '-c',
      'model="gpt-\\"5\\""',
      '-c',
      'model_reasoning_effort="low"',
    ]);
    expect(grok.modelArgs({ model: ' grok-4 ', effort: null })).toEqual(['-m', 'grok-4']);
    expect('modelArgs' in gemini).toBe(false);
    expect('modelArgs' in dsh).toBe(false);
  });

  it('slash.sources：项目目录链在前、用户级在后，Grok 带自带的 bundled', () => {
    const o = { projectChain: ['/w/a', '/w'], home: '/h' };
    const kinds = (s: { kind: string; path: string; scope: string }[]) =>
      s.map((x) => `${x.scope}:${x.kind}:${x.path.replace(/\\/g, '/')}`);
    expect(kinds(claude.slash.sources!(o))).toEqual([
      'project:skills:/w/a/.claude/skills',
      'project:commands:/w/a/.claude/commands',
      'project:agents:/w/a/.claude/agents',
      'project:mcp:/w/a/.mcp.json',
      'project:skills:/w/.claude/skills',
      'project:commands:/w/.claude/commands',
      'project:agents:/w/.claude/agents',
      'project:mcp:/w/.mcp.json',
      'user:skills:/h/.claude/skills',
      'user:commands:/h/.claude/commands',
      'user:agents:/h/.claude/agents',
    ]);
    expect(kinds(codex.slash.sources!(o))).toEqual([
      'project:skills:/w/a/.agents/skills',
      'project:skills:/w/.agents/skills',
      'user:skills:/h/.agents/skills',
    ]);
    const g = grok.slash.sources!(o);
    expect(kinds(g).slice(-2)).toEqual([
      'bundled:skills:/h/.grok/bundled/skills',
      'bundled:workflows:/h/.grok/bundled/workflows',
    ]);
    expect(g.filter((x) => x.kind === 'skills').every((x) => x.strictInvocable)).toBe(true);
  });
});

describe('终端命令', () => {
  it('POSIX / PowerShell 转义，只含路径', () => {
    const c = claude.createMain().terminal!.command({ cwd: '/w', env: {}, resumeId: 's1' });
    expect(terminalLine({ ...c, env: { CLAUDE_CONFIG_DIR: "/a b/it's" } }, 'darwin')).toBe(
      `CLAUDE_CONFIG_DIR='/a b/it'\\''s' claude '--resume' 's1'`,
    );
    expect(terminalLine({ ...c, env: { CLAUDE_CONFIG_DIR: 'C:\\a' } }, 'win32')).toBe(
      `$env:CLAUDE_CONFIG_DIR='C:\\a'; claude '--resume' 's1'`,
    );
  });

  it.each([
    {
      platform: 'darwin' as const,
      env: { A: "x'y", B: '$(id)' },
      expect: `A='x'\\''y' B='$(id)' claude '--resume' 's1'`,
    },
    {
      platform: 'win32' as const,
      env: { A: "x'y", B: '$null' },
      expect: `$env:A='x''y'; $env:B='$null'; claude '--resume' 's1'`,
    },
  ])('table-driven terminalLine quoting ($platform)', ({ platform, env, expect: exp }) => {
    const c = claude.createMain().terminal!.command({ cwd: '/w', env: {}, resumeId: 's1' });
    expect(terminalLine({ ...c, env }, platform)).toBe(exp);
  });
});
