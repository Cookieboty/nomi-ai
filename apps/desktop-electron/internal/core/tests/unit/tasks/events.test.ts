jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EventHub, MAX_BATCH } from '../../../src/tasks/events/EventHub';
import { createAppSource } from '../../../src/tasks/events/sources/app';
import { createFolderSource } from '../../../src/tasks/events/sources/folder';
import { createGithubSource } from '../../../src/tasks/events/sources/github';
import { createWebSource, parseFeed, pageText } from '../../../src/tasks/events/sources/web';
import type { EventSource, SourceEvent } from '../../../src/tasks/events/types';
import type { Task } from '../../../src/tasks/types';

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);

const ev = (key: string, at = T0): SourceEvent => ({
  key,
  occurredAt: at,
  summary: key,
  payload: { key },
});

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    title: 't',
    goal: 'g',
    status: 'idle',
    enabled: true,
    trigger: { kind: 'event', sourceId: 'fake', filter: {}, mode: 'act', cooldownMs: 0 },
    grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: 0 },
    ...over,
  } as unknown as Task;
}

/** 可控的事件源：测试往 queue 里塞这次 poll 的结果 */
function fakeSource() {
  const queue: SourceEvent[][] = [];
  const src: EventSource = {
    id: 'fake' as never,
    minIntervalMs: 1000,
    validate: () => null,
    poll: async () => ({ events: queue.shift() ?? [], cursor: 'c' }),
  };
  return { src, queue };
}

function setup(task = mkTask()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-events-'));
  let now = T0;
  const fired: { id: string; key: string }[] = [];
  let busy = false;
  const changed: string[] = [];
  const { src, queue } = fakeSource();
  let current = task;
  const hub = new EventHub({
    root,
    sources: [src],
    get: () => current,
    fire: (id, key) => {
      if (busy) return { ok: false, reason: 'busy' };
      fired.push({ id, key });
      return { ok: true };
    },
    changed: (id) => changed.push(id),
    lastEventKey: () => fired.at(-1)?.key,
    logger: { warn: () => undefined },
    now: () => now,
    setTimer: () => () => undefined,
  });
  hub.start([task]);
  return {
    hub,
    queue,
    fired,
    changed,
    root,
    advance: (ms: number) => (now += ms),
    setBusy: (b: boolean) => (busy = b),
    setTask: (t: Task) => {
      current = t;
      hub.sync(t);
    },
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('EventHub', () => {
  it('第一次拉当基线；之后的新事件去重、按时间排序、整批触发；执行者能取到这一批', async () => {
    const h = setup();
    h.queue.push([ev('old')]);
    await h.hub.tick();
    expect(h.fired).toEqual([]);
    h.advance(2000);
    h.queue.push([ev('b', T0 + 2), ev('a', T0 + 1), ev('old')]);
    await h.hub.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.hub.batch('task_1', h.fired[0]!.key).map((e) => e.key)).toEqual(['a', 'b']);
    h.advance(2000);
    h.queue.push([ev('a'), ev('b')]);
    await h.hub.tick();
    expect(h.fired).toHaveLength(1);
    h.done();
  });

  it('observe：只记下来不执行；处理这些 → 开一次执行；忽略 → 清空', async () => {
    const t = mkTask({
      trigger: { kind: 'event', sourceId: 'fake', filter: {}, mode: 'observe' },
    } as Partial<Task>);
    const h = setup(t);
    await h.hub.tick();
    h.advance(2000);
    h.queue.push([ev('x'), ev('y')]);
    await h.hub.tick();
    expect(h.fired).toEqual([]);
    expect(h.hub.observed('task_1').map((e) => e.key)).toEqual(['x', 'y']);
    expect(h.changed).toContain('task_1');
    expect(h.hub.processObserved('task_1')).toEqual({ ok: true });
    expect(h.hub.batch('task_1', h.fired[0]!.key)).toHaveLength(2);
    expect(h.hub.observed('task_1')).toEqual([]);
    expect(h.hub.processObserved('task_1')).toEqual({ ok: false, reason: 'empty' });
    h.done();
  });

  it('冷却窗口：第一个事件开窗口，到时间或攒满才开执行；任务在忙时攒着，空闲后合并开下一次', async () => {
    const t = mkTask({
      trigger: { kind: 'event', sourceId: 'fake', filter: {}, mode: 'act', cooldownMs: 60_000 },
    } as Partial<Task>);
    const h = setup(t);
    await h.hub.tick();
    h.advance(2000);
    h.queue.push([ev('1')]);
    await h.hub.tick();
    expect(h.fired).toEqual([]);
    h.advance(60_000);
    h.setBusy(true);
    await h.hub.tick();
    expect(h.fired).toEqual([]);
    h.queue.push([ev('2')]);
    h.advance(2000);
    await h.hub.tick();
    h.setBusy(false);
    h.setTask({ ...t, status: 'idle', updatedAt: 1 } as Task);
    expect(h.fired).toHaveLength(1);
    expect(h.hub.batch('task_1', h.fired[0]!.key).map((e) => e.key)).toEqual(['1', '2']);
    h.done();
  });

  it('攒满 20 个立即开；多出来的留在下一窗口', async () => {
    const t = mkTask({
      trigger: { kind: 'event', sourceId: 'fake', filter: {}, mode: 'act', cooldownMs: 600_000 },
    } as Partial<Task>);
    const h = setup(t);
    await h.hub.tick();
    h.advance(2000);
    h.queue.push(Array.from({ length: MAX_BATCH + 3 }, (_, i) => ev(`k${i}`, T0 + i)));
    await h.hub.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.hub.batch('task_1', h.fired[0]!.key)).toHaveLength(MAX_BATCH);
    h.done();
  });

  it('执行失败：这一批的 key 释放，同样的事件还能再触发；状态落盘，重启后不重复', async () => {
    const h = setup();
    await h.hub.tick();
    h.advance(2000);
    h.queue.push([ev('a')]);
    await h.hub.tick();
    expect(h.fired).toHaveLength(1);
    h.setTask(mkTask({ status: 'failed' }));
    h.setTask(mkTask({ status: 'idle', updatedAt: 2 } as Partial<Task>));
    h.advance(2000);
    h.queue.push([ev('a')]);
    await h.hub.tick();
    expect(h.fired).toHaveLength(2);
    const files = fs.readdirSync(path.join(h.root));
    expect(files).toEqual(['task_1.json']);
    const raw = JSON.parse(fs.readFileSync(path.join(h.root, 'task_1.json'), 'utf8'));
    expect(raw.seen).toContain('a');
    h.done();
  });

  it('拉取失败：记下错误并退避，不影响其他任务', async () => {
    const h = setup();
    const bad: EventSource = {
      id: 'fake' as never,
      minIntervalMs: 1000,
      validate: () => null,
      poll: async () => {
        throw new Error('boom');
      },
    };
    (h.hub as unknown as { d: { sources: EventSource[] } }).d.sources.splice(0, 1, bad);
    h.hub.stop();
    h.hub.start([mkTask()]);
    await h.hub.tick();
    expect(h.hub.status('task_1').lastError).toBe('boom');
    h.done();
  });
});

