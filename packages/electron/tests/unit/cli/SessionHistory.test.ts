jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { parseTranscript } from '../../../src/cli/historyTranscript';
import {
  parseClaudeTranscript,
  parseCodexTranscript,
  parseDshTranscript,
  parseGeminiTranscript,
} from '../../../src/cli/historyTranscript';
import {
  DSH_META_MAX_ZSTD_BYTES,
  SessionHistoryService,
} from '../../../src/cli/SessionHistoryService';
import { CliHarnessService } from '../helpers/harness';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const FIX = path.resolve(__dirname, '../../fixtures/history');
const fx = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');
const mockDir = path.resolve(__dirname, '../../../scripts/mock-cli');

function zstdCompress(text: string): Buffer | null {
  const native = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  if (native) return native(Buffer.from(text));
  try {
    return execFileSync('zstd', ['-c'], { input: text, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

describe('history transcript parsers (fixtures)', () => {
  it('claude: user/assistant text, tool names merged, no tool_result / meta / sidechain', () => {
    const m = parseClaudeTranscript(fx('claude-tools.jsonl'));
    expect(m.map((x) => [x.role, x.content])).toEqual([
      ['user', 'Fix the failing login test'],
      ['assistant', 'Let me look at the test.\n\nThe test expected a 401; fixed.'],
      ['user', 'Thanks, now run it'],
    ]);
    expect(m[1]!.tools).toEqual(['Read']);
    expect(m.every((x) => !x.content.includes('sub-agent') && !x.content.includes('caveat'))).toBe(
      true,
    );
    expect(m[0]!.timestamp).toBe(Date.parse('2026-10-14T10:00:01.000Z'));
  });

  it('claude (real sample): prompt + reply, attachments / queue records ignored', () => {
    const m = parseClaudeTranscript(fx('claude-real.jsonl'));
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(m[0]!.content).toBe(
      'Use the Read tool to read /tmp/e2e/note.txt and tell me its contents.',
    );
    expect(m[1]!.content.length).toBeGreaterThan(10);
  });

  it('codex (real sample + extras): skips environment / AGENTS.md injections, keeps tool names', () => {
    const m = parseCodexTranscript(fx('codex-rollout.jsonl'));
    expect(m.map((x) => [x.role, x.content])).toEqual([
      ['user', 'Reply with exactly: pong'],
      ['assistant', 'pong'],
      ['user', 'List the files'],
      ['assistant', 'There are two files: a.txt and b.txt.'],
    ]);
    expect(m[3]!.tools).toEqual(['shell']);
  });

  it('dsh (real sample): only source.kind=user prompts and assistant messages', () => {
    const m = parseDshTranscript(fx('dsh-session.jsonl'));
    expect(m.map((x) => [x.role, x.content])).toEqual([
      ['user', 'Reply with just the word PONG'],
      ['assistant', 'PONG'],
      ['user', 'Say it again'],
      ['assistant', 'PONG'],
    ]);
  });

  it('claude: restored transcript carries trace (thinking, tool input / output, timing) and turn duration', () => {
    const m = parseClaudeTranscript(fx('claude-tools.jsonl'));
    const a = m[1]!;
    expect(a.trace?.map((e) => [e.type, e.type === 'tool' ? `${e.name}:${e.status}` : ''])).toEqual(
      [
        ['thinking', ''],
        ['tool', 'Read:start'],
        ['tool', 'Read:done'],
      ],
    );
    const start = a.trace![1] as { input?: string; at?: number; textAt?: number };
    const done = a.trace![2] as { output?: string; id?: string; at?: number };
    expect(JSON.parse(start.input!)).toEqual({ file_path: '/work/app/login.test.ts' });
    expect(done.output).toBe('file contents');
    expect(done.at! - start.at!).toBe(1000);
    expect((a.trace![0] as { textAt?: number }).textAt).toBe(0);
    expect(start.textAt).toBe('Let me look at the test.'.length);
    expect(a.textBreaks).toEqual(['Let me look at the test.'.length + 2]);
    // 整轮耗时：用户提问（10:00:01）→ 最后一个助手事件（10:00:06）
    expect(a.durationMs).toBe(5000);
  });

  it('claude: tool_result with is_error becomes an error call; usage last-wins input/cache, sums output', () => {
    const jl = [
      {
        type: 'user',
        message: { role: 'user', content: 'run it' },
        timestamp: '2026-10-14T10:00:00.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'false' } }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        },
        timestamp: '2026-10-14T10:00:01.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              content: [{ type: 'text', text: 'exit 1' }],
              is_error: true,
            },
          ],
        },
        timestamp: '2026-10-14T10:00:02.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'failed' }],
          usage: { input_tokens: 20, output_tokens: 7 },
        },
        timestamp: '2026-10-14T10:00:03.000Z',
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n');
    const m = parseClaudeTranscript(jl);
    expect(m).toHaveLength(2);
    expect(m[1]!.trace![1]).toMatchObject({
      type: 'tool',
      name: 'Bash',
      status: 'error',
      output: 'exit 1',
    });
    // 计费字段：input/cache 末步、output 累加；上下文取最后一次请求（20 + 7）
    expect(m[1]!.usage).toEqual({
      inputTokens: 20,
      outputTokens: 12,
      cacheReadTokens: 100,
      contextTokens: 27,
    });
  });

  it('codex: function_call / function_call_output pair into a trace; JSON output unwrapped, non-zero exit is an error', () => {
    const m = parseCodexTranscript(fx('codex-rollout.jsonl'));
    const a = m[3]!;
    expect(a.trace).toEqual([
      expect.objectContaining({ type: 'tool', name: 'shell', status: 'start', id: 'c1' }),
      expect.objectContaining({
        type: 'tool',
        name: 'shell',
        status: 'done',
        id: 'c1',
        output: 'a.txt\nb.txt',
      }),
    ]);
    const jl = [
      {
        timestamp: '2026-10-14T10:00:00.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      },
      {
        timestamp: '2026-10-14T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan it' }] },
      },
      {
        timestamp: '2026-10-14T10:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          arguments: '{"command":["false"]}',
          call_id: 'x',
        },
      },
      {
        timestamp: '2026-10-14T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'x',
          output: '{"output":"boom","metadata":{"exit_code":1,"duration_seconds":0.5}}',
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n');
    const r = parseCodexTranscript(jl)[1]!;
    expect(r.trace![0]).toMatchObject({ type: 'thinking', text: 'plan it' });
    expect(r.trace![2]).toMatchObject({ status: 'error', output: 'boom' });
    expect(r.durationMs).toBe(3000);
  });

  it('dsh: assistant usage is carried; tool blocks / results are paired when present', () => {
    const m = parseDshTranscript(fx('dsh-session.jsonl'));
    expect(m[1]!.usage).toMatchObject({ inputTokens: 4651, outputTokens: 3, cacheReadTokens: 3 });
    expect(m[1]!.durationMs).toBeGreaterThan(1000);
  });

  it('gemini: thoughts / tool calls become a trace; rewritten messages are folded by id', () => {
    const lines = [
      { sessionId: 'g', kind: 'main' },
      { id: 'u', type: 'user', timestamp: '2026-10-19T00:00:01Z', content: [{ text: 'ls' }] },
      { id: 'i', type: 'info', content: 'Request cancelled.' },
      {
        id: 'm',
        type: 'gemini',
        timestamp: '2026-10-19T00:00:02Z',
        content: '',
        toolCalls: [{ id: 't1', name: 'run_shell_command', args: { command: 'ls' } }],
      },
      {
        id: 'm',
        type: 'gemini',
        timestamp: '2026-10-19T00:00:03Z',
        content: '',
        thoughts: [{ subject: 'Listing', description: 'run ls' }],
        toolCalls: [
          {
            id: 't1',
            name: 'run_shell_command',
            args: { command: 'ls' },
            status: 'success',
            result: [],
            resultDisplay: 'a.txt',
          },
        ],
      },
      { id: 'm2', type: 'gemini', timestamp: '2026-10-19T00:00:04Z', content: 'a.txt' },
    ];
    const m = parseGeminiTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(m.map((x) => [x.role, x.content])).toEqual([
      ['user', 'ls'],
      ['assistant', 'a.txt'],
    ]);
    const trace = m[1]!.trace ?? [];
    expect(trace.some((e) => e.type === 'thinking')).toBe(true);
    expect(trace).toContainEqual(
      expect.objectContaining({ type: 'tool', name: 'run_shell_command', status: 'done' }),
    );
  });

  it('tolerates garbage and truncated lines', () => {
    expect(parseClaudeTranscript('not json\n{"type":"user"')).toEqual([]);
    expect(parseCodexTranscript('')).toEqual([]);
    expect(parseDshTranscript('{"type":"user/message"}')).toEqual([]);
  });
});

describe('SessionHistoryService', () => {
  let home: string;
  let work: string;
  const claudeDir = () => path.join(home, '.claude', 'projects', '-work-app');
  const touch = (p: string, ms: number) => fs.utimesSync(p, new Date(ms), new Date(ms));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-home-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-work-'));
    fs.mkdirSync(claudeDir(), { recursive: true });
  });
  afterEach(() => jest.restoreAllMocks());

  const writeClaude = (id: string, title: string, mtime: number, cwd = work) => {
    const p = path.join(claudeDir(), `${id}.jsonl`);
    const ev = (o: object) => JSON.stringify(o);
    fs.writeFileSync(
      p,
      [
        ev({
          type: 'user',
          sessionId: id,
          cwd,
          timestamp: '2026-10-14T10:00:00.000Z',
          message: { role: 'user', content: title },
        }),
        ev({
          type: 'assistant',
          sessionId: id,
          cwd,
          timestamp: '2026-10-14T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
          },
        }),
      ].join('\n') + '\n',
    );
    touch(p, mtime);
    return p;
  };
  const mk = (extra: ConstructorParameters<typeof SessionHistoryService>[0] = {}) =>
    new SessionHistoryService({ home, ...extra });

  it('lists Claude sessions newest first and skips empty / sub-agent files', async () => {
    writeClaude('a', 'older task', 1_000_000);
    writeClaude('b', 'newer task', 2_000_000);
    // 只有 queue-operation、没有提问：不列出
    const empty = path.join(claudeDir(), 'empty.jsonl');
    fs.writeFileSync(
      empty,
      '{"type":"queue-operation","operation":"enqueue","sessionId":"empty"}\n',
    );
    // 子代理文件在会话子目录里，不是顶层 jsonl
    fs.mkdirSync(path.join(claudeDir(), 'a', 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir(), 'a', 'subagents', 'agent-1.jsonl'),
      '{"type":"user","isSidechain":true,"sessionId":"a","message":{"role":"user","content":"sub"}}\n',
    );
    const page = await mk().list('claude');
    expect(page.items.map((x) => [x.sessionId, x.title])).toEqual([
      ['b', 'newer task'],
      ['a', 'older task'],
    ]);
    expect(page.items[0]).toMatchObject({ backend: 'claude', cwd: work, cwdMissing: false });
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('keeps a main session that merely contains sidechain lines; drops pure sub-agent files', async () => {
    const p = writeClaude('mixed', 'main task', 1_000_000);
    fs.appendFileSync(
      p,
      '{"type":"assistant","isSidechain":true,"sessionId":"mixed","message":{"role":"assistant","content":"x"}}\n',
    );
    fs.writeFileSync(
      path.join(claudeDir(), 'sub.jsonl'),
      '{"type":"user","isSidechain":true,"sessionId":"sub","message":{"role":"user","content":"sub task"}}\n',
    );
    const page = await mk().list('claude');
    expect(page.items.map((x) => x.sessionId)).toEqual(['mixed']);
  });

  it('pages 20 at a time per endpoint', async () => {
    for (let i = 0; i < 45; i++)
      writeClaude(`s${String(i).padStart(3, '0')}`, `task ${i}`, 1_000_000 + i * 1000);
    const svc = mk();
    const p1 = await svc.list('claude');
    expect(p1.items).toHaveLength(20);
    expect(p1.hasMore).toBe(true);
    expect(p1.items[0]!.sessionId).toBe('s044');
    const p2 = await svc.list('claude', { offset: p1.nextOffset! });
    expect(p2.items).toHaveLength(20);
    expect(p2.items[0]!.sessionId).toBe('s024');
    const p3 = await svc.list('claude', { offset: p2.nextOffset! });
    expect(p3.items).toHaveLength(5);
    expect(p3.hasMore).toBe(false);
    const ids = new Set([...p1.items, ...p2.items, ...p3.items].map((x) => x.sessionId));
    expect(ids.size).toBe(45);
  });

  it('只返回最近 500 条（硬上限），更早的会话不再翻页', async () => {
    for (let i = 0; i < 530; i++)
      writeClaude(`s${String(i).padStart(3, '0')}`, `task ${i}`, 1_000_000 + i * 1000);
    const svc = mk();
    const seen: string[] = [];
    let offset: number | undefined;
    for (let guard = 0; guard < 40; guard++) {
      const page = await svc.list('claude', { offset });
      seen.push(...page.items.map((x) => x.sessionId));
      if (!page.hasMore) break;
      offset = page.nextOffset ?? undefined;
    }
    expect(seen).toHaveLength(500);
    expect(seen).toContain('s529');
    expect(seen).toContain('s030');
    expect(seen).not.toContain('s029');
    expect(seen).not.toContain('s000');
  });

  it('无标题 / sidechain 文件不会占满 500 条可见历史的上限', async () => {
    for (let i = 0; i < 12; i++) {
      const p = path.join(claudeDir(), `sub-${String(i).padStart(3, '0')}.jsonl`);
      fs.writeFileSync(
        p,
        `{"type":"user","isSidechain":true,"sessionId":"sub-${i}","message":{"role":"user","content":"sub"}}\n`,
      );
      touch(p, 2_000_000 - i);
    }
    for (let i = 0; i < 500; i++)
      writeClaude(`visible-${String(i).padStart(3, '0')}`, `task ${i}`, 1_000_000 - i);
    const svc = mk();
    const seen: string[] = [];
    let offset: number | undefined;
    for (let guard = 0; guard < 40; guard++) {
      const page = await svc.list('claude', { offset });
      seen.push(...page.items.map((x) => x.sessionId));
      if (!page.hasMore) break;
      offset = page.nextOffset ?? undefined;
    }
    expect(seen).toHaveLength(500);
    expect(seen).toContain('visible-000');
    expect(seen).toContain('visible-499');
  });

  it('index: hands out compact entries in 20-item resumable pages (for sidebar search)', async () => {
    for (let i = 0; i < 45; i++)
      writeClaude(`s${String(i).padStart(3, '0')}`, `task ${i}`, 1_000_000 + i * 1000);
    const svc = mk();
    // 显式要更大的页也会被夹到 20
    const a = await svc.index('claude', { limit: 70 });
    expect(a.items).toHaveLength(20);
    expect(a.hasMore).toBe(true);
    expect(a.items.every((x) => x.cwdMissing === false)).toBe(true);
    const b = await svc.index('claude', { offset: a.nextOffset! });
    expect(b.items).toHaveLength(20);
    const c = await svc.index('claude', { offset: b.nextOffset! });
    expect(c.items).toHaveLength(5);
    expect(c.hasMore).toBe(false);
    expect(new Set([...a.items, ...b.items, ...c.items].map((x) => x.key)).size).toBe(45);
    // 默认一页 20 条
    expect((await mk().index('claude')).items).toHaveLength(20);
  });

  it('is incremental: unchanged files are not re-read, changed files are', async () => {
    const a = writeClaude('a', 'task a', 1_000_000);
    writeClaude('b', 'task b', 2_000_000);
    const svc = mk();
    await svc.list('claude');
    const open = jest.spyOn(fs.promises, 'open');
    await svc.list('claude', { force: true });
    expect(open).not.toHaveBeenCalled();
    writeClaude('a', 'task a (edited)', 3_000_000);
    expect(fs.existsSync(a)).toBe(true);
    const again = await svc.list('claude', { force: true });
    expect(open).toHaveBeenCalledTimes(1);
    expect(again.items.map((x) => x.title)).toEqual(['task a (edited)', 'task b']);
  });

  it('hides sessions that are already open in a Nomi tab', async () => {
    writeClaude('a', 'task a', 1_000_000);
    writeClaude('b', 'task b', 2_000_000);
    const openTitle = jest.fn();
    const page = await mk({
      openKeys: () => new Set(['claude:a']),
      openTitle,
    }).list('claude');
    expect(page.items.map((x) => x.sessionId)).toEqual(['b']);
    expect(openTitle).toHaveBeenCalledWith('claude', 'a', 'task a');
  });

  it('flags sessions whose working directory is gone, and refuses to open them', async () => {
    writeClaude('gone', 'old project', 1_000_000, '/definitely/not/here');
    const openTab = jest.fn();
    const svc = mk({ openTab });
    const page = await svc.list('claude');
    expect(page.items[0]!.cwdMissing).toBe(true);
    const r = await svc.open('claude', 'gone');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('/definitely/not/here');
    expect(openTab).not.toHaveBeenCalled();
  });

  it('lists Codex rollouts (large session_meta) with title and cwd', async () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '14');
    fs.mkdirSync(dir, { recursive: true });
    const id = '01a13a9b-34b0-7612-ba36-613a55008483';
    const text = fx('codex-rollout.jsonl').replace(
      /"cwd":\s*"\/tmp"/g,
      `"cwd":${JSON.stringify(work)}`,
    );
    // 模拟真实的巨大 base_instructions（超过 100KB）
    const big = text.replace('(trimmed)', 'x'.repeat(200 * 1024));
    const p = path.join(dir, `rollout-2026-10-14T21-30-12-${id}.jsonl`);
    fs.writeFileSync(p, big);
    const page = await mk().list('codex');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sessionId: id,
      title: 'Reply with exactly: pong',
      cwd: work,
      backend: 'codex',
    });
  });

  it('honours CODEX_HOME and CLAUDE_CONFIG_DIR instead of ~/.codex and ~/.claude', async () => {
    const codexHome = path.join(home, 'custom-codex');
    const dir = path.join(codexHome, 'sessions', '2026', '10', '14');
    fs.mkdirSync(dir, { recursive: true });
    const id = '01a13a9b-34b0-7612-ba36-613a55008483';
    const text = fx('codex-rollout.jsonl').replace(
      /"cwd":\s*"\/tmp"/g,
      `"cwd":${JSON.stringify(work)}`,
    );
    fs.writeFileSync(path.join(dir, `rollout-2026-10-14T21-30-12-${id}.jsonl`), text);
    const claudeHome = path.join(home, 'custom-claude');
    const proj = path.join(claudeHome, 'projects', '-work-app');
    fs.mkdirSync(proj, { recursive: true });
    fs.copyFileSync(writeClaude('c1', 'custom dir task', 1_000_000), path.join(proj, 'c1.jsonl'));
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    const svc = mk({ env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome } });
    expect((await svc.list('codex')).items.map((i) => i.sessionId)).toEqual([id]);
    expect((await svc.list('claude')).items.map((i) => i.sessionId)).toEqual(['c1']);
    // 没设环境变量时仍看 ~/.codex（这里为空）
    expect((await mk({ env: {} }).list('codex')).items).toHaveLength(0);
  });

  it('codex: one session id spread over several rollout files is listed once (newest wins, across pages)', async () => {
    const id = '01a0a531-1d64-7361-bb69-ebd1c7349662';
    const text = fx('codex-rollout.jsonl').replace(
      /"cwd":\s*"\/tmp"/g,
      `"cwd":${JSON.stringify(work)}`,
    );
    const put = (day: string, name: string, body: string, mtime: number) => {
      const dir = path.join(home, '.codex', 'sessions', '2026', '10', day);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      touch(p, mtime);
      return p;
    };
    // 同一个 id：续接后 Codex 在另一天的目录里又写了一个 rollout
    const base = text.split('01a13a9b-34b0-7612-ba36-613a55008483').join(id);
    expect(base).toContain(id);
    put('13', `rollout-2026-10-13T09-00-00-${id}.jsonl`, base, 1_000_000);
    put('15', `rollout-2026-10-15T09-00-00-${id}.jsonl`, base, 3_000_000);
    const otherId = '01a0a3b7-aaaa-7361-bb69-ebd1c7349662';
    put(
      '14',
      `rollout-2026-10-14T09-00-00-${otherId}.jsonl`,
      base.split(id).join(otherId),
      2_000_000,
    );
    const svc = mk();
    const keys: string[] = [];
    let offset: number | undefined;
    let updated = 0;
    for (let guard = 0; guard < 6; guard++) {
      const page = await svc.list('codex', { limit: 1, offset });
      for (const it of page.items) {
        keys.push(it.key);
        if (it.sessionId === id) updated = it.updatedAt;
      }
      if (!page.hasMore) break;
      offset = page.nextOffset ?? undefined;
    }
    expect(keys.sort()).toEqual([`codex:${id}`, `codex:${otherId}`].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(updated).toBe(3_000_000);
    // 一次拉满也只有两条
    const all = await mk().list('codex', { limit: 50, force: true });
    expect(all.items.map((x) => x.key).sort()).toEqual(keys);
  });

  describe('codex: compressed rollouts, sources and the sqlite index', () => {
    const day = () => path.join(home, '.codex', 'sessions', '2026', '10', '14');
    const rollout = (id: string, title: string, meta: Record<string, unknown> = {}): string =>
      [
        {
          timestamp: '2026-10-14T13:30:12.603Z',
          type: 'session_meta',
          payload: { id, cwd: work, source: 'cli', ...meta },
        },
        {
          timestamp: '2026-10-14T13:30:13.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: title }],
          },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    const write = (id: string, text: string, mtime: number, zst = false) => {
      fs.mkdirSync(day(), { recursive: true });
      const p = path.join(day(), `rollout-2026-10-14T21-30-12-${id}.jsonl${zst ? '.zst' : ''}`);
      if (zst) {
        const z = zstdCompress(text);
        if (!z) return null;
        fs.writeFileSync(p, z);
      } else fs.writeFileSync(p, text);
      touch(p, mtime);
      return p;
    };
    const ids = Array.from({ length: 6 }, (_, i) => `01a13a9b-34b0-7612-ba36-61300000000${i}`);

    it('lists .jsonl.zst rollouts, tags client / route, skips sub-agents and archived files', async () => {
      if (
        !write(
          ids[0]!,
          rollout(ids[0]!, 'compressed one', { originator: 'Codex Desktop', source: 'vscode' }),
          5_000,
          true,
        )
      )
        return; // 没有 zstd 时跳过
      write(ids[1]!, rollout(ids[1]!, 'plain cli', { model_provider: 'openai' }), 4_000);
      write(
        ids[2]!,
        rollout(ids[2]!, 'guardian', { source: { subagent: { other: 'guardian' } } }),
        3_000,
      );
      write(
        ids[3]!,
        rollout(ids[3]!, 'via cc-switch', {
          model_provider: 'custom',
          originator: 'codex_exec',
          source: 'exec',
        }),
        2_000,
      );
      write(
        ids[4]!,
        rollout(ids[4]!, 'from nomi', {
          model_provider: 'nomi_gateway',
          originator: 'nomi',
          source: 'vscode',
        }),
        1_000,
      );
      const arch = path.join(home, '.codex', 'archived_sessions');
      fs.mkdirSync(arch, { recursive: true });
      fs.writeFileSync(
        path.join(arch, `rollout-2026-10-14T21-30-12-${ids[5]}.jsonl`),
        rollout(ids[5]!, 'archived'),
      );

      const page = await mk().list('codex');
      expect(page.items.map((x) => [x.title, x.client, x.route, x.provider])).toEqual([
        ['compressed one', 'desktop', 'official', undefined],
        ['plain cli', 'cli', 'official', undefined],
        ['via cc-switch', 'exec', 'custom', 'custom'],
        ['from nomi', 'nomi', 'gateway', undefined],
      ]);
      // 压缩的会话也能读出可见对话
      const tr = await mk().transcript('codex', ids[0]!);
      expect(tr.messages.map((m) => m.content)).toEqual(['compressed one']);
    });

    it('prefers the state_5.sqlite index: renamed title, latest provider, account label', async () => {
      let Db: (new (f: string) => { exec(sql: string): void; close(): void }) | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        Db = (require('node:sqlite') as { DatabaseSync: typeof Db }).DatabaseSync;
      } catch {
        return; // 没有 node:sqlite 的环境跳过
      }
      // 压缩文件很大且没有元信息可读：只能靠索引
      if (!write(ids[0]!, 'not json at all', 5_000, true)) return;
      write(ids[1]!, rollout(ids[1]!, 'first prompt', { model_provider: 'openai' }), 4_000);
      const db = new Db!(path.join(home, '.codex', 'state_5.sqlite'));
      db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, model_provider TEXT,
        cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, model TEXT,
        creator_account_id TEXT, extra_new_column TEXT);
        INSERT INTO threads VALUES ('${ids[0]}', 'vscode', 'openai', '${work}', 'indexed title',
          NULL, 'x', 'gpt-5.5', 'acct-1', NULL);
        INSERT INTO threads VALUES ('${ids[1]}', 'cli', 'nomi_gateway', '${work}', 'first prompt',
          'renamed by user', 'first prompt', NULL, 'acct-unknown', NULL);`);
      db.close();
      const svc = mk({
        accountLabel: (b, id) => (b === 'codex' && id === 'acct-1' ? 'me@example.com' : undefined),
      });
      const page = await svc.list('codex');
      expect(page.items.map((x) => [x.title, x.route, x.account, x.model])).toEqual([
        ['indexed title', 'official', 'me@example.com', 'gpt-5.5'],
        // Codex 续接后把供应商改成了本次的：线路以索引为准；账号对不上就不显示
        ['renamed by user', 'gateway', undefined, undefined],
      ]);
      expect(page.items[0]).not.toHaveProperty('accountId');
    });

    it('recognizes Work Desktop, keeps untitled Desktop sessions and refreshes archive / resume metadata', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
      const first = write(
        ids[0]!,
        rollout(ids[0]!, '', { originator: 'codex_work_desktop', source: 'vscode' }),
        5_000,
      )!;
      const second = write(
        ids[1]!,
        rollout(ids[1]!, 'old prompt', { originator: 'Codex Desktop' }),
        4_000,
      )!;
      const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
      try {
        db.exec(
          'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, archived INTEGER, originator TEXT)',
        );
        db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(
          ids[0]!,
          null,
          0,
          'codex_work_desktop',
        );
        db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(
          ids[1]!,
          'indexed',
          0,
          'Codex Desktop',
        );
        const svc = mk();
        expect((await svc.list('codex')).items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId: ids[0],
              title: '（无标题会话）',
              client: 'desktop',
            }),
          ]),
        );
        db.prepare('UPDATE threads SET archived = 1 WHERE id = ?').run(ids[0]!);
        db.prepare('UPDATE threads SET title = ? WHERE id = ?').run('new indexed title', ids[1]!);
        // 索引按 (大小, mtime) 判断变化：原地 UPDATE 可能落在同一时间刻度内、大小也不变，
        // 负载高时会被当成没变。显式推后 mtime，让用例只验证「库变了要重读」本身。
        const dbFile = path.join(home, '.codex', 'state_5.sqlite');
        const later = new Date(fs.statSync(dbFile).mtimeMs + 5_000);
        fs.utimesSync(dbFile, later, later);
        const page = await svc.list('codex', { force: true });
        expect(page.items.map((x) => x.sessionId)).toEqual([ids[1]]);
        expect(page.items[0]!.title).toBe('new indexed title');
        expect(page.items[0]!.client).toBe('desktop');
        // 同 id 新 rollout 去重，最新文件移走后可回退到仍存在的旧文件。
        const duplicate = path.join(
          path.dirname(second),
          `rollout-2099-01-01T00-00-00-${ids[1]}.jsonl`,
        );
        fs.writeFileSync(
          duplicate,
          rollout(ids[1]!, 'resumed', { originator: 'codex_work_desktop' }),
        );
        touch(duplicate, 9_000);
        expect((await svc.list('codex', { force: true })).items).toHaveLength(1);
        fs.unlinkSync(duplicate);
        expect((await svc.list('codex', { force: true })).items).toHaveLength(1);
        expect(fs.existsSync(first)).toBe(true);
      } finally {
        db.close();
      }
    });

    it('open: 网关线路按第三方续接，官方与 custom 线路按官方续接（#90）', async () => {
      write(
        ids[0]!,
        rollout(ids[0]!, 'third party chat', {
          model_provider: 'nomi_gateway',
          originator: 'nomi',
          source: 'vscode',
        }),
        3_000,
      );
      write(ids[1]!, rollout(ids[1]!, 'official chat', { model_provider: 'openai' }), 2_000);
      write(ids[2]!, rollout(ids[2]!, 'custom chat', { model_provider: 'my_proxy' }), 1_000);
      const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
      const svc = mk({ openTab });
      const arg = (i: number) => (openTab.mock.calls[i] as unknown as [Record<string, unknown>])[0];

      await svc.open('codex', ids[0]!);
      expect(arg(0)).toMatchObject({ sessionId: ids[0], source: 'thirdParty' });
      await svc.open('codex', ids[1]!);
      expect(arg(1)).toMatchObject({ sessionId: ids[1], source: 'official' });
      await svc.open('codex', ids[2]!);
      expect(arg(2)).toMatchObject({ sessionId: ids[2], source: 'official' });
    });
  });

  const dshSetup = (id: string): boolean => {
    const dsh = path.join(home, '.dsh');
    const dir = path.join(dsh, 'sessions', '--work--', id);
    fs.mkdirSync(dir, { recursive: true });
    const z = zstdCompress(fx('dsh-session.jsonl'));
    if (!z) return false;
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), z);
    fs.writeFileSync(path.join(dir, 'session.lock'), '');
    const idx = path.join(dsh, 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(idx, { recursive: true });
    const meta = JSON.parse(fx('dsh-projcache.json'));
    meta.record.identity.cwd = work;
    fs.writeFileSync(path.join(idx, `${id}.json`), JSON.stringify(meta));
    return true;
  };

  it('lists dsh sessions from the plaintext index and reads the zstd transcript', async () => {
    const id = 'session-887fa07d-22ae-4013-849f-2b2fafcba3c3';
    if (!dshSetup(id)) return; // 没有 zstd 工具的环境：跳过
    const svc = mk();
    const page = await svc.list('dsh');
    expect(page.items[0]).toMatchObject({
      backend: 'dsh',
      sessionId: id,
      cwd: work,
      model: 'qwen2.5:0.5b',
      permissionMode: 'acceptEdits',
    });
    expect(page.items[0]!.title.length).toBeGreaterThan(0);
    const tr = await svc.transcript('dsh', id);
    expect(tr.messages.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('dsh: oversized compressed sessions are not decompressed while listing', async () => {
    const id = 'session-887fa07d-22ae-4013-849f-2b2fafcba3c4';
    if (!dshSetup(id)) return;
    const file = path.join(home, '.dsh', 'sessions', '--work--', id, 'session.v4.jsonl.zstd');
    // zstd 可跳过帧：解码器忽略它，只把压缩文件撑到上限以上
    const pad = Buffer.alloc(8 + DSH_META_MAX_ZSTD_BYTES);
    pad.writeUInt32LE(0x184d2a50, 0);
    pad.writeUInt32LE(DSH_META_MAX_ZSTD_BYTES, 4);
    fs.appendFileSync(file, pad);
    const page = await mk().list('dsh');
    expect(page.items[0]).toMatchObject({
      sessionId: id,
      cwd: work,
      permissionMode: 'acceptEdits',
    });
    expect(page.items[0]!.model).toBeUndefined();
  });

  it('open: Claude sessions the gateway served resume as third party; others keep the default (#90)', async () => {
    writeClaude('a', 'via gateway', 2_000_000);
    writeClaude('b', 'unknown', 1_000_000);
    const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
    const svc = mk({ openTab, gatewaySession: (_b, id) => id === 'a' });
    await svc.open('claude', 'a');
    await svc.open('claude', 'b');
    const arg = (i: number) => (openTab.mock.calls[i] as unknown as [Record<string, unknown>])[0];
    expect(arg(0)).toMatchObject({ sessionId: 'a', source: 'thirdParty' });
    expect(arg(1)).not.toHaveProperty('source');
  });

  it('open: a third-party session resumes on the model it last used, not the current default', async () => {
    writeClaude('a', 'via gateway', 2_000_000);
    writeClaude('b', 'official', 1_000_000);
    const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
    const svc = mk({
      openTab,
      gatewaySession: (_b, id) => id === 'a',
      // 官方会话即使有记录也不带
      sessionModel: () => 'old-provider/glm',
    });
    await svc.open('claude', 'a');
    await svc.open('claude', 'b');
    const arg = (i: number) => (openTab.mock.calls[i] as unknown as [Record<string, unknown>])[0];
    expect(arg(0)).toMatchObject({ source: 'thirdParty', lastServedRef: 'old-provider/glm' });
    expect(arg(1)).not.toHaveProperty('lastServedRef');
  });

  it('official account provenance (S9): list shows the account Nomi ran it in; open resumes in it', async () => {
    writeClaude('a', 'work task', 2_000_000);
    writeClaude('b', 'local task', 1_000_000);
    const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
    const svc = mk({
      openTab,
      sessionAccount: (_b, id) =>
        id === 'a' ? { id: 'claude-work', label: 'work@example.com' } : undefined,
    });
    const page = await svc.list('claude');
    expect(page.items.find((x) => x.sessionId === 'a')?.account).toBe('work@example.com');
    expect(page.items.find((x) => x.sessionId === 'b')).not.toHaveProperty('account');
    await svc.open('claude', 'a');
    await svc.open('claude', 'b');
    const arg = (i: number) => (openTab.mock.calls[i] as unknown as [Record<string, unknown>])[0];
    expect(arg(0)).toMatchObject({ sessionId: 'a', accountId: 'claude-work' });
    expect(arg(1)).not.toHaveProperty('accountId');
  });

  it('open: passes cwd / title / transcript / session id to the tab layer', async () => {
    writeClaude('a', 'task a', 1_000_000);
    const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
    const r = await mk({ openTab }).open('claude', 'a');
    expect(r.ok).toBe(true);
    const arg = (openTab.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg).toMatchObject({ backend: 'claude', sessionId: 'a', cwd: work, title: 'task a' });
    expect((arg.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  const writeGemini = (slug: string, id: string, mtime: number, extra: object[] = []) => {
    const dir = path.join(home, '.gemini', 'tmp', slug);
    fs.mkdirSync(path.join(dir, 'chats', id), { recursive: true });
    fs.writeFileSync(path.join(dir, '.project_root'), `${work}\n`);
    const p = path.join(dir, 'chats', `session-2026-10-19T00-00-${id.slice(0, 8)}.jsonl`);
    const lines = [
      { sessionId: id, projectHash: 'h', startTime: '2026-10-19T00:00:00Z', kind: 'main' },
      {
        id: 'u1',
        type: 'user',
        timestamp: '2026-10-19T00:00:01Z',
        content: [{ text: '看看日志' }],
      },
      ...extra,
    ];
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    // 子代理：chats/<父 id>/<子 id>.jsonl，不应列出
    fs.writeFileSync(
      path.join(dir, 'chats', id, 'sub.jsonl'),
      JSON.stringify({ sessionId: 'sub', kind: 'subagent' }) + '\n',
    );
    touch(p, mtime);
    return p;
  };

  it('gemini: lists main sessions with cwd from .project_root and opens via the tab layer', async () => {
    writeGemini('app', 'gem-11111111', 2_000_000, [
      {
        id: 'm1',
        type: 'gemini',
        timestamp: '2026-10-19T00:00:02Z',
        model: 'gemini-2.5-pro',
        reasoningEffort: 'high',
        permissionMode: 'autoEdit',
        content: '日志里没有错误',
        tokens: { input: 10, output: 4, cached: 2 },
      },
    ]);
    const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
    const h = mk({ openTab });
    const page = await h.list('gemini');
    expect(page.items).toEqual([
      expect.objectContaining({
        key: 'gemini:gem-11111111',
        title: '看看日志',
        cwd: work,
        cwdMissing: false,
        model: 'gemini-2.5-pro',
        reasoningEffort: 'high',
        permissionMode: 'acceptEdits',
      }),
    ]);
    const r = await h.open('gemini', 'gem-11111111');
    expect(r.ok).toBe(true);
    const arg = (openTab.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(arg).toMatchObject({
      backend: 'gemini',
      sessionId: 'gem-11111111',
      cwd: work,
      modelOverride: 'gemini-2.5-pro',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
    });
    const msgs = arg.messages as Array<{ role: string; content: string; usage?: unknown }>;
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', '看看日志'],
      ['assistant', '日志里没有错误'],
    ]);
    expect(msgs[1]!.usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 });
  });

  it('grok: lists updates.jsonl and restores model / security metadata when opened', async () => {
    const id = 'grok-session-1';
    const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(work), id);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'updates.jsonl');
    fs.writeFileSync(
      p,
      [
        {
          sessionId: id,
          cwd: work,
          sessionUpdate: 'user_message',
          content: [{ type: 'text', text: 'inspect project' }],
        },
        {
          sessionId: id,
          sessionUpdate: 'agent_message',
          content: [{ type: 'text', text: 'done' }],
        },
        { sessionId: id, sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' },
        {
          sessionId: id,
          usage: { modelUsage: { 'grok-4.7-build': { inputTokens: 1 } } },
          reasoningEffort: 'high',
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    touch(p, 3_000_000);
    const openTab = jest.fn(() => ({ tab: { id: 'g1' } as never, reused: false }));
    const svc = mk({ openTab });
    const page = await svc.list('grok');
    expect(page.items[0]).toMatchObject({
      backend: 'grok',
      sessionId: id,
      cwd: work,
      model: 'grok-4.7-build',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
    });
    const r = await svc.open('grok', id);
    expect(r.ok).toBe(true);
    expect((openTab.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      modelOverride: 'grok-4.7-build',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
    });
  });

  it('grok: ACP session/update chunks (user_message_chunk, single content block) are listed', async () => {
    const id = 'grok-acp-1';
    const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(work), id);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'updates.jsonl');
    const up = (update: Record<string, unknown>) => ({
      timestamp: 1_792_763_438,
      method: 'session/update',
      params: { sessionId: id, update },
    });
    fs.writeFileSync(
      p,
      [
        up({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: '你是什么模型' },
        }),
        up({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } }),
        up({
          sessionUpdate: 'tool_call',
          toolCallId: 'c1',
          title: 'run_terminal_command',
          rawInput: { command: 'ls' },
          _meta: { 'x.ai/tool': { name: 'run_terminal_command' } },
        }),
        up({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }),
        up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我是 Grok' } }),
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    touch(p, 3_000_000);
    const svc = mk();
    const page = await svc.list('grok');
    expect(page.items[0]).toMatchObject({ sessionId: id, title: '你是什么模型', cwd: work });
    const msgs = parseTranscript('grok', fs.readFileSync(p, 'utf8'));
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ['user', '你是什么模型'],
      ['assistant', '我是 Grok'],
    ]);
  });

  it('open: an unreadable transcript still opens, with a notice', async () => {
    const p = writeClaude('a', 'task a', 1_000_000);
    const openTab = jest.fn(() => ({ tab: { id: 't1' } as never, reused: false }));
    const svc = mk({ openTab });
    await svc.list('claude');
    // 缓存里有元信息，但文件被改成了无法解析的内容
    const st = fs.statSync(p);
    fs.writeFileSync(p, '###\n');
    touch(p, st.mtimeMs);
    const r = await svc.open('claude', 'a');
    expect(r.ok).toBe(true);
    expect(r.notice).toBeTruthy();
    expect((openTab.mock.calls[0] as unknown as [{ messages: unknown[] }])[0].messages).toEqual([]);
  });

  describe('remove', () => {
    /** 测试里的「废纸篓」：记下路径并真正移走，后续列表才看得到效果 */
    const trashed: string[] = [];
    const trash = jest.fn(async (p: string) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true });
    });
    beforeEach(() => {
      trashed.length = 0;
      trash.mockClear();
    });

    it('claude: trashes the session file and its sibling directory, then drops it from the list', async () => {
      const p = writeClaude('a', 'task a', 2_000_000);
      writeClaude('b', 'task b', 1_000_000);
      const side = path.join(claudeDir(), 'a');
      fs.mkdirSync(path.join(side, 'subagents'), { recursive: true });
      const svc = mk({ trash });
      expect((await svc.list('claude')).items.map((x) => x.sessionId)).toEqual(['a', 'b']);
      const r = await svc.remove('claude', 'a');
      expect(r).toEqual({ ok: true, removed: 2 });
      expect(trashed.sort()).toEqual([p, side].sort());
      expect((await svc.list('claude')).items.map((x) => x.sessionId)).toEqual(['b']);
    });

    it('refuses sessions open in a tab, unknown sessions, and hosts without a trash', async () => {
      writeClaude('a', 'task a', 1_000_000);
      const open = mk({ trash, openKeys: () => new Set(['claude:a']) });
      expect((await open.remove('claude', 'a')).ok).toBe(false);
      expect(trash).not.toHaveBeenCalled();
      expect((await mk({ trash }).remove('claude', 'nope')).ok).toBe(false);
      expect((await mk().remove('claude', 'a')).ok).toBe(false);
      expect(fs.existsSync(path.join(claudeDir(), 'a.jsonl'))).toBe(true);
    });

    it('codex: every rollout of the same session id is trashed, other sessions stay', async () => {
      const id = '01a0a531-1d64-7361-bb69-ebd1c7349662';
      const otherId = '01a0a3b7-aaaa-7361-bb69-ebd1c7349662';
      const base = fx('codex-rollout.jsonl')
        .replace(/"cwd":\s*"\/tmp"/g, `"cwd":${JSON.stringify(work)}`)
        .split('01a13a9b-34b0-7612-ba36-613a55008483')
        .join(id);
      const put = (day: string, sid: string, body: string) => {
        const dir = path.join(home, '.codex', 'sessions', '2026', '10', day);
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, `rollout-2026-10-${day}T09-00-00-${sid}.jsonl`);
        fs.writeFileSync(p, body);
        return p;
      };
      const a = put('13', id, base);
      const b = put('15', id, base);
      const keep = put('14', otherId, base.split(id).join(otherId));
      const svc = mk({ trash });
      const r = await svc.remove('codex', id);
      expect(r.ok).toBe(true);
      expect(trashed.sort()).toEqual([a, b].sort());
      expect(fs.existsSync(keep)).toBe(true);
      expect((await svc.list('codex')).items.map((x) => x.sessionId)).toEqual([otherId]);
    });

    it('grok: trashes the whole session directory', async () => {
      const id = 'grok-session-1';
      const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(work), id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'updates.jsonl'),
        JSON.stringify({
          sessionId: id,
          cwd: work,
          sessionUpdate: 'user_message',
          content: [{ type: 'text', text: 'hi' }],
        }) + '\n',
      );
      const r = await mk({ trash }).remove('grok', id);
      expect(r).toEqual({ ok: true, removed: 1 });
      expect(trashed).toEqual([dir]);
      expect(fs.existsSync(path.dirname(dir))).toBe(true);
    });

    it('dsh: trashes the session directory and its plaintext index entry', async () => {
      const id = 'session-887fa07d-22ae-4013-849f-2b2fafcba3c3';
      if (!dshSetup(id)) return; // 没有 zstd 工具的环境：跳过
      const dir = path.join(home, '.dsh', 'sessions', '--work--', id);
      const idx = path.join(
        home,
        '.dsh',
        'storages',
        'session_projcache',
        'sessions',
        `${id}.json`,
      );
      const r = await mk({ trash }).remove('dsh', id);
      expect(r).toEqual({ ok: true, removed: 2 });
      expect(trashed.sort()).toEqual([dir, idx].sort());
    });

    it('gemini: trashes the chat file and its sub-agent directory', async () => {
      const id = 'aaaaaaaa-1111-2222-3333-444444444444';
      writeGemini('proj', id, 1_000_000);
      const chats = path.join(home, '.gemini', 'tmp', 'proj', 'chats');
      const file = path.join(chats, `session-2026-10-19T00-00-${id.slice(0, 8)}.jsonl`);
      const r = await mk({ trash }).remove('gemini', id);
      expect(r).toEqual({ ok: true, removed: 2 });
      expect(trashed.sort()).toEqual([file, path.join(chats, id)].sort());
    });
  });
});

describe('resume through the tab layer (mock CLIs)', () => {
  const saved = { ...process.env };
  let root: string;
  let work: string;
  beforeEach(() => {
    process.env.NOMI_CLAUDE_BIN = path.join(mockDir, 'mock-claude.mjs');
    process.env.NOMI_CODEX_BIN = path.join(mockDir, 'mock-codex.mjs');
    process.env.NOMI_DSH_BIN = path.join(mockDir, 'mock-dsh.mjs');
    delete process.env.NOMI_USE_MOCK_CLI;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-harness-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-cwd-'));
  });
  // 收掉长驻的 Claude 进程，否则 jest 进程无法退出
  const made: CliHarnessService[] = [];
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
    process.env = { ...saved };
  });
  const mk = () => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
    });
    made.push(h);
    return h;
  };

  it.each([
    ['claude', 'sess-claude-1', '已续接会话 sess-claude-1'],
    ['codex', 'sess-codex-1', '已续接会话 sess-codex-1'],
    ['dsh', 'session-dsh-1', 'resumed'],
  ] as const)(
    '%s: opened history tab resumes the original session with the right cwd',
    async (b, sid, expected) => {
      const h = mk();
      const msgs = [{ id: 'm1', role: 'user' as const, content: 'earlier question', timestamp: 1 }];
      const r = h.openHistorySession({
        backend: b,
        sessionId: sid,
        cwd: work,
        title: 'old chat',
        messages: msgs,
      });
      expect(r.reused).toBe(false);
      expect(r.tab).toMatchObject({ backend: b, cliSessionId: sid, cwd: work, title: 'old chat' });
      expect(h.tabMessages(r.tab.id)[0]!.content).toBe('earlier question');
      expect(h.openSessionKeys().has(`${b}:${sid}`)).toBe(true);
      await h.sendTab(r.tab.id, 'continue please');
      const last = h.tabMessages(r.tab.id).at(-1)!;
      expect(last.role).toBe('assistant');
      expect(last.content).toContain(expected);
      // 同一会话再次打开 → 复用标签，不重复
      const again = h.openHistorySession({
        backend: b,
        sessionId: sid,
        cwd: work,
        title: 'x',
        messages: [],
      });
      expect(again.reused).toBe(true);
      expect(again.tab.id).toBe(r.tab.id);
      expect(h.listTabs().tabs.filter((x) => x.backend === b)).toHaveLength(1);
    },
  );
});
