import { describe, expect, it } from 'vitest';

import type { HarnessTraceEvent } from '../src/services/harnessClient';
import { diffAllAdded, diffStrings, parsePatch } from '../src/utils/lineDiff';
import {
  buildTimeline,
  classifyTool,
  commandOf,
  describeCall,
  diffsOf,
  diffStats,
  entriesFromLegacyTools,
  formatDuration,
  groupDuration,
  groupStats,
  groupTitle,
  reduceTrace,
  shortPath,
  type ToolCall,
} from '../src/utils/toolTrace';

const start = (id: string, name: string, input?: unknown, at = 0, parentId?: string) =>
  ({
    type: 'tool',
    name,
    status: 'start',
    detail: id,
    at,
    ...(input !== undefined ? { input: JSON.stringify(input) } : {}),
    ...(parentId ? { parentId } : {}),
  }) as HarnessTraceEvent;
const end = (
  id: string,
  status: 'done' | 'error' = 'done',
  output?: string,
  at = 0,
  name = 'tool',
) =>
  ({
    type: 'tool',
    name,
    status,
    detail: id,
    at,
    ...(output ? { output } : {}),
  }) as HarnessTraceEvent;

const call = (name: string, input?: unknown, over: Partial<ToolCall> = {}): ToolCall => ({
  id: name + Math.random(),
  name,
  status: 'done',
  ...(input !== undefined ? { input: JSON.stringify(input) } : {}),
  ...over,
});

describe('classifyTool', () => {
  it('maps common tool names across harnesses', () => {
    expect(classifyTool('Read')).toBe('read');
    expect(classifyTool('read_file')).toBe('read');
    expect(classifyTool('Grep')).toBe('search');
    expect(classifyTool('Glob')).toBe('search');
    expect(classifyTool('LS')).toBe('list');
    expect(classifyTool('list_dir')).toBe('list');
    expect(classifyTool('Edit')).toBe('edit');
    expect(classifyTool('apply_patch')).toBe('edit');
    expect(classifyTool('Write')).toBe('write');
    expect(classifyTool('Bash')).toBe('command');
    expect(classifyTool('bash')).toBe('command');
    expect(classifyTool('Task')).toBe('subagent');
    expect(classifyTool('spawn_subagent')).toBe('subagent');
    expect(classifyTool('WebFetch')).toBe('web');
    expect(classifyTool('TodoWrite')).toBe('todo');
    expect(classifyTool('mcp__fs__read_file')).toBe('read');
    expect(classifyTool('something_else')).toBe('other');
  });
});

