jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  mcpGranted,
  splitMcpTool,
  validateConnectionGrants,
} from '../../../src/connections/catalog';
import { ConnectionService } from '../../../src/connections/ConnectionService';
import { ghWriteArgs } from '../../../src/connections/github';
import { PermissionBroker } from '../../../src/desktop/PermissionBroker';
import { createMcpSource, itemKey, resultItems } from '../../../src/tasks/events/sources/mcp';
import {
  ExternalCheckpointError,
  ExternalNotAppliedError,
  markerOf,
  openIntents,
} from '../../../src/tasks/external';
import type { TaskExecutor } from '../../../src/tasks/TaskRuntime';
import { TaskService } from '../../../src/tasks/TaskService';
import type { Task } from '../../../src/tasks/types';

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);

const idle: TaskExecutor = {
  prepare: (task) => ({ grantVersion: task.grant.version }),
  start: () => undefined,
  resume: () => undefined,
  stop: () => undefined,
};

function service(dir: string, now = () => T0) {
  const svc = new TaskService({
    root: dir,
    logger: { info: () => undefined, warn: () => undefined },
    events: { publish: () => undefined },
    notify: { notify: () => undefined },
    now,
    setTimer: () => () => undefined,
  });
  svc.registerExecutor('nomi', idle);
  return svc;
}

const ghGrant = (caps: string[], repos = ['o/r']) => ({
  connectionId: 'conn_1',
  capabilities: caps,
  resources: repos,
});

describe('能力目录（connections.md §2）', () => {
  it('对外能力要 L4；未知、永不授予、通配、空资源都拒绝', () => {
    expect(validateConnectionGrants([ghGrant(['github.read'])], 1)).toBeNull();
    expect(validateConnectionGrants([ghGrant(['github.comment'])], 3)).toMatch(/level 4/);
    expect(validateConnectionGrants([ghGrant(['github.comment'])], 4)).toBeNull();
    expect(validateConnectionGrants([ghGrant(['github.merge'])], 4)).toMatch(/never/);
    expect(validateConnectionGrants([ghGrant(['github.write'])], 4)).toMatch(/unknown/);
    expect(validateConnectionGrants([ghGrant(['github.read'], ['o/*'])], 4)).toMatch(/wildcard/);
    expect(validateConnectionGrants([ghGrant(['github.read'], [])], 4)).toMatch(/no resources/);
    expect(validateConnectionGrants([ghGrant(['github.read'], ['../x'])], 4)).toMatch(/bad repo/);
    expect(
      validateConnectionGrants(
        [{ connectionId: 'conn_1', capabilities: ['mcp.read'], resources: ['x'] }],
        4,
      ),
    ).toMatch(/does not apply/);
  });

  it('MCP：只读能力只能给只读工具；远程服务器不能授权', () => {
    const info = (_s: string, tool: string) =>
      tool === 'send'
        ? { readOnly: false }
        : tool === 'r'
          ? { readOnly: true, remote: true }
          : { readOnly: true };
    const g = (caps: string[], tools: string[]) => [
      { connectionId: 'mcp:mail', capabilities: caps, resources: tools },
    ];
    expect(validateConnectionGrants(g(['mcp.read'], ['list']), 1, info)).toBeNull();
    expect(validateConnectionGrants(g(['mcp.read'], ['send']), 4, info)).toMatch(/not read-only/);
    expect(validateConnectionGrants(g(['mcp.call'], ['send']), 3, info)).toMatch(/level 4/);
    expect(
      validateConnectionGrants(g(['mcp.call', 'mcp.read'], ['send', 'list']), 4, info),
    ).toBeNull();
    expect(validateConnectionGrants(g(['mcp.read'], ['r']), 1, info)).toMatch(/remote/);
  });

  it('mcpGranted：只认授权里逐个列出的工具', () => {
    const grants = [{ connectionId: 'mcp:mail', capabilities: ['mcp.read'], resources: ['list'] }];
    expect(mcpGranted(grants, 'mail', 'list', true)).toBe('read');
    expect(mcpGranted(grants, 'mail', 'list', false)).toBeNull();
    expect(mcpGranted(grants, 'mail', 'send', false)).toBeNull();
    expect(mcpGranted(grants, 'cal', 'list', true)).toBeNull();
    expect(splitMcpTool('mail__send')).toEqual({ serverId: 'mail', tool: 'send' });
    expect(splitMcpTool('fs_read_text')).toBeNull();
  });
});

