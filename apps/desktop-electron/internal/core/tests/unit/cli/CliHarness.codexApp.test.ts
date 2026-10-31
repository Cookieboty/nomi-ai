jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codexExecItem, codexTurnPolicy, codexTurnUsage } from '@nomi-ai/cli-sdk';

import { permissionLaunch } from '../../../src/cli/permissionMode';
import type { HarnessEvent } from '../../../src/cli/types';
import { until } from '../../helpers/wait';
import { CliHarnessService } from '../helpers/harness';

const mockCodex = path.resolve(__dirname, '../../../scripts/mock-cli/mock-codex.mjs');

describe('codex app-server mapping', () => {
  it('权限模式 → 每轮的沙箱 / 审批参数（与 exec 的 -c 同一张表）', () => {
    expect(codexTurnPolicy('plan', { network: true })).toMatchObject({
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
    });
    expect(codexTurnPolicy('manual', { network: true })).toMatchObject({
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
      approvalPolicy: 'untrusted',
    });
    expect(codexTurnPolicy('acceptEdits', { network: false })).toMatchObject({
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
      approvalPolicy: 'never',
    });
    expect(codexTurnPolicy('auto', { network: true })).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    });
    expect(codexTurnPolicy('bypass', { network: true }).sandboxPolicy).toEqual({
      type: 'dangerFullAccess',
    });
    // 退回 exec 时逐项确认没有审批通道：按只读跑
    expect(permissionLaunch('codex', 'manual').args).toEqual(['-c', 'sandbox_mode="read-only"']);
  });

  it('线程条目转成 exec 的条目；用量按线程累计求差', () => {
    expect(
      codexExecItem({
        type: 'commandExecution',
        id: 'c1',
        command: 'ls',
        aggregatedOutput: 'a',
        exitCode: 0,
        status: 'completed',
      }),
    ).toEqual({
      type: 'command_execution',
      id: 'c1',
      command: 'ls',
      aggregated_output: 'a',
      exit_code: 0,
      status: 'completed',
    });
    expect(
      codexExecItem({
        type: 'collabAgentToolCall',
        id: 'x',
        tool: 'spawnAgent',
        status: 'completed',
      }),
    ).toMatchObject({ type: 'collab_tool_call', tool: 'spawn_agent' });
    expect(codexExecItem({ type: 'userMessage', id: 'u' })).toBeNull();
    expect(
      codexTurnUsage(
        { inputTokens: 10, cachedInputTokens: 2, outputTokens: 8 },
        { inputTokens: 25, cachedInputTokens: 5, outputTokens: 20 },
      ),
    ).toEqual({ inputTokens: 15, outputTokens: 12, cacheReadTokens: 3 });
  });
});

