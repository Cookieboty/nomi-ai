// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  outcomeFor,
  parseReview,
  reviewCommand,
  reviewMessages,
  type CommandReview,
  type CommandReviewInput,
} from '../../../src/desktop/commandReview';
import { PermissionBroker, type ConfirmRequest } from '../../../src/desktop/PermissionBroker';

describe('命令审核：解析与结论', () => {
  it('风险 × 是否读过外部内容 → 放行 / 交给人', () => {
    expect(outcomeFor('low', false)).toBe('allow');
    expect(outcomeFor('low', true)).toBe('allow');
    expect(outcomeFor('medium', false)).toBe('allow');
    expect(outcomeFor('medium', true)).toBe('ask');
    expect(outcomeFor('high', false)).toBe('ask');
    expect(outcomeFor('critical', false)).toBe('ask');
  });

  it('解析模型回复（可包在代码块里），不合法返回 null', () => {
    expect(
      parseReview(
        '```json\n{"risk_level":"low","user_authorization":"high","rationale":"只跑测试"}\n```',
        false,
      ),
    ).toEqual({ risk: 'low', authorization: 'high', outcome: 'allow', rationale: '只跑测试' });
    expect(parseReview('{"risk_level":"high"}', false)).toEqual({
      risk: 'high',
      authorization: 'unknown',
      outcome: 'ask',
    });
    expect(parseReview('{"risk_level":"spicy"}', false)).toBeNull();
    expect(parseReview('sure, looks fine', false)).toBeNull();
    expect(parseReview('{not json}', false)).toBeNull();
  });

  it('提示词：用户的话是可信授权来源，命令按不可信内容交给模型', () => {
    const [sys, user] = reviewMessages({
      tool: 'workspace_run',
      command: 'pnpm test',
      cwd: '/w',
      userText: '跑一下测试',
      tainted: true,
    });
    expect(sys!.role).toBe('system');
    expect(user!.content).toContain('跑一下测试');
    expect(user!.content).toContain('pnpm test');
    expect(user!.content).toContain('external content (files, web, command output): yes');
  });

  it('出错 / 超时：返回 null（交给人）', async () => {
    const i: CommandReviewInput = { tool: 'workspace_run', command: 'ls', tainted: false };
    expect(await reviewCommand(i, async () => Promise.reject(new Error('down')))).toBeNull();
    const slow = (_m: unknown, signal?: AbortSignal) =>
      new Promise<string>((_r, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect(await reviewCommand(i, slow, { timeoutMs: 20 })).toBeNull();
    expect(
      await reviewCommand(i, async () => '{"risk_level":"low","user_authorization":"medium"}'),
    ).toMatchObject({ outcome: 'allow' });
  });
});

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const b = new PermissionBroker(
    path.join(dir, 'settings.json'),
    { home: dir, platform: process.platform, realpath: (p) => fs.promises.realpath(p) },
    { timeoutMs: 1000 },
  );
  const seen: ConfirmRequest[] = [];
  b.ui = { request: (r) => seen.push(r), cancel: () => undefined };
  const inputs: CommandReviewInput[] = [];
  let verdict: CommandReview | null = null;
  b.aiReview = () => true;
  b.reviewer = async (i) => {
    inputs.push(i);
    return verdict;
  };
  const run = (signal?: AbortSignal) =>
    b.authorize({
      tool: 'workspace_run',
      danger: 'destructive',
      summary: 's',
      args: { cwd: '/w', command: 'pnpm test' },
      force: { dialog: true },
      userText: '跑一下测试',
      ...(signal ? { signal } : {}),
    });
  return { b, seen, inputs, run, set: (v: CommandReview | null) => (verdict = v) };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PermissionBroker：命令先交给辅助模型审核', () => {
  it('低风险：直接放行，不弹确认；审核拿到命令、目录、用户的话', async () => {
    const t = mk();
    t.set({ risk: 'low', authorization: 'high', outcome: 'allow' });
    expect(await t.run()).toBe('auto');
    expect(t.seen).toHaveLength(0);
    expect(t.inputs[0]).toEqual({
      tool: 'workspace_run',
      command: 'pnpm test',
      cwd: '/w',
      userText: '跑一下测试',
      tainted: false,
    });
  });

  it('高风险：交给人，卡片带风险等级与理由', async () => {
    const t = mk();
    t.set({ risk: 'high', authorization: 'low', outcome: 'ask', rationale: '会删掉整个目录' });
    const p = t.run();
    await tick();
    expect(t.seen[0]!.review).toEqual({ risk: 'high', rationale: '会删掉整个目录' });
    t.b.answer(t.seen[0]!.id, true);
    expect(await p).toBe('allowed');
  });

  it('审核不了（null）/ 开关关着 / 计划档 / 不是跑命令的工具：照旧交给人', async () => {
    const t = mk();
    t.set(null);
    const p = t.run();
    await tick();
    expect(t.seen[0]!.review).toBeUndefined();
    t.b.answer(t.seen[0]!.id, false);
    expect(await p).toBe('denied');

    t.set({ risk: 'low', authorization: 'high', outcome: 'allow' });
    t.b.aiReview = () => false;
    const q = t.run();
    await tick();
    expect(t.seen).toHaveLength(2);
    t.b.answer(t.seen[1]!.id, false);
    await q;

    t.b.aiReview = () => true;
    t.b.permissionMode = () => 'plan';
    expect(await t.run()).toBe('blocked');

    t.b.permissionMode = () => 'acceptEdits';
    const before = t.inputs.length;
    const r = t.b.authorize({
      tool: 'code_run',
      danger: 'destructive',
      summary: 's',
      args: { code: 'print(1)' },
    });
    await tick();
    expect(t.inputs.length).toBe(before);
    t.b.answer(t.seen[t.seen.length - 1]!.id, false);
    await r;
  });

  it('这一轮读过外部内容：告诉审核方', async () => {
    const t = mk();
    t.set({ risk: 'low', authorization: 'high', outcome: 'allow' });
    const turn = new AbortController();
    t.b.markRead(turn.signal);
    expect(await t.run(turn.signal)).toBe('auto');
    expect(t.inputs[0]!.tainted).toBe(true);
  });

  it('云端模型：没同意过发送就不审（不为审核额外弹窗）', () => {
    const t = mk();
    expect(t.b.canSendQuietly(null)).toBe(false);
    expect(t.b.canSendQuietly({ id: 'local', local: true })).toBe(true);
    expect(t.b.canSendQuietly({ id: 'cloud', local: false })).toBe(false);
  });
});
