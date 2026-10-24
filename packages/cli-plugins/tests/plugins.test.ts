import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkPlugin } from '@nomi-ai/cli-sdk/testing';
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

describe('内置插件契约（§9.1）', () => {
  for (const id of BUILTIN_CLI_IDS)
    it(`${id}：清单、能力位与实现、启动注入、权限、账号目录`, async () => {
      expect(await checkPlugin(BUILTIN_PLUGINS[id])).toEqual([]);
      expect(BUILTIN_MANIFESTS[id].id).toBe(id);
      expect(BUILTIN_RENDERER[id].id).toBe(id);
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
});
