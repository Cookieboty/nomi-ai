// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统与子进程
jest.unmock('fs');
jest.unmock('path');
jest.unmock('child_process');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AppTrash } from '../../../src/desktop/AppTrash';
import { AuditLog } from '../../../src/desktop/AuditLog';
import { parseFile } from '../../../src/desktop/parse/runParse';
import { PermissionBroker, type ConfirmRequest } from '../../../src/desktop/PermissionBroker';
import { createDesktopTools } from '../../../src/desktop/tools';
import { UndoJournal } from '../../../src/desktop/UndoJournal';
import { checkWorkspaceRoot, isBroadWorkspace } from '../../../src/desktop/workspace';
import { applyConversationWorkspace, runShellCommand } from '../../../src/desktop/workspaceTools';

type R = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };

const posixIt = process.platform === 'win32' ? it.skip : it;

function setup(o: { autoApprove?: boolean; known?: boolean } = {}) {
  const homeRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-home-'));
  const home =
    process.platform === 'win32' && fs.realpathSync.native
      ? fs.realpathSync.native(homeRaw)
      : fs.realpathSync(homeRaw);
  const ws = path.join(home, 'proj');
  const outside = path.join(home, 'elsewhere');
  const data = path.join(home, 'data');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, 'readme.md'), '# Proj\nhello workspace');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  const broker = new PermissionBroker(
    path.join(data, 'settings.json'),
    {
      home,
      platform: process.platform,
      realpath: (p) =>
        process.platform === 'win32' && fs.realpathSync.native
          ? Promise.resolve(fs.realpathSync.native(p))
          : fs.promises.realpath(p),
      denyRoots: [data],
    },
    { timeoutMs: 2000 },
  );
  const rejected: Array<{ dir: string; reason: string }> = [];
  broker.isKnownWorkspace = (d) => (o.known ?? true) && path.resolve(d) === ws;
  broker.autoApprove = () => o.autoApprove ?? true;
  broker.onWorkspaceRejected = (dir, reason) => rejected.push({ dir, reason });
  const asks: ConfirmRequest[] = [];
  broker.ui = {
    request: (r) => {
      asks.push(r);
      setTimeout(() => broker.answer(r.id, true), 0);
    },
    cancel: () => undefined,
  };
  const trash = new AppTrash(path.join(data, 'trash'));
  const tools = createDesktopTools({
    broker,
    audit: new AuditLog(path.join(data, 'audit')),
    journal: new UndoJournal(path.join(data, 'journal.jsonl'), trash),
    trash,
    parse: (p) => parseFile(p),
    summarize: async () => 'S',
    providerFor: () => ({ id: 'mock', name: 'Mock', local: true }),
    pickFolder: async () => outside,
    shell: { env: () => ({ ...process.env }) },
  });
  const call = async (
    name: string,
    input: unknown,
    ctx: { cwd?: string; signal?: AbortSignal } = { cwd: ws },
  ) => (await tools.find((t) => t.name === name)!.execute(input, ctx)) as R;
  return { home, ws, outside, broker, asks, call, tools, rejected };
}

describe('workspace root checks', () => {
  const home = '/Users/me';
  it('refuses filesystem roots, home and its ancestors, the big home folders and system dirs', () => {
    for (const p of ['/', '/Users', home, `${home}/Documents`, `${home}/Desktop`, '/usr', '/etc'])
      expect(isBroadWorkspace(p, home, 'darwin')).toBe(true);
    for (const p of [`${home}/Documents/nomi`, `${home}/code/app`, '/opt/work/app'])
      expect(isBroadWorkspace(p, home, 'darwin')).toBe(false);
    expect(isBroadWorkspace('C:\\', 'C:\\Users\\me', 'win32')).toBe(true);
    expect(isBroadWorkspace('C:\\Windows', 'C:\\Users\\me', 'win32')).toBe(true);
    expect(isBroadWorkspace('C:\\Users\\me\\code', 'C:\\Users\\me', 'win32')).toBe(false);
  });

  it('refuses deny-listed roots and the app data folder', async () => {
    const env = {
      home,
      platform: 'darwin' as const,
      realpath: async (p: string) => p,
      denyRoots: ['/Users/me/Library/Application Support/Nomi'],
    };
    expect((await checkWorkspaceRoot(`${home}/.ssh`, env)).ok).toBe(false);
    expect((await checkWorkspaceRoot(`${home}/Library/Application Support/Nomi/x`, env)).ok).toBe(
      false,
    );
    expect((await checkWorkspaceRoot('relative/dir', env)).ok).toBe(false);
    expect(await checkWorkspaceRoot(`${home}/code/app`, env)).toEqual({
      ok: true,
      real: `${home}/code/app`,
    });
    // realpath 落到过宽的位置（软链指向主目录）同样拒绝
    const linked = { ...env, realpath: async () => home };
    expect((await checkWorkspaceRoot(`${home}/code/link`, linked)).ok).toBe(false);
  });
});