describe('副作用日志与重启核对（persistent-tasks §10）', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-ext-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const create = (svc: TaskService, level: 0 | 1 | 2 | 3 | 4 = 4) =>
    svc.create({
      title: 't',
      goal: 'g',
      trigger: { kind: 'manual' },
      executor: { kind: 'nomi', tools: ['read'] },
      grant: { level, paths: [], connections: [ghGrant(['github.read', 'github.comment'])] },
    });

  it('创建 / 改授权时校验连接能力', () => {
    const svc = service(dir);
    svc.start();
    expect(() => create(svc, 3)).toThrow(/level 4/);
    const task = create(svc);
    expect(() =>
      svc.command(task.id, {
        type: 'grant',
        grant: { level: 4, paths: [], connections: [ghGrant(['github.release'])] },
      }),
    ).toThrow(/never/);
    svc.stop();
  });

  it('intent → done；确定没生效写 failed；不确定的留着；检查点不过不写 intent', async () => {
    const svc = service(dir);
    svc.start();
    const task = create(svc);
    expect(svc.command(task.id, { type: 'runNow' }).ok).toBe(true);
    const attemptId = svc.get(task.id)!.attempts.at(-1)!.id;
    const j = svc.externalJournal(task.id, attemptId);
    const a = { action: 'github.comment', summary: 's', target: { repo: 'o/r' }, payload: 'x' };
    let seen = '';
    await expect(
      j.run(a, async (key) => {
        seen = key;
        return { value: 1, externalId: '99' };
      }),
    ).resolves.toBe(1);
    expect(seen).toBe(`${task.id}:${attemptId}:1`);
    await expect(
      j.run(a, async () => {
        throw new ExternalNotAppliedError('422');
      }),
    ).rejects.toThrow('422');
    await expect(
      j.run(a, async () => {
        throw new Error('timeout');
      }),
    ).rejects.toThrow('timeout');
    const journal = svc.journal(task.id);
    expect(journal.filter((e) => e.t === 'intent').map((e) => (e as { seq: number }).seq)).toEqual([
      1, 2, 3,
    ]);
    expect(journal.find((e) => e.t === 'done')).toMatchObject({ seq: 1, externalId: '99' });
    expect(journal.find((e) => e.t === 'failed')).toMatchObject({ seq: 2 });
    expect(openIntents(journal, attemptId).map((e) => e.seq)).toEqual([3]);

    svc.command(task.id, { type: 'cancel' });
    await expect(j.run(a, async () => ({ value: 1 }))).rejects.toBeInstanceOf(
      ExternalCheckpointError,
    );
    expect(svc.journal(task.id).filter((e) => e.t === 'intent')).toHaveLength(3);
    svc.stop();
  });

  it('重启：自动核对查清了就续跑；查不了留给用户；用户核对关掉 intent', async () => {
    const svc = service(dir);
    svc.start();
    const a = create(svc);
    const b = create(svc);
    for (const id of [a.id, b.id]) {
      svc.command(id, { type: 'runNow' });
      const att = svc.get(id)!.attempts.at(-1)!.id;
      void svc.externalJournal(id, att).run(
        {
          action: id === a.id ? 'github.comment' : 'mcp.call',
          summary: 's',
          target: {},
          payload: 1,
        },
        () => new Promise(() => undefined),
      );
    }
    svc.stop();

    const svc2 = service(dir, () => T0 + 60_000);
    svc2.registerReconciler('github.comment', async () => ({ applied: true, externalId: '7' }));
    svc2.start();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(svc2.get(a.id)!.task.status).not.toBe('needs_reconcile');
    expect(svc2.journal(a.id).find((e) => e.t === 'done')).toMatchObject({
      by: 'reconcile',
      externalId: '7',
    });
    // mcp.call 没有自动核对：等用户
    expect(svc2.get(b.id)!.task.status).toBe('needs_reconcile');
    const att = svc2.get(b.id)!.attempts.at(-1)!.id;
    expect(svc2.command(b.id, { type: 'reconcile', outcome: 'not_applied' }).ok).toBe(true);
    expect(openIntents(svc2.journal(b.id), att)).toEqual([]);
    expect(svc2.journal(b.id).find((e) => e.t === 'failed')).toMatchObject({ by: 'user' });
    svc2.stop();
  });
});

