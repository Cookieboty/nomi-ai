// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PermissionBroker, type ConfirmRequest } from '../../../src/desktop/PermissionBroker';

function mk(timeoutMs = 50) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-'));
  const b = new PermissionBroker(
    path.join(dir, 'settings.json'),
    { home: dir, platform: process.platform, realpath: (p) => fs.promises.realpath(p) },
    { timeoutMs },
  );
  const seen: ConfirmRequest[] = [];
  const cancelled: string[] = [];
  b.ui = { request: (r) => seen.push(r), cancel: (id) => cancelled.push(id) };
  return { b, dir, seen, cancelled };
}

describe('PermissionBroker', () => {
  it('auto-denies after the timeout and cancels the bubble', async () => {
    const { b, seen, cancelled } = mk(30);
    const d = await b.authorize({ tool: 'fs_write_text', danger: 'write', summary: 's', args: {} });
    expect(d).toBe('timeout');
    expect(cancelled).toEqual([seen[0].id]);
  });

  it('remember allows the tool for the rest of the run, but a tainted turn re-confirms', async () => {
    const { b, seen } = mk(1000);
    const p = b.authorize({ tool: 'fs_write_text', danger: 'write', summary: 's', args: {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0].rememberable).toBe(true);
    b.answer(seen[0].id, true, true);
    expect(await p).toBe('allowed');
    expect(
      await b.authorize({ tool: 'fs_write_text', danger: 'write', summary: 's', args: {} }),
    ).toBe('auto');

    const turn = new AbortController();
    b.markRead(turn.signal);
    const q = b.authorize({
      tool: 'fs_write_text',
      danger: 'write',
      summary: 's',
      args: {},
      signal: turn.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[1].reason).toBe('tainted');
    b.answer(seen[1].id, false);
    expect(await q).toBe('denied');
    // 另一轮（不同 signal）不受影响
    expect(
      await b.authorize({
        tool: 'fs_write_text',
        danger: 'write',
        summary: 's',
        args: {},
        signal: new AbortController().signal,
      }),
    ).toBe('auto');
  });

  it('destructive always prompts with dialog, remember is ignored', async () => {
    const { b, seen } = mk(1000);
    for (let i = 0; i < 2; i += 1) {
      const p = b.authorize({ tool: 'fs_trash', danger: 'destructive', summary: 's', args: {} });
      await new Promise((r) => setTimeout(r, 0));
      expect(seen[i]).toMatchObject({ dialog: true, rememberable: false });
      b.answer(seen[i].id, true, true);
      expect(await p).toBe('allowed');
    }
  });

  it('aborting the turn denies a pending request', async () => {
    const { b, cancelled } = mk(1000);
    const ac = new AbortController();
    const p = b.authorize({
      tool: 'fs_trash',
      danger: 'destructive',
      summary: 's',
      args: {},
      signal: ac.signal,
    });
    ac.abort();
    expect(await p).toBe('denied');
    expect(cancelled).toHaveLength(1);
  });

  it('an already-aborted turn is denied without showing a prompt', async () => {
    const { b, seen } = mk(1000);
    const ac = new AbortController();
    ac.abort();
    expect(await b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false }, ac.signal)).toBe(
      'user_denied',
    );
    expect(seen).toHaveLength(0);
  });

  it('stopping a chat while the first cloud send is pending withdraws the prompt (#160)', async () => {
    const { b, seen, cancelled } = mk(1000);
    const ac = new AbortController();
    const p = b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false }, ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect(await p).toBe('user_denied');
    expect(cancelled).toEqual([seen[0].id]);
    // 已撤掉的确认再被答复不会记住该供应商：下次发送重新询问
    b.answer(seen[0].id, true);
    const again = b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(2);
    b.answer(seen[1].id, true);
    expect(await again).toBeNull();
  });

  it('no UI → denied', async () => {
    const { b } = mk();
    b.ui = null;
    expect(
      await b.authorize({ tool: 'fs_trash', danger: 'destructive', summary: 's', args: {} }),
    ).toBe('denied');
  });

  it('persists scopes and policies; session scopes are not persisted', () => {
    const { b, dir } = mk();
    b.grant(dir, 'read');
    b.grant(path.join(dir, 'x.txt'), 'read', 'file', true);
    b.setPolicy('fs_trash', 'destructive', 'always');
    const again = new PermissionBroker(path.join(dir, 'settings.json'), {
      home: dir,
      platform: process.platform,
      realpath: (p) => fs.promises.realpath(p),
    });
    expect(again.scopes()).toHaveLength(1);
    expect(again.policy('fs_trash', 'destructive')).toBe('ask');
    expect(b.scopes()).toHaveLength(2);
  });

  it('local-only blocks cloud providers; first cloud send needs an acknowledgement', async () => {
    const { b, seen } = mk(1000);
    expect(await b.checkSend({ id: 'ollama', name: 'Ollama', local: true })).toBeNull();
    const p = b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]).toMatchObject({ dialog: true, tool: 'cloud_send_notice' });
    b.answer(seen[0].id, true);
    expect(await p).toBeNull();
    expect(await b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false })).toBeNull();
    expect(seen).toHaveLength(1);
    b.setLocalOnly(true);
    expect(await b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false })).toBe(
      'local_only',
    );
  });

  it('plan mode blocks writes without prompting, even forced ones; reads and cloud notices still work', async () => {
    const { b, seen } = mk(1000);
    b.permissionMode = () => 'plan';
    const w = { tool: 'fs_write_text', danger: 'write' as const, summary: 's', args: {} };
    expect(await b.authorize(w)).toBe('blocked');
    expect(await b.authorize({ ...w, force: { dialog: false } })).toBe('blocked');
    expect(await b.authorize({ ...w, tool: 'fs_trash', danger: 'destructive' })).toBe('blocked');
    expect(await b.authorize({ ...w, tool: 'fs_read_text', danger: 'read' })).toBe('auto');
    expect(seen).toHaveLength(0);
    const p = b.checkSend({ id: 'deepseek', name: 'DeepSeek', local: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]).toMatchObject({ tool: 'cloud_send_notice' });
    b.answer(seen[0].id, true);
    expect(await p).toBeNull();
  });

  it('auto mode skips default write prompts but keeps per-tool policies', async () => {
    const { b, seen } = mk(1000);
    b.permissionMode = () => 'auto';
    const w = { tool: 'fs_write_text', danger: 'write' as const, summary: 's', args: {} };
    expect(await b.authorize(w)).toBe('auto');
    b.setPolicy('fs_write_text', 'write', 'ask');
    const p = b.authorize(w);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    b.answer(seen[0].id, false);
    expect(await p).toBe('denied');
  });
});