describe('Nomi conversation workspace (desktop tools)', () => {
  it('accepts only a directory the user chose; otherwise falls back to granted folders', async () => {
    const s = setup({ known: false });
    expect(await s.broker.workspaceOf(s.ws)).toBeNull();
    expect(s.rejected[0]).toMatchObject({ dir: s.ws });
    // 退回原有行为：没有授权文件夹 → 拒绝
    const r = await s.call('fs_read_text', { path: path.join(s.ws, 'readme.md') });
    expect(r.error?.code).toBe('outside_scope');
    const s2 = setup();
    expect(await s2.broker.workspaceOf(s2.ws)).toBe(s2.ws);
    expect(await s2.broker.workspaceOf(s2.home)).toBeNull(); // 不是用户选的（也过宽）
  });

  it('reads and writes inside the workspace without a grant or a confirmation (auto on)', async () => {
    const s = setup();
    const r = await s.call('fs_read_text', { path: 'readme.md' });
    expect(r.ok).toBe(true);
    expect(String(r.data?.text)).toContain('hello workspace');
    const w = await s.call('fs_write_text', { path: 'out/../new.txt', text: 'hi', mode: 'create' });
    expect(w.ok).toBe(true);
    expect(fs.readFileSync(path.join(s.ws, 'new.txt'), 'utf8')).toBe('hi');
    const t = await s.call('fs_trash', { path: 'new.txt' });
    expect(t.ok).toBe(true);
    expect(s.asks).toHaveLength(0);
    // 工作区本身不能删
    expect((await s.call('fs_trash', { path: '.' })).error?.code).toBe('denied');
    const list = await s.call('fs_list', { path: '.' });
    expect(list.ok).toBe(true);
    const found = await s.call('fs_search', { name: '*.md' });
    expect((found.data?.results as Array<{ path: string }>).map((x) => x.path)).toEqual([
      path.join(s.ws, 'readme.md'),
    ]);
    const perms = await s.call('desktop_permissions', {});
    expect(perms.data).toMatchObject({ workspace: s.ws, workspaceAutoApprove: true });
  });

  it('asks for confirmation inside the workspace when auto-approve is off', async () => {
    const s = setup({ autoApprove: false });
    const w = await s.call('fs_write_text', { path: 'a.txt', text: 'x', mode: 'create' });
    expect(w.ok).toBe(true);
    expect(s.asks.map((a) => a.tool)).toEqual(['fs_write_text']);
    // 读不需要确认，也不需要授权
    expect((await s.call('fs_read_text', { path: 'a.txt' })).ok).toBe(true);
    expect(s.asks).toHaveLength(1);
  });

  it('refuses paths outside the workspace that the user never granted, deny-listed files and symlink escapes', async () => {
    const s = setup();
    const abs = await s.call('fs_read_text', { path: path.join(s.outside, 'secret.txt') });
    expect(abs.error?.code).toBe('outside_scope');
    expect(abs.error?.message).toContain(s.ws);
    expect((await s.call('fs_read_text', { path: '../elsewhere/secret.txt' })).error?.code).toBe(
      'outside_scope',
    );
    expect(
      (await s.call('fs_write_text', { path: '../x.txt', text: 'x', mode: 'create' })).error?.code,
    ).toBe('outside_scope');
    expect((await s.call('fs_read_text', { path: '.env' })).error?.code).toBe('denied');
    fs.symlinkSync(s.outside, path.join(s.ws, 'link'));
    expect((await s.call('fs_read_text', { path: 'link/secret.txt' })).error?.code).toBe(
      'symlink_escape',
    );
    expect(fs.existsSync(path.join(s.home, 'x.txt'))).toBe(false);
  });

  it('folders the user granted outside the workspace keep the original flow (never auto-approved)', async () => {
    const s = setup(); // 「全部自动」开着
    s.broker.grant(s.outside, 'read-write');
    // 读：按授权放行（原来的读也不确认）
    const r = await s.call('fs_read_text', { path: path.join(s.outside, 'secret.txt') });
    expect(r.ok).toBe(true);
    expect(String(r.data?.text)).toContain('outside');
    // 相对路径落到授权文件夹里同样认
    expect((await s.call('fs_read_text', { path: '../elsewhere/secret.txt' })).ok).toBe(true);
    // 写：不按「全部自动」放行，照原来的规则确认
    const w = await s.call('fs_write_text', {
      path: path.join(s.outside, 'new.txt'),
      text: 'x',
      mode: 'create',
    });
    expect(w.ok).toBe(true);
    expect(s.asks.map((a) => a.tool)).toEqual(['fs_write_text']);
    // 删除：破坏性，照旧在对话框里确认
    expect((await s.call('fs_trash', { path: path.join(s.outside, 'new.txt') })).ok).toBe(true);
    expect(s.asks.map((a) => [a.tool, a.dialog])).toEqual([
      ['fs_write_text', false],
      ['fs_trash', true],
    ]);
    // 授权根本身不能删；授权文件夹里的黑名单照旧拒绝
    expect((await s.call('fs_trash', { path: s.outside })).error?.code).toBe('denied');
    fs.writeFileSync(path.join(s.outside, '.env'), 'K=1');
    expect((await s.call('fs_read_text', { path: path.join(s.outside, '.env') })).error?.code).toBe(
      'denied',
    );
    // 符号链接从工作区指到授权文件夹：按授权文件夹的规则
    fs.symlinkSync(s.outside, path.join(s.ws, 'link'));
    expect((await s.call('fs_read_text', { path: 'link/secret.txt' })).ok).toBe(true);
    // 本次运行的会话授权（如拖到桌面角色身上的单个文件）同样走原流程
    const other = path.join(s.home, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'drop.txt'), 'DROPPED');
    s.broker.grant(path.join(other, 'drop.txt'), 'read', 'file', true);
    const d = await s.call('fs_read_text', { path: path.join(other, 'drop.txt') });
    expect(String(d.data?.text)).toContain('DROPPED');
    expect(
      (
        await s.call('fs_write_text', {
          path: path.join(other, 'drop.txt'),
          text: 'y',
          mode: 'append',
        })
      ).error?.code,
    ).toBe('read_only');
  });

  it('plan mode still blocks writes inside the workspace', async () => {
    const s = setup();
    s.broker.permissionMode = () => 'plan';
    const w = await s.call('fs_write_text', { path: 'p.txt', text: 'x', mode: 'create' });
    expect(w.error?.code).toBe('mode_blocked');
  });

  it('can still ask the user to grant a folder while a workspace is set', async () => {
    const s = setup();
    const r = await s.call('desktop_request_scope', {});
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ path: s.outside });
    expect((await s.call('fs_read_text', { path: path.join(s.outside, 'secret.txt') })).ok).toBe(
      true,
    );
  });
});