describe('GitHub 对外写（connections.md §4.2）', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-w-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const authJson = JSON.stringify({
    hosts: {
      'github.com': [
        { active: true, host: 'github.com', login: 'octo', scopes: 'repo', state: 'success' },
      ],
    },
  });

  async function setup(api: (args: string[]) => { stdout: string; code: number }) {
    const calls: string[][] = [];
    const svc = new ConnectionService({
      file: path.join(dir, 'connections.json'),
      secrets: { canEncrypt: () => true, encrypt: (v) => v, decrypt: (v) => v ?? '' },
      events: { publish: () => undefined },
      logger: { warn: () => undefined },
      now: () => 0,
      runGh: async (args) => {
        calls.push(args);
        if (args[0] === 'auth') return { stdout: authJson, code: 0 };
        return api(args);
      },
    });
    const c = await svc.addGithub({ mode: 'gh', host: 'github.com' });
    return { svc, calls, id: c.id };
  }

  const journal = () => {
    const log: string[] = [];
    return {
      log,
      j: {
        run: async <T>(
          a: { action: string },
          fn: (key: string) => Promise<{ value: T; externalId?: string }>,
        ) => {
          log.push(`intent:${a.action}`);
          try {
            const r = await fn('t:a:1');
            log.push(`done:${r.externalId ?? ''}`);
            return r.value;
          } catch (e) {
            log.push(e instanceof ExternalNotAppliedError ? 'failed' : 'open');
            throw e;
          }
        },
      },
    };
  };

  it('gh 写请求逐项传参；正文带幂等标记；授权外拒绝', async () => {
    const { svc, calls, id } = await setup(() => ({
      stdout: JSON.stringify({ id: 5, html_url: 'u' }),
      code: 0,
    }));
    const { log, j } = journal();
    const grant = [{ connectionId: id, capabilities: ['github.comment'], resources: ['o/r'] }];
    await expect(
      svc.githubWrite('github.comment', { repo: 'o/r', number: 3, body: 'hi' }, grant, j),
    ).resolves.toEqual({ id: 5, url: 'u' });
    const args = calls.at(-1)!;
    expect(args.slice(0, 7)).toEqual([
      'api',
      '--method',
      'POST',
      '--include',
      '--hostname',
      'github.com',
      '/repos/o/r/issues/3/comments',
    ]);
    expect(args.at(-2)).toBe('--raw-field');
    expect(args.at(-1)).toBe(`body=hi\n\n${markerOf('t:a:1')}`);
    expect(log).toEqual(['intent:github.comment', 'done:5']);

    await expect(
      svc.githubWrite('github.comment', { repo: 'x/y', number: 3, body: 'hi' }, grant, j),
    ).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(
      svc.githubWrite(
        'github.pr.create',
        { repo: 'o/r', head: 'main', base: 'main', title: 't' },
        grant,
        j,
      ),
    ).rejects.toMatchObject({ code: 'bad_params' });
    // 后台没有副作用日志不写
    await expect(
      svc.githubWrite('github.comment', { repo: 'o/r', number: 3, body: 'hi' }, grant, null),
    ).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('GitHub 明确拒绝 → failed；断网 → 不确定', async () => {
    let reply = {
      stdout: `HTTP/2.0 422 Unprocessable Entity\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ message: 'Validation Failed' })}`,
      code: 1,
    };
    const { svc, id } = await setup(() => reply);
    const grant = [{ connectionId: id, capabilities: ['github.comment'], resources: ['o/r'] }];
    const { log, j } = journal();
    await expect(
      svc.githubWrite('github.comment', { repo: 'o/r', number: 3, body: 'x' }, grant, j),
    ).rejects.toThrow(/Validation Failed/);
    reply = { stdout: '', code: 1 };
    await expect(
      svc.githubWrite('github.comment', { repo: 'o/r', number: 3, body: 'x' }, grant, j),
    ).rejects.toThrow();
    // 5xx 带错误正文也不确定（可能已经发出去了）
    reply = { stdout: `HTTP/2.0 502 Bad Gateway\n\n${JSON.stringify({ message: 'x' })}`, code: 1 };
    await expect(
      svc.githubWrite('github.comment', { repo: 'o/r', number: 3, body: 'x' }, grant, j),
    ).rejects.toThrow(/502/);
    expect(log).toEqual([
      'intent:github.comment',
      'failed',
      'intent:github.comment',
      'open',
      'intent:github.comment',
      'open',
    ]);
    await expect(
      svc.githubWrite('github.comment', { repo: '../x', number: 3, body: 'x' }, grant, j),
    ).rejects.toMatchObject({ code: 'bad_params' });
  });

  it('核对：按标记查评论 / PR', async () => {
    let list: unknown[] = [];
    const { svc, calls, id } = await setup(() => ({ stdout: JSON.stringify(list), code: 0 }));
    const intent = {
      t: 'intent' as const,
      at: T0,
      attemptId: 'a',
      seq: 1,
      action: 'github.comment',
      hash: 'h',
      key: 't:a:1',
      target: { connectionId: id, repo: 'o/r', number: 3 },
    };
    expect(await svc.githubReconcile(intent)).toEqual({ applied: false });
    list = [{ id: 11, body: `x\n\n${markerOf('t:a:1')}` }];
    expect(await svc.githubReconcile(intent)).toEqual({ applied: true, externalId: '11' });
    expect(calls.at(-1)!.at(-1)).toMatch(/^\/repos\/o\/r\/issues\/3\/comments\?since=/);
    list = [];
    expect(
      await svc.githubReconcile({
        ...intent,
        action: 'github.pr.create',
        target: { connectionId: id, repo: 'o/r', head: 'nomi/x' },
      }),
    ).toEqual({ applied: false });
    expect(calls.at(-1)!.at(-1)).toContain('head=o%3Anomi%2Fx');
    expect(await svc.githubReconcile({ ...intent, target: { connectionId: 'nope' } })).toBeNull();
  });

  it('ghWriteArgs：布尔用 -F，字符串用 --raw-field', () => {
    expect(
      ghWriteArgs('h', { method: 'POST', path: '/p', fields: { title: '@x', draft: true } }),
    ).toEqual([
      'api',
      '--method',
      'POST',
      '--include',
      '--hostname',
      'h',
      '/p',
      '--raw-field',
      'title=@x',
      '-F',
      'draft=true',
    ]);
  });
});

describe('后台任务里的 MCP 工具（connections.md §6）', () => {
  const broker = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
    return new PermissionBroker(
      path.join(dir, 'settings.json'),
      { home: dir, platform: process.platform, realpath: (p) => fs.promises.realpath(p) },
      { timeoutMs: 1000 },
    );
  };

  const call = (b: PermissionBroker, signal: AbortSignal, tool: string, readOnly: boolean) =>
    b.authorize({
      tool,
      danger: readOnly ? 'read' : 'write',
      summary: 's',
      args: {},
      signal,
      mcpReadOnly: readOnly,
    });

  it('不在授权里的工具拒绝；只读给了就跑；对外工具要 L4，读过外部内容时问人', async () => {
    const b = broker();
    const asked: string[] = [];
    const mk = (level: 0 | 1 | 2 | 3 | 4, tainted = false) => {
      const ctrl = new AbortController();
      b.registerBackground(ctrl.signal, {
        level,
        tainted,
        connections: [
          {
            connectionId: 'mcp:mail',
            capabilities: ['mcp.read', 'mcp.call'],
            resources: ['list', 'send'],
          },
        ],
        ask: async (r) => {
          asked.push(r.tool);
          return true;
        },
      });
      return ctrl.signal;
    };
    expect(await call(b, mk(1), 'mail__other', true)).toBe('denied');
    expect(await call(b, mk(1), 'mail__list', true)).toBe('auto');
    expect(await call(b, mk(3), 'mail__send', false)).toBe('denied');
    expect(await call(b, mk(4), 'mail__send', false)).toBe('auto');
    expect(await call(b, mk(4, true), 'mail__send', false)).toBe('allowed');
    expect(asked).toEqual(['mail__send']);
  });
});

