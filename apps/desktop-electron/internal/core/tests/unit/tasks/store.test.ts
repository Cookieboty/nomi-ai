jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KEEP_ATTEMPTS,
  TaskStore,
  __storeDeps,
  type TaskRecord,
} from '../../../src/tasks/TaskStore';
import type { Attempt, Task } from '../../../src/tasks/types';

const T0 = 1_800_000_000_000;
const logger = { warn: jest.fn() };

function mkTask(id = 'task_a', over: Partial<Task> = {}): Task {
  return {
    id,
    title: 't',
    goal: 'g',
    origin: { createdBy: 'user', createdAt: T0 },
    trigger: { kind: 'manual' },
    executor: { kind: 'nomi', tools: [] },
    grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: T0 },
    budget: { maxRetries: 3 },
    acceptance: 'auto',
    status: 'idle',
    enabled: true,
    gen: 0,
    retryCount: 0,
    consecutiveFailures: 0,
    updatedAt: T0,
    schemaVersion: 1,
    ...over,
  };
}

const mkAttempt = (i: number): Attempt => ({
  id: `att_${i}`,
  taskId: 'task_a',
  gen: i,
  cause: { kind: 'manual' },
  snapshot: { grantVersion: 1 },
  status: 'succeeded',
  startedAt: T0 + i,
  usage: { inputTokens: 0, outputTokens: 0, costKnown: true },
});

let dir: string;
let store: TaskStore;
const orig = { ...__storeDeps };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-store-'));
  store = new TaskStore(dir, logger);
  logger.warn.mockClear();
});
afterEach(() => {
  Object.assign(__storeDeps, orig);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TaskStore', () => {
  it('写入后读回；loadAll 按 id 排序并跳过非任务文件', () => {
    store.save({ task: mkTask('task_b'), attempts: [] });
    store.save({ task: mkTask('task_a'), attempts: [mkAttempt(1)] });
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    fs.writeFileSync(path.join(dir, 'task_a.json.tmp'), 'garbage');
    const all = store.loadAll();
    expect(all.map((r) => r.task.id)).toEqual(['task_a', 'task_b']);
    expect(all[0].attempts).toHaveLength(1);
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(dir, 'task_a.json')).mode & 0o777).toBe(0o600);
  });

  it('拒绝不合法的 id（防路径穿越）', () => {
    expect(() => store.save({ task: mkTask('../evil'), attempts: [] })).toThrow('invalid task id');
    expect(() => store.load('task_../x')).toThrow('invalid task id');
  });

  it('坏文件与格式不对的文件跳过并记日志', () => {
    fs.writeFileSync(path.join(dir, 'task_bad.json'), '{ not json');
    fs.writeFileSync(
      path.join(dir, 'task_other.json'),
      JSON.stringify({ task: mkTask('task_x'), attempts: [] }),
    );
    expect(store.loadAll()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it(`执行超过 ${KEEP_ATTEMPTS} 条时旧的移到归档`, () => {
    const attempts = Array.from({ length: KEEP_ATTEMPTS + 3 }, (_, i) => mkAttempt(i + 1));
    const saved = store.save({ task: mkTask(), attempts });
    expect(saved.attempts).toHaveLength(KEEP_ATTEMPTS);
    expect(saved.attempts[0].id).toBe('att_4');
    expect(store.archivedAttempts('task_a').map((a) => a.id)).toEqual(['att_1', 'att_2', 'att_3']);
    expect(store.load('task_a')?.attempts).toHaveLength(KEEP_ATTEMPTS);
  });

  it('日志：跳过崩溃留下的半行；intent 没 done 判为未确认', () => {
    store.append('task_a', {
      t: 'intent',
      at: T0,
      attemptId: 'att_1',
      seq: 1,
      action: 'github.comment',
      hash: 'h1',
    });
    store.append('task_a', { t: 'done', at: T0, attemptId: 'att_1', seq: 1, externalId: 'c1' });
    store.append('task_a', {
      t: 'intent',
      at: T0,
      attemptId: 'att_1',
      seq: 2,
      action: 'github.comment',
      hash: 'h2',
    });
    fs.appendFileSync(path.join(dir, 'task_a.events.jsonl'), '{"t":"done","at":1,"atte');
    expect(store.journal('task_a')).toHaveLength(3);
    expect(store.unconfirmedExternal('task_a', 'att_1')).toBe(true);
    expect(store.unconfirmedExternal('task_a', 'att_2')).toBe(false);
    // 半行之后追加的新行先补换行，不会粘在半行后面一起丢
    store.append('task_a', { t: 'done', at: T0, attemptId: 'att_1', seq: 2 });
    expect(store.journal('task_a')).toHaveLength(4);
    expect(store.unconfirmedExternal('task_a', 'att_1')).toBe(false);
  });

  describe('写到一半崩溃', () => {
    const v1: TaskRecord = { task: mkTask('task_a', { title: 'v1' }), attempts: [] };
    const v2: TaskRecord = {
      task: mkTask('task_a', { title: 'v2', status: 'queued' }),
      attempts: [mkAttempt(1)],
    };

    it('快照写临时文件时崩溃：读到旧版本', () => {
      store.save(v1);
      __storeDeps.writeAtomic = (file, data) => {
        fs.writeFileSync(`${file}.tmp`, data.slice(0, 20)); // 写了一半，没 rename
        throw new Error('crash');
      };
      expect(() => store.save(v2)).toThrow('crash');
      expect(store.load('task_a')?.task.title).toBe('v1');
    });

    it('快照写完、日志追加前崩溃：读到新版本，日志少一条', () => {
      store.save(v1);
      store.append('task_a', {
        t: 'state',
        at: T0,
        event: 'trigger',
        from: 'idle',
        to: 'queued',
        gen: 0,
      });
      store.save(v2);
      __storeDeps.append = () => {
        throw new Error('crash');
      };
      expect(() =>
        store.append('task_a', {
          t: 'state',
          at: T0,
          event: 'slot_acquired',
          from: 'queued',
          to: 'running',
          gen: 1,
        }),
      ).toThrow('crash');
      expect(store.load('task_a')?.task.title).toBe('v2');
      expect(store.journal('task_a')).toHaveLength(1);
    });

    it('归档追加后、快照写入前崩溃：快照仍是旧的完整版本（归档可能多出重复条目）', () => {
      const many = Array.from({ length: KEEP_ATTEMPTS + 1 }, (_, i) => mkAttempt(i + 1));
      store.save(v1);
      __storeDeps.writeAtomic = () => {
        throw new Error('crash');
      };
      expect(() => store.save({ task: v1.task, attempts: many })).toThrow('crash');
      expect(store.load('task_a')?.attempts).toEqual([]);
      expect(store.archivedAttempts('task_a').map((a) => a.id)).toEqual(['att_1']);
    });
  });

  it('remove 删掉全部文件', () => {
    store.save({
      task: mkTask(),
      attempts: Array.from({ length: KEEP_ATTEMPTS + 1 }, (_, i) => mkAttempt(i)),
    });
    store.append('task_a', { t: 'note', at: T0, msg: 'x' });
    store.remove('task_a');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