describe('workspace_run', () => {
  it('only exists for conversations with a workspace', () => {
    const s = setup();
    const run = s.tools.find((t) => t.name === 'workspace_run')!;
    expect(run.requiresWorkspace).toBe(true);
  });

  posixIt('runs in the workspace without confirmation by default', async () => {
    const s = setup();
    const r = await s.call('workspace_run', { command: 'pwd && echo hi >&2 && exit 3' });
    expect(r.ok).toBe(true);
    expect(String(r.data?.stdout)).toContain(s.ws);
    expect(String(r.data?.stderr)).toContain('hi');
    expect(r.data?.exitCode).toBe(3);
    expect(s.asks).toHaveLength(0);
  });

  posixIt('confirms each command when auto-approve is off', async () => {
    const s = setup({ autoApprove: false });
    const r = await s.call('workspace_run', { command: 'true' });
    expect(r.ok).toBe(true);
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]).toMatchObject({ tool: 'workspace_run', dialog: true });
  });

  it('refuses without a usable workspace', async () => {
    const s = setup({ known: false });
    expect((await s.call('workspace_run', { command: 'pwd' })).error?.code).toBe('no_workspace');
    expect((await s.call('workspace_run', { command: 'pwd' }, {})).error?.code).toBe(
      'no_workspace',
    );
  });

  posixIt(
    'times out, caps output and stops with the conversation',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-run-'));
      const t = await runShellCommand('sleep 5', { cwd: dir, env: process.env, timeoutMs: 200 });
      expect(t.timedOut).toBe(true);
      expect(t.ms).toBeLessThan(4000);
      const big = await runShellCommand('yes | head -c 5000', {
        cwd: dir,
        env: process.env,
        timeoutMs: 5000,
        cap: 100,
      });
      expect(big.truncated).toBe(true);
      expect(big.stdout.length).toBe(100);
      const ac = new AbortController();
      const p = runShellCommand('sleep 5', {
        cwd: dir,
        env: process.env,
        timeoutMs: 10_000,
        signal: ac.signal,
      });
      setTimeout(() => ac.abort(), 100);
      const a = await p;
      expect(a.aborted).toBe(true);
      expect(a.ms).toBeLessThan(4000);
      const s = setup();
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 100);
      const r = await s.call(
        'workspace_run',
        { command: 'sleep 5' },
        { cwd: s.ws, signal: ac2.signal },
      );
      expect(r.error?.code).toBe('aborted');
    },
    15_000,
  );
});

describe('applyConversationWorkspace (request from the view)', () => {
  it('keeps a validated workspace, tells the model, and strips an unknown one', async () => {
    const s = setup();
    const ok: Record<string, unknown> = {
      extra: { conversationId: 'c', cwd: s.ws },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    };
    expect(await applyConversationWorkspace(ok, s.broker)).toBe(s.ws);
    expect((ok.extra as Record<string, unknown>).cwd).toBe(s.ws);
    expect((ok.messages as Array<{ content: string }>)[0]!.content).toContain(s.ws);
    const bad: Record<string, unknown> = {
      extra: { conversationId: 'c', cwd: s.outside },
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(await applyConversationWorkspace(bad, s.broker)).toBeNull();
    expect(bad.extra).toEqual({ conversationId: 'c' });
    expect(bad.messages).toHaveLength(1);
    const none: Record<string, unknown> = { messages: [] };
    expect(await applyConversationWorkspace(none, s.broker)).toBeNull();
  });
});