describe('mcp 事件源', () => {
  const task = (resources: string[]) =>
    ({
      grant: {
        connections: [{ connectionId: 'mcp:mail', capabilities: ['mcp.read'], resources }],
      },
    }) as unknown as Task;

  it('校验：工具要在授权里且只读', () => {
    const src = createMcpSource({
      info: (_s, t) => (t === 'send' ? { readOnly: false } : { readOnly: true }),
      call: async () => '[]',
    });
    expect(src.validate({ server: 'mail', tool: 'list' }, task(['list']))).toBeNull();
    expect(src.validate({ server: 'mail', tool: 'list' }, task(['other']))).toMatch(/not granted/);
    expect(src.validate({ server: 'mail', tool: 'send' }, task(['send']))).toMatch(/read-only/);
    expect(src.validate({ server: 'mail', tool: 'list', args: [] }, task(['list']))).toBe(
      'bad args',
    );
  });

  it('列表按条目 key 出事件；非列表比哈希', async () => {
    let out: unknown = JSON.stringify({ messages: [{ id: 'm1', subject: '你好' }, { x: 1 }] });
    const src = createMcpSource(
      { info: () => ({ readOnly: true }), call: async () => out },
      { now: () => T0 },
    );
    const ctx = { signal: new AbortController().signal, task: task(['list']) } as never;
    const r1 = await src.poll!({ server: 'mail', tool: 'list' }, null, ctx);
    expect(r1.events.map((e) => e.key)).toEqual([
      'mcp:mail/list:m1',
      `mcp:mail/list:${itemKey({ x: 1 })}`,
    ]);
    expect(r1.events[0]!.summary).toContain('你好');
    out = 'plain text';
    const r2 = await src.poll!({ server: 'mail', tool: 'list' }, null, ctx);
    expect(r2).toMatchObject({ events: [], baseline: true });
    out = 'plain text 2';
    const r3 = await src.poll!({ server: 'mail', tool: 'list' }, r2.cursor, ctx);
    expect(r3.events).toHaveLength(1);
    expect(resultItems('{"a":1}')).toBeNull();
  });
});