describe('reduceTrace', () => {
  it('pairs start and result by call id, tracks status and times', () => {
    const entries = reduceTrace([
      start('a', 'Read', { file_path: '/w/a.ts' }, 1000),
      start('b', 'Bash', { command: 'ls' }, 1100),
      end('a', 'done', 'content', 1500),
      end('b', 'error', 'boom', 3100),
    ]);
    expect(entries).toHaveLength(2);
    const [a, b] = entries.map((e) => (e.type === 'tool' ? e.call : null));
    expect(a).toMatchObject({
      name: 'Read',
      status: 'done',
      output: 'content',
      startedAt: 1000,
      endedAt: 1500,
    });
    expect(b).toMatchObject({ name: 'Bash', status: 'error', output: 'boom' });
  });

  it('keeps running calls running and restores the tool name from the start event', () => {
    const entries = reduceTrace([start('a', 'Grep'), end('a', 'done', undefined, 5, 'tool')]);
    expect(entries[0]).toMatchObject({ call: { name: 'Grep', status: 'done' } });
    const live = reduceTrace([start('a', 'Grep')]);
    expect(live[0]).toMatchObject({ call: { status: 'running' } });
  });

  it('falls back to the latest running call of the same name when ids are missing', () => {
    const entries = reduceTrace([
      { type: 'tool', name: 'Bash', status: 'start' },
      { type: 'tool', name: 'Bash', status: 'start' },
      { type: 'tool', name: 'Bash', status: 'done' },
    ]);
    const statuses = entries.map((e) => (e.type === 'tool' ? e.call.status : ''));
    expect(statuses).toEqual(['running', 'done']);
  });

  it('prefers the explicit id (codex: detail is the command line)', () => {
    const entries = reduceTrace([
      { type: 'tool', name: 'bash', status: 'start', id: 'i1', detail: 'ls' },
      { type: 'tool', name: 'bash', status: 'done', id: 'i1', detail: 'ls', output: 'x' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ call: { status: 'done', output: 'x' } });
  });

  it('merges consecutive thinking chunks and creates a call for a lone result', () => {
    const entries = reduceTrace([
      { type: 'thinking', text: 'a' },
      { type: 'thinking', text: 'b' },
      end('zz', 'done', 'out', 9, 'Read'),
    ]);
    expect(entries[0]).toMatchObject({ type: 'thinking', text: 'ab' });
    expect(entries[1]).toMatchObject({ call: { name: 'Read', status: 'done' } });
  });

  it('legacy tool labels become finished calls', () => {
    const e = entriesFromLegacyTools(['Read ✓', 'Bash ✗', 'Grep']);
    expect(e.map((x) => (x.type === 'tool' ? [x.call.name, x.call.status] : []))).toEqual([
      ['Read', 'done'],
      ['Bash', 'error'],
      ['Grep', 'done'],
    ]);
  });
});

describe('describeCall', () => {
  it('summarises by tool kind', () => {
    expect(describeCall(call('Read', { file_path: '/a/b.ts' }))).toMatchObject({
      kind: 'read',
      verb: '读取',
      target: '/a/b.ts',
    });
    expect(describeCall(call('Grep', { pattern: 'foo', path: 'src' }))).toMatchObject({
      kind: 'search',
      verb: '搜索',
      target: 'foo',
    });
    expect(describeCall(call('bash', { command: 'pnpm test\nsecond' }))).toMatchObject({
      kind: 'command',
      verb: '运行命令',
      target: 'pnpm test',
    });
    expect(describeCall(call('Task', { description: '查泄漏', prompt: 'x' }))).toMatchObject({
      kind: 'subagent',
      target: '查泄漏',
    });
    expect(describeCall(call('WebFetch', { url: 'https://a.dev' }))).toMatchObject({
      kind: 'web',
      verb: '访问',
    });
    expect(describeCall(call('weird_tool', { path: '/x' }))).toMatchObject({
      kind: 'other',
      verb: '调用',
    });
    expect(describeCall(call('Read'))).toMatchObject({ kind: 'read', target: undefined });
  });

  it('shortens long paths to the tail', () => {
    const long = '/very/long/path/that/keeps/going/and/going/deep/inside/the/repo/src/file.ts';
    const s = shortPath(long, 30);
    expect(s.startsWith('…/')).toBe(true);
    expect(s.endsWith('file.ts')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(32);
  });

  it('commandOf supports string, array and raw text input', () => {
    expect(commandOf(call('bash', { command: 'ls -la' }))).toBe('ls -la');
    expect(commandOf(call('bash', { command: ['git', 'status'] }))).toBe('git status');
    expect(commandOf({ id: 'x', name: 'bash', status: 'done', input: 'echo hi' })).toBe('echo hi');
  });
});

describe('buildTimeline grouping', () => {
  const run = (...calls: Array<[string, string, unknown?]>) =>
    reduceTrace(calls.flatMap(([id, name, input]) => [start(id, name, input), end(id)]));

  it('folds consecutive explore calls into one group; a single call stays a row', () => {
    const items = buildTimeline(
      run(
        ['1', 'Read', { file_path: 'a' }],
        ['2', 'Read', { file_path: 'b' }],
        ['3', 'Grep', { pattern: 'x' }],
        ['4', 'Bash', { command: 'ls' }],
      ),
    );
    expect(items.map((i) => i.type)).toEqual(['group', 'call']);
    const g = items[0]!;
    expect(g.type === 'group' && g.bucket).toBe('explore');
    expect(g.type === 'group' && g.calls).toHaveLength(3);
  });

  it('splits groups when the bucket changes and when thinking interrupts', () => {
    const entries = [
      ...run(['1', 'Read'], ['2', 'Grep']),
      { type: 'thinking' as const, id: 't', text: 'hm' },
      ...run(['3', 'Read'], ['4', 'Read']),
      ...run(['5', 'Bash'], ['6', 'Bash'], ['7', 'Edit']),
    ];
    const items = buildTimeline(entries);
    expect(
      items.map((i) => (i.type === 'group' ? `group:${i.bucket}:${i.calls.length}` : i.type)),
    ).toEqual(['group:explore:2', 'thinking', 'group:explore:2', 'group:command:2', 'call']);
  });

  it('nests calls with parentId under the sub-agent and marks live thinking', () => {
    const entries = reduceTrace([
      start('t', 'Task', { description: 'd' }),
      start('c1', 'Grep', { pattern: 'x' }, 0, 't'),
      end('c1'),
      start('c2', 'Read', { file_path: 'f' }, 0, 't'),
      end('c2'),
      end('t', 'done', 'result'),
      { type: 'thinking', text: '继续' },
    ]);
    const items = buildTimeline(entries, true);
    expect(items.map((i) => i.type)).toEqual(['subagent', 'thinking']);
    const sub = items[0]!;
    expect(sub.type === 'subagent' && sub.children.map((c) => c.type)).toEqual(['group']);
    expect(items[1]).toMatchObject({ type: 'thinking', running: true });
    expect(buildTimeline(entries, false)[1]).toMatchObject({ running: false });
  });

  it('an orphan parentId (unknown sub-agent) stays at top level', () => {
    const items = buildTimeline(
      reduceTrace([start('c', 'Read', undefined, 0, 'missing'), end('c')]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe('call');
  });
});

describe('group title / stats / duration', () => {
  it('summarises the explore group with counts', () => {
    const calls = [
      call('Read', { file_path: 'a' }),
      call('Read', { file_path: 'b' }),
      call('Read', { file_path: 'c' }),
      ...Array.from({ length: 5 }, () => call('Grep', { pattern: 'x' })),
      call('LS', { path: '.' }),
    ];
    expect(groupTitle('explore', calls)).toBe('已探索 3 个文件、5 次搜索、1 个目录');
    expect(
      groupTitle('explore', [...calls, call('Read', undefined, { status: 'running' })]),
    ).toMatch(/^正在探索 /);
    expect(groupTitle('command', [call('bash'), call('bash')])).toBe('已运行 2 条命令');
    expect(groupTitle('other', [call('x'), call('y')])).toBe('已调用 2 个工具');
  });

  it('counts failures, edited files and +/- lines', () => {
    const calls = [
      call('Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b\nc' }),
      call('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      call('Write', { file_path: 'n.ts', content: '1\n2\n' }, { status: 'error' }),
    ];
    const s = groupStats(calls);
    expect(s).toMatchObject({ edits: 2, failed: 1, added: 5, removed: 2 });
    expect(groupTitle('edit', calls)).toBe('已编辑 2 个文件');
  });

  it('duration spans first start to last end; unknown while running', () => {
    const a = call('x', undefined, { startedAt: 1000, endedAt: 1500 });
    const b = call('y', undefined, { startedAt: 1200, endedAt: 3500 });
    expect(groupDuration([a, b])).toBe(2500);
    expect(groupDuration([a, { ...b, status: 'running' }])).toBeUndefined();
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(2400)).toBe('2.4s');
    expect(formatDuration(15_000)).toBe('15s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(undefined)).toBe('');
  });
});

describe('diffsOf / lineDiff', () => {
  it('Edit old/new → coloured lines with context and stats', () => {
    const c = call('Edit', {
      file_path: '/r/a.ts',
      old_string: 'one\ntwo\nthree\nfour\nfive',
      new_string: 'one\ntwo\n3\nfour\nfive\nsix',
    });
    const [d] = diffsOf(c);
    expect(d!.file).toBe('/r/a.ts');
    expect(d!.diff.added).toBe(2);
    expect(d!.diff.removed).toBe(1);
    const types = d!.diff.lines.map((l) => l.type);
    expect(types).toContain('del');
    expect(types).toContain('add');
    expect(d!.diff.lines.find((l) => l.type === 'del')).toMatchObject({ text: 'three', oldNo: 3 });
    expect(diffStats(c)).toEqual({ added: 2, removed: 1, files: 1 });
  });

  it('MultiEdit merges hunks; Write is all additions; patch text is parsed', () => {
    const multi = call('MultiEdit', {
      file_path: 'f',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    expect(diffsOf(multi)[0]!.diff).toMatchObject({ added: 2, removed: 2 });
    expect(diffsOf(call('Write', { file_path: 'n', content: 'x\ny' }))[0]!.diff).toMatchObject({
      added: 2,
      removed: 0,
    });
    const patch = call('apply_patch', { path: 'p', patch: '@@ -1,2 +1,2 @@\n a\n-b\n+c' });
    expect(diffsOf(patch)[0]!.diff).toMatchObject({ added: 1, removed: 1 });
  });

  it('codex file_change without content is a summary-only entry; non-edit tools have no diff', () => {
    const c = call('file_change', {
      changes: [
        { path: 'a.ts', kind: 'update' },
        { path: 'b.ts', kind: 'add' },
      ],
    });
    const d = diffsOf(c);
    expect(d.map((x) => x.file)).toEqual(['a.ts', 'b.ts']);
    expect(d[0]!.summaryOnly).toBe(true);
    expect(diffsOf(call('Read', { file_path: 'a' }))).toEqual([]);
    expect(diffsOf(call('Edit'))).toEqual([]);
  });

  it('diffStrings handles identical, empty and large inputs', () => {
    expect(diffStrings('a\nb', 'a\nb')).toMatchObject({ added: 0, removed: 0, lines: [] });
    expect(diffStrings('', 'x')).toMatchObject({ added: 1, removed: 0 });
    const big = Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n');
    const r = diffStrings(big, `${big}\nextra`);
    expect(r).toMatchObject({ added: 1, removed: 0 });
    const far = diffStrings(big, Array.from({ length: 400 }, (_, i) => `m${i}`).join('\n'));
    expect(far).toMatchObject({ added: 400, removed: 400 });
    expect(diffAllAdded('').lines).toEqual([]);
    expect(parsePatch('+a\n-b\n c')).toMatchObject({ added: 1, removed: 1 });
  });
});

describe('buildTimeline：思考块起止时间', () => {
  const th = (text: string, at: number): HarnessTraceEvent => ({ type: 'thinking', text, at });
  const call = (name: string, at: number): HarnessTraceEvent => ({
    type: 'tool',
    name,
    status: 'start',
    id: `${name}-${at}`,
    at,
  });

  it('思考结束于下一步开始；末尾思考用整轮结束时间；运行中无结束', () => {
    const items = buildTimeline(reduceTrace([th('a', 1000), th('b', 1500), call('grep', 4000)]));
    const t = items[0]!;
    expect(t.type === 'thinking' && [t.startedAt, t.endedAt]).toEqual([1000, 4000]);

    const tail = buildTimeline(reduceTrace([th('a', 1000)]), false, 9000)[0]!;
    expect(tail.type === 'thinking' && tail.endedAt).toBe(9000);

    const live = buildTimeline(reduceTrace([th('a', 1000)]), true, 9000)[0]!;
    expect(live.type === 'thinking' && [live.running, live.endedAt]).toEqual([true, undefined]);
  });
});