describe('事件源', () => {
  it('web：页面哈希变化才算事件；304 不变；不跟随跳转', async () => {
    let body = '<html><script>x()</script><p>v1</p></html>';
    let status = 200;
    const src = createWebSource({
      resolve: async () => undefined,
      now: () => T0,
      fetch: async () => ({
        status,
        headers: { get: (n: string) => (n === 'etag' ? '"e1"' : null) },
        text: async () => body,
      }),
    });
    const task = mkTask();
    expect(src.validate({ url: 'http://127.0.0.1/' }, task)).toBeTruthy();
    expect(src.validate({ url: 'https://example.com/' }, task)).toBeNull();
    const ctx = { task, signal: new AbortController().signal };
    const r1 = await src.poll!({ url: 'https://example.com/' }, null, ctx);
    expect(r1.events).toEqual([]);
    body = '<p>v2</p>';
    const r2 = await src.poll!({ url: 'https://example.com/' }, r1.cursor, ctx);
    expect(r2.events).toHaveLength(1);
    expect((r2.events[0]!.payload as { excerpt: string }).excerpt).toBe('v2');
    status = 304;
    expect((await src.poll!({ url: 'https://example.com/' }, r2.cursor, ctx)).events).toEqual([]);
    status = 302;
    await expect(src.poll!({ url: 'https://example.com/' }, null, ctx)).rejects.toThrow('redirect');
    expect(pageText('<style>a{}</style><b>hi</b> &amp; you')).toBe('hi & you');
  });

  it('web feed：RSS 与 Atom 条目', () => {
    const rss = `<rss><channel><item><title>A</title><link>https://x/a</link><guid>g1</guid>
      <pubDate>Mon, 02 Nov 2026 01:00:00 GMT</pubDate></item></channel></rss>`;
    const atom = `<feed><entry><id>tag:1</id><title><![CDATA[B &amp; C]]></title>
      <link href="https://x/b"/><updated>2026-11-02T01:00:00Z</updated></entry></feed>`;
    expect(parseFeed(rss)).toEqual([{ id: 'g1', title: 'A', link: 'https://x/a', at: T0 }]);
    expect(parseFeed(atom)).toEqual([{ id: 'tag:1', title: 'B & C', link: 'https://x/b', at: T0 }]);
  });

  it('github：只读授权里的仓库；issues 用 since 游标；CI 只算跑完的', async () => {
    const calls: unknown[] = [];
    const src = createGithubSource({
      now: () => T0,
      read: async (p) => {
        calls.push(p);
        if (p.endpoint === 'issues')
          return [
            {
              number: 7,
              title: 'bug',
              updated_at: '2026-11-02T02:00:00Z',
              html_url: 'u',
              state: 'open',
            },
          ];
        return {
          workflow_runs: [
            {
              id: 1,
              name: 'ci',
              status: 'completed',
              conclusion: 'failure',
              head_branch: 'main',
              html_url: 'u',
              updated_at: '2026-11-02T02:00:00Z',
            },
            {
              id: 2,
              name: 'ci',
              status: 'in_progress',
              conclusion: null,
              head_branch: 'main',
              html_url: 'u',
              updated_at: '2026-11-02T02:00:00Z',
            },
          ],
        };
      },
    });
    const task = mkTask({
      grant: {
        version: 1,
        level: 1,
        paths: [],
        connections: [{ connectionId: 'c', capabilities: ['github.read'], resources: ['o/r'] }],
        grantedAt: 0,
      },
    });
    expect(src.validate({ repo: 'x/y', watch: 'issues' }, task)).toMatch('not granted');
    expect(src.validate({ repo: 'o/r', watch: 'issues' }, task)).toBeNull();
    const ctx = { task, signal: new AbortController().signal };
    const base = await src.poll!({ repo: 'o/r', watch: 'issues' }, null, ctx);
    expect(base).toMatchObject({ events: [], baseline: true });
    const r = await src.poll!({ repo: 'o/r', watch: 'issues' }, base.cursor, ctx);
    expect(r.events.map((e) => e.key)).toEqual(['github:o/r#7:2026-11-02T02:00:00Z']);
    expect(r.cursor).toBe('2026-11-02T02:00:00Z');
    expect(calls[0]).toMatchObject({ endpoint: 'issues', since: base.cursor, state: 'all' });
    const ci = await src.poll!({ repo: 'o/r', watch: 'ci', branch: 'main' }, null, ctx);
    expect(ci.events.map((e) => e.key)).toEqual(['github:o/r:run:1:failure']);
  });

  it('folder：必须在授权路径里；第一次是基线，之后报新文件与改动', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-folder-'));
    const src = createFolderSource({ now: () => T0 });
    const task = mkTask({
      grant: { version: 1, level: 1, paths: [dir], connections: [], grantedAt: 0 },
    });
    expect(src.validate({ path: '/' }, task)).toMatch('not granted');
    expect(src.validate({ path: dir }, task)).toBeNull();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const ctx = { task, signal: new AbortController().signal };
    const r1 = await src.poll!({ path: dir }, null, ctx);
    expect(r1).toMatchObject({ events: [], baseline: true });
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'x');
    const r2 = await src.poll!({ path: dir }, r1.cursor, ctx);
    expect(r2.events.map((e) => (e.payload as { file: string }).file)).toEqual(['b.txt']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('app：编程助手一轮结束（任务自己的标签不算）与知识库更新', () => {
    let cli: ((e: never) => void) | null = null;
    let kb: (() => void) | null = null;
    const src = createAppSource(
      {
        onCliFinished: (fn) => ((cli = fn as never), () => (cli = null)),
        onKnowledgeChanged: (fn) => ((kb = fn), () => (kb = null)),
      },
      { now: () => T0 },
    );
    const got: SourceEvent[] = [];
    const off = src.subscribe!({ event: 'cli.finished', backend: 'codex' }, mkTask(), (e) =>
      got.push(e),
    );
    cli!({ tabId: 't1', title: 'x', backend: 'codex', ok: true, taskTab: false } as never);
    cli!({ tabId: 't2', title: 'x', backend: 'codex', ok: true, taskTab: true } as never);
    cli!({ tabId: 't3', title: 'x', backend: 'claude', ok: true, taskTab: false } as never);
    expect(got).toHaveLength(1);
    off();
    expect(cli).toBeNull();
    src.subscribe!({ event: 'knowledge.updated' }, mkTask(), (e) => got.push(e));
    kb!();
    expect(got).toHaveLength(2);
    expect(src.validate({ event: 'nope' }, mkTask())).toBeTruthy();
  });
});
