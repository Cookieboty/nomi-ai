jest.unmock('fs');
jest.unmock('path');
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  Notification: Object.assign(
    jest.fn(() => ({ show: jest.fn() })),
    {
      isSupported: () => false,
    },
  ),
}));

const island = jest.fn();
jest.mock('../../../src/island/IslandService', () => ({
  notifyIsland: (n: unknown) => island(n),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AgentProgressService, sanitizeAgentWatch } from '../../../src/agents/AgentProgressService';
import {
  decideStatus,
  parseAiderAnalytics,
  parseClaudeSession,
  parseClineJob,
  parseCodexSession,
  parseContinueSession,
  parseGeminiSession,
} from '../../../src/agents/parsers';
import { classify, parsePs, parseWinJson } from '../../../src/agents/processes';

describe('parsers', () => {
  it('codex new rollout format + legacy exec json', () => {
    const head =
      '{"timestamp":"2026-10-14T01:00:00Z","type":"session_meta","payload":{"id":"abc","cwd":"/w/nomi"}}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"修复监视器"}}\n';
    const done = parseCodexSession(
      head,
      head +
        '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"好了"}}\n',
    );
    expect(done).toMatchObject({ sessionId: 'abc', cwd: '/w/nomi', title: '修复监视器' });
    expect(done.phase).toBe('turn-done');
    const tool = parseCodexSession(
      head,
      '{"type":"response_item","payload":{"type":"function_call","name":"shell"}}\n' +
        '{"type":"event_msg","payload":{"type":"token_count"}}\n',
    );
    expect(tool.phase).toBe('tool');
    expect(parseCodexSession('', '{"type":"turn.failed","message":"boom"}\n').phase).toBe('error');
    expect(parseCodexSession('', '{"type":"turn.completed"}\n').phase).toBe('turn-done');
  });

  it('claude interactive session: title / end_turn / tool_use', () => {
    const head =
      '{"type":"user","sessionId":"s1","cwd":"/w/nomi","message":{"role":"user","content":"<command-name>/clear</command-name>"}}\n' +
      '{"type":"user","sessionId":"s1","cwd":"/w/nomi","message":{"role":"user","content":"帮我修 bug"}}\n';
    const tool = parseClaudeSession(
      head,
      '{"type":"assistant","sessionId":"s1","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash"}]}}\n',
    );
    expect(tool).toMatchObject({ sessionId: 's1', cwd: '/w/nomi', phase: 'tool', detail: 'Bash' });
    expect(tool.title).toBe('/clear');
    const done = parseClaudeSession(
      '',
      '{"type":"assistant","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"完成"}]}}\n{"type":"system"}\n',
    );
    expect(done.phase).toBe('turn-done');
    expect(parseClaudeSession('', '{"type":"result","result":"ok"}\n').phase).toBe('task-done');
  });

  it('gemini chat json', () => {
    const g = parseGeminiSession(
      JSON.stringify({
        sessionId: 'g1',
        messages: [
          { type: 'user', content: '写测试' },
          { type: 'gemini', content: '好', toolCalls: [] },
        ],
      }),
    );
    expect(g).toMatchObject({ sessionId: 'g1', title: '写测试', phase: 'turn-done' });
  });

  it('decideStatus: stalled only when alive + tool + no writes', () => {
    const base = { stallMs: 300_000 };
    expect(decideStatus({ ...base, phase: 'tool', alive: true, ageMs: 600_000 })).toBe('stalled');
    expect(decideStatus({ ...base, phase: 'tool', alive: false, ageMs: 600_000 })).toBe('idle');
    expect(decideStatus({ ...base, phase: 'working', alive: true, ageMs: 600_000 })).toBe('idle');
    expect(decideStatus({ ...base, phase: 'tool', alive: true, ageMs: 10_000 })).toBe('running');
    expect(decideStatus({ ...base, phase: 'turn-done', alive: true, ageMs: 9e9 })).toBe('waiting');
    expect(decideStatus({ ...base, phase: 'turn-done', alive: false, ageMs: 0 })).toBe('completed');
  });

  it('process classification (ps + windows json)', () => {
    const ps = parsePs(
      [
        '  101 node            node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
        '  102 claude          claude --resume',
        '  103 Claude          /Applications/Claude.app/Contents/MacOS/Claude',
        '  104 codex           /opt/homebrew/bin/codex',
        '  105 vim             vim /home/u/.claude/settings.json',
        '  106 python3         python3 -m aider --model x',
        '  107 grep            grep claude',
      ].join('\n'),
    );
    expect(classify(ps, 1).map((p) => `${p.pid}:${p.kind}`)).toEqual([
      '101:claude',
      '102:claude',
      '104:codex',
      '106:aider',
    ]);
    const win = parseWinJson(
      JSON.stringify([
        { ProcessId: 9, Name: 'claude.exe', CommandLine: 'C:\\Users\\u\\.local\\bin\\claude.exe' },
        { ProcessId: 10, Name: 'explorer.exe', CommandLine: null },
      ]),
    );
    expect(classify(win, 1)).toEqual([{ pid: 9, kind: 'claude' }]);
  });

  it('aider analytics / cline / continue', () => {
    expect(parseAiderAnalytics('{"event":"message_send","time":1}\n')).toEqual({
      status: 'running',
      summary: 'Aider 运行中',
    });
    expect(parseClineJob(JSON.stringify({ status: 'running', command: 'npm test' }))).toEqual({
      status: 'running',
      summary: 'npm test',
    });
    expect(
      parseContinueSession(
        JSON.stringify({ title: 't', history: [{ message: { role: 'assistant' } }] }),
      ),
    ).toEqual({ status: 'completed', summary: 't' });
  });
});

describe('AgentProgressService', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cd-agents-'));
  const say = jest.fn();

  const mk = (opts: { now: number; procs: () => unknown }) => {
    const home = tmp();
    const svc = new AgentProgressService({
      root: tmp(),
      home,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say } as never,
      now: () => opts.now,
      pollMs: 60_000,
      processes: opts.procs as never,
    });
    return { home, svc };
  };
  const write = (file: string, lines: unknown[], mtime: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  };
  const claudeLines = (sid: string, cwd: string, prompt: string, last: unknown) => [
    { type: 'user', sessionId: sid, cwd, message: { role: 'user', content: prompt } },
    last,
  ];
  const toolUse = {
    type: 'assistant',
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] },
  };

  it('many stale Claude files + one live session → exactly one active session', () => {
    const now = Date.parse('2026-10-14T10:00:00Z');
    const { home, svc } = mk({
      now,
      procs: () => [{ pid: 42, kind: 'claude', cwd: '/w/nomi-ai' }],
    });
    const proj = path.join(home, '.claude', 'projects', '-w-nomi-ai');
    // 6 个历史会话：最后一步都是 tool_use（旧实现会把它们全部标成「可能卡住」）
    for (let i = 0; i < 6; i++) {
      write(
        path.join(proj, `old-${i}.jsonl`),
        claudeLines(`old-${i}`, '/w/nomi-ai', `旧任务 ${i}`, toolUse),
        now - (i + 1) * 3_600_000,
      );
    }
    // 另一个项目的旧会话
    write(
      path.join(home, '.claude', 'projects', '-w-other', 'x.jsonl'),
      claudeLines('x', '/w/other', '别的项目', toolUse),
      now - 40 * 60_000,
    );
    // 当前会话 + 它的子代理文件（同一个 session id，必须并成一条）
    write(
      path.join(proj, 'live.jsonl'),
      claudeLines('live', '/w/nomi-ai', '修复编程助手监视', toolUse),
      now - 5_000,
    );
    write(
      path.join(proj, 'live', 'subagents', 'agent-1.jsonl'),
      [
        {
          type: 'user',
          sessionId: 'live',
          isSidechain: true,
          cwd: '/w/nomi-ai',
          message: { role: 'user', content: 'sub' },
        },
        toolUse,
      ],
      now - 1_000,
    );

    svc.tick();
    const sessions = svc.state().sessions;
    const active = sessions.filter((s) => s.status === 'running' || s.status === 'stalled');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      id: 'claude:live',
      status: 'running',
      alive: true,
      project: 'nomi-ai',
      title: '修复编程助手监视',
    });
    expect(sessions.filter((s) => s.status === 'stalled')).toHaveLength(0);
    // 历史会话都超过 30 分钟：不出现在列表里
    expect(sessions.map((s) => s.id)).toEqual(['claude:live']);
  });

  it('stalled only when process alive; ended session → completed then hidden', () => {
    let now = Date.parse('2026-10-14T10:00:00Z');
    let procs: unknown[] = [{ pid: 1, kind: 'claude', cwd: '/w/a' }];
    const home = tmp();
    const svc = new AgentProgressService({
      root: tmp(),
      home,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say } as never,
      now: () => now,
      pollMs: 60_000,
      processes: () => procs as never,
    });
    const file = path.join(home, '.claude', 'projects', '-w-a', 's.jsonl');
    write(file, claudeLines('s', '/w/a', '跑测试', toolUse), now - 10 * 60_000);
    svc.tick();
    expect(svc.state().sessions[0]?.status).toBe('stalled');

    // 写入 end_turn，进程退出 → completed
    write(
      file,
      claudeLines('s', '/w/a', '跑测试', {
        type: 'assistant',
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '测试都过了' }] },
      }),
      now,
    );
    procs = [];
    say.mockClear();
    svc.tick();
    expect(svc.state().sessions[0]).toMatchObject({ status: 'completed', alive: false });

    now += 31 * 60_000;
    svc.tick();
    expect(svc.state().sessions).toHaveLength(0);
  });

  it('codex: no start reminder; remind when running → waiting, dedupe by session id', () => {
    let now = Date.parse('2026-10-14T10:00:00Z');
    const home = tmp();
    const svc = new AgentProgressService({
      root: tmp(),
      home,
      logger: { info: jest.fn(), warn: jest.fn() },
      desktop: { say } as never,
      now: () => now,
      pollMs: 60_000,
      processes: () => [{ pid: 7, kind: 'codex' }],
    });
    expect(svc.detectKinds()).toEqual([]);
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '14');
    const id = '0199e000-aaaa-bbbb-cccc-123456789abc';
    const file = path.join(dir, `rollout-2026-10-14T10-00-00-${id}.jsonl`);
    const meta = { type: 'session_meta', payload: { id, cwd: '/w/nomi' } };
    write(file, [meta, { type: 'event_msg', payload: { type: 'task_started' } }], now);
    say.mockClear();
    svc.tick();
    expect(svc.detectKinds()).toContain('codex');
    expect(svc.state().sessions).toHaveLength(1);
    expect(svc.state().sessions[0]).toMatchObject({ status: 'running', project: 'nomi' });
    // 任务开始不主动提示（气泡 / 灵动岛都不弹），只在面板里被动展示
    expect(say).not.toHaveBeenCalled();
    expect(island).not.toHaveBeenCalled();

    say.mockClear();
    now += 1000;
    write(
      file,
      [meta, { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '好了' } }],
      now,
    );
    svc.tick();
    expect(svc.state().sessions[0]?.status).toBe('waiting');
    expect(say.mock.calls.some((c) => String(c[0]).includes('等你回复'))).toBe(true);

    const s = sanitizeAgentWatch({ enabled: false, tools: { codex: false } });
    expect(s.enabled).toBe(false);
    expect(s.tools.codex).toBe(false);
    expect(s.tools.gemini).toBe(true);
  });
});
