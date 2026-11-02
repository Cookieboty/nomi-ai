#!/usr/bin/env node
/**
 * 持续任务存储 golden（apps/desktop-electron/internal/core/src/tasks/TaskStore.ts）。
 * Node 版在临时目录里写出各种文件（正常、归档、半行日志、坏文件、残留 .tmp、id 不匹配），记录目录内容与读取结果。
 * Go 版（internal/core/tasks/store_parity_test.go）把同样的文件铺到临时目录，比对 LoadAll / Journal /
 * ArchivedAttempts / UnconfirmedExternal；再用 Go 写同样的记录，内容须与 Node 写出的文件按 JSON 相等。
 * 输出 apps/desktop-go/internal/core/tasks/testdata/tasks-store.json（NOMI_GOLDEN_DIR 优先）。
 * Usage: node --import tsx scripts/parity/record-tasks-store.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { importSources } = await import(pathToFileURL(path.join(here, 'src-bundle.mjs')).href);
const { S } = await importSources(root, {
  S: path.join(root, 'apps/desktop-electron/internal/core/src/tasks/TaskStore.ts'),
});

const T0 = 1_800_000_000_000;
const mkTask = (id, over = {}) => ({
  id,
  title: `title ${id}`,
  goal: '每天 9 点看 CI',
  origin: { conversationId: 'conv_1', createdBy: 'nomi', createdAt: T0 },
  trigger: { kind: 'schedule', at: T0, repeat: { kind: 'weekly', days: [1, 3] }, catchUpMs: 43200000 },
  executor: { kind: 'cli', cli: 'codex', model: 'gpt', cwd: '/w', isolation: 'worktree' },
  grant: {
    version: 2,
    level: 2,
    paths: ['/w'],
    connections: [{ connectionId: 'conn_1', capabilities: ['github.read'], resources: ['o/r'] }],
    grantedAt: T0,
    expiresAt: T0 + 86400000,
  },
  budget: { maxTokensPerAttempt: 200000, maxDurationMsPerAttempt: 1800000, maxCostUsdPerDay: 1, maxRetries: 3 },
  acceptance: 'user',
  status: 'waiting_user',
  enabled: true,
  gen: 3,
  retryCount: 1,
  consecutiveFailures: 0,
  wait: { kind: 'approval', requestId: 'r1', detail: 'rm', resumeTo: 'running' },
  lastAttemptId: 'att_3',
  nextRunAt: T0 + 1000,
  lastError: { code: 'network', message: 'reset' },
  updatedAt: T0 + 5,
  schemaVersion: 1,
  ...over,
});
const mkAttempt = (i, over = {}) => ({
  id: `att_${i}`,
  taskId: 'task_a',
  gen: i,
  cause: { kind: 'resume', note: 'n', answer: { requestId: 'q', approve: false, input: '' } },
  snapshot: { grantVersion: 2, providerId: 'p', model: 'm', cli: 'codex', cwd: '/w', worktree: '/w/.nomi' },
  status: 'failed',
  startedAt: T0 + i,
  endedAt: T0 + i + 1,
  usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.25, costKnown: true },
  result: { summary: 's', artifacts: [{ kind: 'diff', ref: 'x' }] },
  error: { code: 'network', message: 'm' },
  carrier: { tabId: 'tab', sessionId: 'sess' },
  ...over,
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-store-rec-'));
const warns = [];
const store = new S.TaskStore(dir, { warn: (m, x) => warns.push({ m, x }) });

// 正常 + 归档
const saves = [
  { task: mkTask('task_a'), attempts: Array.from({ length: S.KEEP_ATTEMPTS + 2 }, (_, i) => mkAttempt(i + 1)) },
  { task: mkTask('task_b', { status: 'idle', wait: undefined, trigger: { kind: 'manual' } }), attempts: [] },
  {
    task: mkTask('task_c', {
      trigger: { kind: 'event', sourceId: 'github', filter: { repo: 'o/r', kinds: ['comment'] }, mode: 'observe' },
      executor: { kind: 'nomi', tools: [] },
      pending: { cause: 'retry', note: 'network', notBefore: T0 + 9 },
    }),
    attempts: [mkAttempt(1, { status: 'running', endedAt: undefined, result: undefined, error: undefined, carrier: undefined })],
  },
];
const nodeSaved = saves.map((r) => store.save(JSON.parse(JSON.stringify(r))));

// 日志：intent/done、半行、半行后续写
store.append('task_a', { t: 'state', at: T0, event: 'trigger', from: 'idle', to: 'queued', gen: 0 });
store.append('task_a', { t: 'intent', at: T0, attemptId: 'att_3', seq: 1, action: 'github.comment', hash: 'h1' });
store.append('task_a', { t: 'done', at: T0, attemptId: 'att_3', seq: 1, externalId: 'c1' });
store.append('task_a', { t: 'intent', at: T0, attemptId: 'att_3', seq: 2, action: 'github.comment', hash: 'h2' });
fs.appendFileSync(path.join(dir, 'task_a.events.jsonl'), '{"t":"done","at":1,"atte');
store.append('task_a', { t: 'note', at: T0, msg: '晚到的回报已丢弃', attemptId: 'att_2' });
store.append('task_c', { t: 'intent', at: T0, attemptId: 'att_1', seq: 0, action: 'mcp.mail.send', hash: 'h' });

// 干扰文件
fs.writeFileSync(path.join(dir, 'task_bad.json'), '{ not json');
fs.writeFileSync(path.join(dir, 'task_mismatch.json'), JSON.stringify({ task: mkTask('task_x'), attempts: [] }));
fs.writeFileSync(path.join(dir, 'task_noattempts.json'), JSON.stringify({ task: mkTask('task_noattempts') }));
fs.writeFileSync(path.join(dir, 'task_v2.json'), JSON.stringify({ task: mkTask('task_v2', { schemaVersion: 2 }), attempts: [] }));
fs.writeFileSync(path.join(dir, 'task_a.json.tmp'), '{"half');
fs.writeFileSync(path.join(dir, 'README.json'), '{}');

const files = {};
for (const n of fs.readdirSync(dir).sort()) files[n] = fs.readFileSync(path.join(dir, n), 'utf8');

const ids = ['task_a', 'task_b', 'task_c'];
const out = {
  files,
  saved: nodeSaved,
  loadAll: store.loadAll(),
  journal: Object.fromEntries(ids.map((id) => [id, store.journal(id)])),
  archived: Object.fromEntries(ids.map((id) => [id, store.archivedAttempts(id)])),
  unconfirmed: [
    ['task_a', 'att_3'],
    ['task_a', 'att_2'],
    ['task_c', 'att_1'],
    ['task_b', 'att_1'],
  ].map(([id, a]) => ({ id, attemptId: a, value: store.unconfirmedExternal(id, a) })),
  warnCount: warns.length,
};
fs.rmSync(dir, { recursive: true, force: true });

const outDir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/tasks/testdata');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tasks-store.json'), `${JSON.stringify(out, null, 1)}\n`);
console.info(`tasks-store: ${Object.keys(files).length} files, ${out.loadAll.length} records`);
