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