describe('PermissionBroker 后台任务（persistent-tasks §8.4）', () => {
  const ask = () => {
    const asked: string[] = [];
    let answer = true;
    return {
      asked,
      setAnswer: (v: boolean) => (answer = v),
      run: (level: 0 | 1 | 2 | 3 | 4) => ({
        level,
        ask: async (r: { tool: string }) => {
          asked.push(r.tool);
          return answer;
        },
      }),
    };
  };

  it('读直接放行；等级不够直接拒绝；不弹确认、不看前台档位', async () => {
    const { b, seen } = mk();
    b.permissionMode = () => 'plan';
    const a = ask();
    const ctrl = new AbortController();
    b.registerBackground(ctrl.signal, a.run(1));
    expect(
      await b.authorize({
        tool: 'fs_read_text',
        danger: 'read',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('auto');
    expect(
      await b.authorize({
        tool: 'fs_write_text',
        danger: 'write',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('denied');
    expect(
      await b.authorize({
        tool: 'workspace_run',
        danger: 'destructive',
        summary: 's',
        args: { command: 'ls' },
        signal: ctrl.signal,
        force: { dialog: true },
      }),
    ).toBe('denied');
    expect(seen).toEqual([]);
    expect(a.asked).toEqual([]);
  });

  it('L2 写：未读过外部内容直接写；读过之后停下来问；破坏性一律问', async () => {
    const { b, seen } = mk();
    const a = ask();
    const ctrl = new AbortController();
    b.registerBackground(ctrl.signal, a.run(2));
    expect(
      await b.authorize({
        tool: 'fs_write_text',
        danger: 'write',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('auto');
    b.markRead(ctrl.signal);
    expect(
      await b.authorize({
        tool: 'fs_write_text',
        danger: 'write',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('allowed');
    a.setAnswer(false);
    expect(
      await b.authorize({
        tool: 'fs_trash',
        danger: 'destructive',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('denied');
    expect(a.asked).toEqual(['fs_write_text', 'fs_trash']);
    expect(seen).toEqual([]);
  });

  it('L3 命令：审核放行就跑，否则问；MCP 工具需要 L4；工具拿到的派生 signal 也认得', async () => {
    const { b } = mk();
    b.aiReview = () => true;
    let risk: 'low' | 'medium' = 'low';
    b.reviewer = async () =>
      ({ risk, outcome: risk === 'low' ? 'allow' : 'ask', rationale: 'r' }) as never;
    const a = ask();
    const ctrl = new AbortController();
    b.registerBackground(ctrl.signal, a.run(3));
    // 模拟 AiSdkLlmProvider 派生给工具的 signal
    const local = new AbortController().signal;
    Object.defineProperty(local, Symbol.for('nomi.abortParent'), { value: ctrl.signal });
    const run = {
      tool: 'workspace_run',
      danger: 'destructive' as const,
      summary: 's',
      args: { command: 'npm test' },
      force: { dialog: true },
    };
    expect(await b.authorize({ ...run, signal: local })).toBe('auto');
    risk = 'medium';
    expect(await b.authorize({ ...run, signal: local })).toBe('allowed');
    expect(
      await b.authorize({
        tool: 'mail__send',
        danger: 'write',
        summary: 's',
        args: {},
        signal: local,
      }),
    ).toBe('denied');
    expect(a.asked).toEqual(['workspace_run']);
    expect(
      await b.authorizeIn({
        tool: 'fs_write_text',
        danger: 'write',
        summary: 's',
        args: {},
        signal: local,
      }),
    ).toBe('auto');
  });

  it('高级权限（派给 Nomi）：读过外部内容后写入照常放行、授权的 MCP 对外工具直接跑；破坏性仍问', async () => {
    const { b, seen } = mk();
    const a = ask();
    const ctrl = new AbortController();
    b.registerBackground(ctrl.signal, {
      ...a.run(4),
      trusted: true,
      connections: [
        { connectionId: 'mcp:mail', capabilities: ['mcp.read', 'mcp.call'], resources: ['send'] },
      ],
    });
    b.markRead(ctrl.signal);
    const write = { danger: 'write' as const, summary: 's', args: {}, signal: ctrl.signal };
    expect(await b.authorize({ tool: 'fs_write_text', ...write })).toBe('auto');
    expect(await b.authorize({ tool: 'mail__send', ...write })).toBe('auto');
    // 没授权的 MCP 工具仍拒绝
    expect(await b.authorize({ tool: 'mail__delete', ...write })).toBe('denied');
    expect(
      await b.authorize({
        tool: 'fs_trash',
        danger: 'destructive',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('allowed');
    expect(a.asked).toEqual(['fs_trash']);
    expect(seen).toEqual([]);
  });

  it('注销后恢复前台规则；执行已中止时一律拒绝', async () => {
    const { b } = mk();
    const ctrl = new AbortController();
    const off = b.registerBackground(ctrl.signal, ask().run(4));
    ctrl.abort();
    expect(
      await b.authorize({
        tool: 'fs_write_text',
        danger: 'write',
        summary: 's',
        args: {},
        signal: ctrl.signal,
      }),
    ).toBe('denied');
    off();
    expect(b.isBackground(ctrl.signal)).toBe(false);
  });
});

describe('PermissionBroker 后台：命令确定性分类先于审核', () => {
  it('读凭据 / 合并永远问人；对外动作 L3 或没给 GitHub 对外能力时问人、给了 L4 交给审核', async () => {
    const { b } = mk();
    b.aiReview = () => true;
    b.reviewer = async () => ({ risk: 'low', outcome: 'allow', authorization: 'high' }) as never;
    const asked: string[] = [];
    const reg = (level: 3 | 4, caps: string[] = []) => {
      const c = new AbortController();
      b.registerBackground(c.signal, {
        level,
        connections: caps.length
          ? [{ connectionId: 'conn_1', capabilities: caps, resources: ['o/r'] }]
          : [],
        ask: async (r) => {
          asked.push(r.detail.split(' ')[0]!);
          return false;
        },
      });
      return c.signal;
    };
    const run = (command: string, signal: AbortSignal) =>
      b.authorize({
        tool: 'workspace_run',
        danger: 'destructive',
        summary: 's',
        args: { command },
        force: { dialog: true },
        signal,
      });
    const l3 = reg(3);
    expect(await run('npm test', l3)).toBe('auto');
    expect(await run('gh auth token', l3)).toBe('denied');
    expect(await run('gh pr merge 1', l3)).toBe('denied');
    expect(await run('gh pr create --fill', l3)).toBe('denied');
    expect(await run('gh pr create --fill', reg(4))).toBe('denied');
    const l4 = reg(4, ['github.read', 'github.pr.create']);
    expect(await run('gh pr create --fill', l4)).toBe('auto');
    expect(await run('security find-generic-password -w', l4)).toBe('denied');
    expect(asked).toEqual(['[credential]', '[never]', '[external]', '[external]', '[credential]']);
  });
});