/** Codex 走 app-server 长驻会话：与 Claude / Gemini / Grok 一致的复用、流式、停止与即时切换 */
describe('CliHarnessService Codex over app-server', () => {
  const keys = [
    'NOMI_CODEX_BIN',
    'NOMI_USE_MOCK_CLI',
    'NOMI_MOCK_CODEX_APP_LOG',
    'NOMI_MOCK_CODEX_PERM',
    'NOMI_MOCK_CODEX_NO_APP',
    'NOMI_MOCK_CODEX_FAIL',
    'NOMI_MOCK_FIRST_TOKEN_MS',
    'NOMI_MOCK_SLOW_PROMPT',
    'NOMI_MOCK_ARGV_LOG',
  ];
  let saved: Record<string, string | undefined> = {};
  const made: CliHarnessService[] = [];
  let root: string;
  let log: string;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.NOMI_CODEX_BIN = mockCodex;
    delete process.env.NOMI_USE_MOCK_CLI;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-app-'));
    log = path.join(root, 'app.log');
    process.env.NOMI_MOCK_CODEX_APP_LOG = log;
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const mk = (o: { prewarmClaude?: boolean; codexAppServer?: boolean } = {}) => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      // 不读真实的 ~/.codex/config.toml
      home: root,
      codexAppServer: true,
      ...o,
    });
    made.push(h);
    // 这里核对各档位的协议映射：关掉「全部自动」，新标签按默认档（自动改文件）开始
    h.setPermissionDefaults({ autoApprove: false });
    const events: HarnessEvent[] = [];
    const inner = h as unknown as { emitEvent(id: string, ev: HarnessEvent): void };
    const orig = inner.emitEvent.bind(h);
    inner.emitEvent = (id, ev) => {
      events.push(ev);
      orig(id, ev);
    };
    return { h, events };
  };
  type Call = { method: string; params: Record<string, unknown> };
  const calls = (): Call[] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Call)
      : [];
  const count = (m: string) => calls().filter((c) => c.method === m).length;
  const turnStarts = () => calls().filter((c) => c.method === 'turn/start');
  const codexLive = (h: CliHarnessService) =>
    (h as unknown as { codexLive: Map<string, { ready: Promise<void> }> }).codexLive;

  it('重试 / 编辑：thread/revert 原地回退同一个线程，进程保留，不带前文', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    await h.sendTab(tab.id, '第一句');
    await h.sendTab(tab.id, '写错的第二句');
    const users = h.tabMessages(tab.id).filter((m) => m.role === 'user');
    expect(users.map((m) => m.cliTurn)).toEqual([
      { sessionId: 'mock-codex-thread-1', turnId: expect.any(String) },
      { sessionId: 'mock-codex-thread-1', turnId: expect.any(String) },
    ]);
    const live = codexLive(h).get(tab.id);
    const kept = await h.rewindTab(tab.id, users[1]!.id);
    expect(kept).toHaveLength(2);
    const reverts = calls().filter((c) => c.method === 'thread/revert');
    expect(reverts).toEqual([
      {
        method: 'thread/revert',
        params: { threadId: 'mock-codex-thread-1', beforeTurnId: users[1]!.cliTurn!.turnId },
      },
    ]);
    const meta = h.listTabs().tabs.find((x) => x.id === tab.id)!;
    expect(meta.cliSessionId).toBe('mock-codex-thread-1');
    expect(meta.carriedMessages).toBeUndefined();
    expect(codexLive(h).get(tab.id)).toBe(live);
    await h.sendTab(tab.id, '改过的第二句');
    // 同一个进程、同一个线程，消息原样发出（没有前文）
    expect(count('initialize')).toBe(1);
    expect(turnStarts().at(-1)!.params).toMatchObject({ threadId: 'mock-codex-thread-1' });
    expect(JSON.stringify(turnStarts().at(-1)!.params)).not.toContain('previous_conversation');
  }, 20_000);

  it('回退到线程第一轮 / 没记下轮次：不调 thread/revert，改为带前文开新会话', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    await h.sendTab(tab.id, '第一句');
    await h.sendTab(tab.id, '第二句');
    const users = h.tabMessages(tab.id).filter((m) => m.role === 'user');
    // 旧版本落盘的消息没有 cliTurn
    delete users[1]!.cliTurn;
    await h.rewindTab(tab.id, users[1]!.id);
    expect(count('thread/revert')).toBe(0);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)).toMatchObject({
      cliSessionId: null,
      carriedMessages: 2,
    });
    await h.sendTab(tab.id, '再来');
    const first = h.tabMessages(tab.id).find((m) => m.role === 'user')!;
    await h.rewindTab(tab.id, first.id);
    expect(count('thread/revert')).toBe(0);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBeNull();
  }, 20_000);

  it('多轮复用同一个 app-server：流式正文、工具、思考、每轮用量与线程 id', async () => {
    const { h, events } = mk();
    const tab = h.createTab({ backend: 'codex' });
    const r1 = await h.sendTab(tab.id, 'hello');
    expect(r1.text).toBe('【Mock Codex】任务完成。');
    expect(r1.usage).toMatchObject({ inputTokens: 10, outputTokens: 8, cacheReadTokens: 2 });
    expect(events.filter((e) => e.type === 'text-delta').length).toBe(2);
    expect(r1.events.filter((e) => e.type === 'tool').map((e) => [e.name, e.status])).toEqual([
      ['bash', 'start'],
      ['bash', 'done'],
    ]);
    expect(r1.events.some((e) => e.type === 'thinking')).toBe(true);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBe(
      'mock-codex-thread-1',
    );
    const r2 = await h.sendTab(tab.id, 'again');
    // 第二轮的用量是这一轮的增量，不是线程累计
    expect(r2.usage).toMatchObject({ inputTokens: 10, outputTokens: 8 });
    expect(count('initialize')).toBe(1);
    expect(count('thread/start')).toBe(1);
    expect(turnStarts()).toHaveLength(2);
    expect(turnStarts()[0]!.params).toMatchObject({
      threadId: 'mock-codex-thread-1',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: true },
    });
  }, 15_000);

  it('已有会话 id（重启 / 打开历史 / exec 建的会话）：thread/resume 接上', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex', cliSessionId: 'thread-from-exec' });
    const r = await h.sendTab(tab.id, 'continue');
    expect(r.text).toBe('【Mock Codex】已续接会话 thread-from-exec');
    expect(calls().find((c) => c.method === 'thread/resume')?.params.threadId).toBe(
      'thread-from-exec',
    );
    expect(count('thread/start')).toBe(0);
  }, 15_000);

  it('切换项目会拆掉旧 app-server，并用新 cwd 创建新 thread', async () => {
    const { h } = mk();
    const first = fs.mkdtempSync(path.join(root, 'project-a-'));
    const second = fs.mkdtempSync(path.join(root, 'project-b-'));
    const tab = h.createTab({ backend: 'codex', cwd: first });
    await h.sendTab(tab.id, 'from project a');
    expect(calls().find((c) => c.method === 'thread/start')?.params.cwd).toBe(first);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBe(
      'mock-codex-thread-1',
    );

    h.setTabCwd(tab.id, second);
    expect(h.listTabs().tabs.find((x) => x.id === tab.id)?.cliSessionId).toBeNull();
    await h.sendTab(tab.id, 'from project b');

    const starts = calls().filter((c) => c.method === 'thread/start');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.params.cwd).toBe(second);
    expect(count('initialize')).toBe(2);
    expect(count('thread/resume')).toBe(0);
  }, 15_000);

  it('权限模式、模型、思考深度随下一条 turn/start 生效，不重启进程', async () => {
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      'model = "mock-pro"\nmodel_reasoning_effort = "medium"\n',
    );
    const { h } = mk();
    await h.modelCatalogFor('codex');
    const tab = h.createTab({ backend: 'codex' });
    await h.sendTab(tab.id, 'one');
    h.setTabPermissionMode(tab.id, 'plan');
    h.setTabModel(tab.id, 'mock-mini');
    h.setTabReasoningEffort(tab.id, 'high');
    await h.sendTab(tab.id, 'two');
    h.setTabModel(tab.id, '');
    await h.sendTab(tab.id, 'three');
    await h.sendTab(tab.id, 'four');
    const [one, two, three, four] = turnStarts().map((c) => c.params);
    expect(one).not.toHaveProperty('model');
    expect(two).toMatchObject({
      model: 'mock-mini',
      effort: 'high',
      sandboxPolicy: { type: 'readOnly' },
      approvalPolicy: 'never',
    });
    expect((two!.input as Array<{ text: string }>)[0]!.text).toMatch(/plan mode/);
    // 清掉模型（思考深度随之清掉）：切回目录里的默认模型和它的默认档位
    expect(three).toMatchObject({ model: 'mock-pro', effort: 'medium' });
    // 已经是默认值：不再重复下发
    expect(four).not.toHaveProperty('model');
    expect(count('initialize')).toBe(1);
  }, 15_000);

  it('不知道默认模型时清掉覆盖：换新进程并 thread/resume 接上（按 config.toml 默认开始）', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    h.setTabModel(tab.id, 'mock-mini');
    await h.sendTab(tab.id, 'one');
    h.setTabModel(tab.id, '');
    await h.sendTab(tab.id, 'two');
    expect(count('initialize')).toBe(2);
    expect(count('thread/resume')).toBe(1);
    expect(turnStarts()[1]!.params).not.toHaveProperty('model');
  }, 15_000);

  it('停止：turn/interrupt 结束这一轮、进程保留，下一轮直接复用', async () => {
    // 只有 'long' 这一轮会等（turn/interrupt 会打断）；下一轮在同一个进程里立即回复
    process.env.NOMI_MOCK_FIRST_TOKEN_MS = '60000';
    process.env.NOMI_MOCK_SLOW_PROMPT = 'long';
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    const p = h.sendTab(tab.id, 'long');
    await until(() => turnStarts().length > 0, { what: 'turn/start sent' });
    // turn/start 已发出不等于已拿到 turnId；等 id 落盘后再停，避免误杀进程
    await until(
      () => {
        const live = (
          h as unknown as {
            codexLive: Map<string, { driver: { currentTurnId: string | null } }>;
          }
        ).codexLive.get(tab.id);
        return Boolean(live?.driver.currentTurnId);
      },
      { what: 'turn id assigned' },
    );
    expect(h.cancelTab(tab.id)).toBe(true);
    await expect(p).rejects.toThrow();
    expect(h.tabMessages(tab.id).at(-1)).toMatchObject({ stopped: true });
    expect((await h.sendTab(tab.id, 'next')).text).toBe('【Mock Codex】任务完成。');
    expect(count('initialize')).toBe(1);
    expect(count('turn/interrupt')).toBe(1);
  }, 15_000);

  it('逐项确认：审批请求进权限卡片；允许执行、拒绝则命令记为失败但这一轮照常结束', async () => {
    process.env.NOMI_MOCK_CODEX_PERM = '1';
    const { h, events } = mk();
    const tab = h.createTab({ backend: 'codex' });
    h.setTabPermissionMode(tab.id, 'manual');
    const answer = async (allow: boolean) => {
      for (let i = 0; i < 200 && !events.some((e) => e.type === 'permission'); i++)
        await new Promise((r) => setTimeout(r, 10));
      const perm = events.find((e) => e.type === 'permission') as Extract<
        HarnessEvent,
        { type: 'permission' }
      >;
      expect(perm.summary).toBe('bash: ls');
      events.length = 0;
      expect(h.replyPermission(tab.id, perm.id, allow)).toBe(true);
    };
    const ok = h.sendTab(tab.id, 'list');
    await answer(true);
    const r1 = await ok;
    expect(r1.events.find((e) => e.type === 'tool' && e.status !== 'start')).toMatchObject({
      status: 'done',
    });
    const denied = h.sendTab(tab.id, 'list again');
    await answer(false);
    const r2 = await denied;
    expect(r2.events.find((e) => e.type === 'tool' && e.status !== 'start')).toMatchObject({
      status: 'error',
    });
    expect(turnStarts()[0]!.params.approvalPolicy).toBe('untrusted');
  }, 15_000);

  it('等待审批时切到完全放开：放行在等的请求，这一轮照常跑完，下一轮按新策略开始', async () => {
    process.env.NOMI_MOCK_CODEX_PERM = '1';
    const { h, events } = mk();
    const tab = h.createTab({ backend: 'codex' });
    h.setTabPermissionMode(tab.id, 'manual');
    const run = h.sendTab(tab.id, 'list');
    await until(() => events.some((e) => e.type === 'permission'), { what: 'approval asked' });
    await h.applyTabPermissionMode(tab.id, 'bypass', { confirmed: true });
    const r = await run;
    expect(r.events.find((e) => e.type === 'tool' && e.status !== 'start')).toMatchObject({
      status: 'done',
    });
    await h.sendTab(tab.id, 'next');
    expect(turnStarts().map((c) => c.params.approvalPolicy)).toEqual(['untrusted', 'never']);
    expect(count('initialize')).toBe(1);
  }, 15_000);

  it('/compact：改发 thread/compact/start（不当消息发给模型），显示压缩中，结束后提示已压缩', async () => {
    const { h, events } = mk();
    const tab = h.createTab({ backend: 'codex' });
    // 还没有线程：没有可压缩的内容，也不为它建空线程
    await expect(h.sendTab(tab.id, '/compact')).rejects.toThrow('会话还没有内容');
    expect(count('thread/start')).toBe(0);
    await h.sendTab(tab.id, 'hello');
    const r = await h.sendTab(tab.id, '/compact keep the API notes');
    expect(r.text).toBe('已压缩上下文');
    expect(calls().find((c) => c.method === 'thread/compact/start')?.params).toEqual({
      threadId: 'mock-codex-thread-1',
    });
    expect(turnStarts()).toHaveLength(1);
    expect(events.filter((e) => e.type === 'status').map((e) => e.kind)).toEqual(
      expect.arrayContaining(['compact', 'clear']),
    );
    // 压缩之后照常对话，复用同一个进程
    expect((await h.sendTab(tab.id, 'again')).text).toBe('【Mock Codex】任务完成。');
    expect(count('initialize')).toBe(1);
  }, 15_000);

  it('/compact 前刚换的模型：压缩请求不带模型，留到下一条 turn/start 下发', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    await h.sendTab(tab.id, 'one');
    h.setTabModel(tab.id, 'mock-mini');
    await h.sendTab(tab.id, '/compact');
    await h.sendTab(tab.id, 'two');
    expect(turnStarts()[1]!.params).toMatchObject({ model: 'mock-mini' });
  }, 15_000);

  it('这一轮失败：报出 Codex 给的原因', async () => {
    process.env.NOMI_MOCK_CODEX_FAIL = '1';
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    await expect(h.sendTab(tab.id, 'x')).rejects.toThrow('Mock: quota exceeded');
  }, 15_000);

  it('这台机器的 Codex 起不来 app-server：退回 codex exec，之后都用 exec', async () => {
    process.env.NOMI_MOCK_CODEX_NO_APP = '1';
    const argvLog = path.join(root, 'argv.jsonl');
    process.env.NOMI_MOCK_ARGV_LOG = argvLog;
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    expect((await h.sendTab(tab.id, 'one')).text).toBe('【Mock Codex】任务完成。');
    await h.sendTab(tab.id, 'two');
    const argv = fs
      .readFileSync(argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);
    expect(argv.map((a) => a.slice(0, 2).join(' '))).toEqual(['exec --json', 'exec resume']);
    // exec 没有压缩请求：/compact 不当消息发给模型
    await expect(h.sendTab(tab.id, '/compact')).rejects.toThrow('app-server');
    expect(fs.readFileSync(argvLog, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 15_000);

  it('预热：新建 Codex 会话即拉起 app-server，但不提前建空线程', async () => {
    const { h } = mk({ prewarmClaude: true });
    const tab = h.createTab({ backend: 'codex' });
    for (let i = 0; i < 100 && !codexLive(h).has(tab.id); i++)
      await new Promise((r) => setTimeout(r, 10));
    await codexLive(h).get(tab.id)!.ready;
    expect(count('initialize')).toBe(1);
    expect(count('thread/start')).toBe(0);
    await h.sendTab(tab.id, 'hi');
    expect(count('initialize')).toBe(1);
    expect(count('thread/start')).toBe(1);
  }, 15_000);

  it('换账号 / 供应商：空闲的 app-server 拆掉，下一轮按新配置重拉并续接', async () => {
    const { h } = mk();
    const tab = h.createTab({ backend: 'codex' });
    await h.sendTab(tab.id, 'one');
    h.recycleBackend('codex');
    expect(codexLive(h).has(tab.id)).toBe(false);
    await h.sendTab(tab.id, 'two');
    expect(count('initialize')).toBe(2);
    expect(count('thread/resume')).toBe(1);
  }, 15_000);

  it('关闭 app-server 时仍是每轮一个 codex exec 进程', async () => {
    const { h } = mk({ codexAppServer: false });
    const tab = h.createTab({ backend: 'codex' });
    expect((await h.sendTab(tab.id, 'hi')).text).toBe('【Mock Codex】任务完成。');
    expect(count('initialize')).toBe(0);
  }, 15_000);
});
