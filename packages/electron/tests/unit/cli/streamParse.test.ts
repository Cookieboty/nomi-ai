jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import path from 'node:path';

import {
  createClaudeParser,
  createDshParser,
  createGrokParser,
  parseClaudeLine,
  parseCodexLine,
  parseDshLine,
  parseGrokLine,
} from '@nomi-ai/cli-plugins/main';

import '../../../src/cli/pluginI18n';
import type { HarnessEvent } from '../../../src/cli/types';

describe('streamParse', () => {
  it('parses claude text deltas and result', () => {
    const d = parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: { delta: { type: 'text_delta', text: '你好' } },
      }),
    );
    expect(d[0]).toEqual({ type: 'text-delta', text: '你好' });
    const done = parseClaudeLine(
      JSON.stringify({ type: 'result', session_id: 's1', result: '完' }),
    );
    expect(done[0]).toMatchObject({ type: 'done', sessionId: 's1', text: '完' });
  });

  it('claude partial messages: 新文本块前补段落分隔，子代理的流式片段不进主回答，result 后重置', () => {
    const parse = createClaudeParser();
    const se = (event: unknown, parent?: string) =>
      JSON.stringify({
        type: 'stream_event',
        event,
        ...(parent ? { parent_tool_use_id: parent } : {}),
      });
    const block = (type: string) => se({ type: 'content_block_start', content_block: { type } });
    const delta = (text: string, parent?: string) =>
      se({ type: 'content_block_delta', delta: { type: 'text_delta', text } }, parent);
    const lines = [
      block('text'),
      delta('Seg1'),
      block('tool_use'),
      delta('sub', 'toolu_1'),
      block('thinking'),
      block('text'),
      delta('Seg2'),
      JSON.stringify({ type: 'result', result: 'Seg2', session_id: 's' }),
      block('text'),
      delta('Next'),
    ];
    const deltas = lines
      .flatMap((l) => parse(l))
      .filter((e): e is Extract<HarnessEvent, { type: 'text-delta' }> => e.type === 'text-delta')
      .map((e) => e.text);
    expect(deltas).toEqual(['Seg1', '\n\n', 'Seg2', 'Next']);
  });

  it('treats a failed claude result (is_error / error subtype) as an error, not a reply', () => {
    const a = parseClaudeLine(
      JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 429', session_id: 's' }),
    );
    expect(a).toEqual([{ type: 'error', message: 'API Error: 429' }]);
    const b = parseClaudeLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', session_id: 's' }),
    );
    expect(b[0]).toMatchObject({ type: 'error' });
    const ok = parseClaudeLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }),
    );
    expect(ok[0]).toMatchObject({ type: 'done', text: 'ok' });
  });

  it('parses claude control_request can_use_tool as permission', () => {
    const ev = parseClaudeLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'ls -la' },
        },
      }),
    );
    expect(ev[0]).toEqual({ type: 'permission', id: 'req-1', summary: 'Bash: ls -la' });
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'control_request',
          request_id: 'x',
          request: { subtype: 'initialize' },
        }),
      ),
    ).toEqual([]);
  });

  it('parses claude tool_use start and tool_result done/error', () => {
    const start = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    );
    expect(start[0]).toMatchObject({ type: 'tool', name: 'Bash', status: 'start', detail: 'tu1' });
    const done = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }],
        },
      }),
    );
    expect(done[0]).toMatchObject({ type: 'tool', status: 'done', detail: 'tu1' });
    const err = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'fail', is_error: true }],
        },
      }),
    );
    expect(err[0]).toMatchObject({ type: 'tool', status: 'error', detail: 'tu2' });
  });

  it('createClaudeParser pairs tool_result with tool_use name', () => {
    const p = createClaudeParser();
    const j = (o: unknown) => p(JSON.stringify(o));
    j({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'a', name: 'Read' }],
      },
    });
    expect(
      j({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      })[0],
    ).toMatchObject({ name: 'Read', status: 'done' });
  });

  it('parses codex agent_message', () => {
    const ev = parseCodexLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: 'ok', status: 'completed' },
      }),
    );
    expect(ev.some((e) => e.type === 'text' && e.text === 'ok')).toBe(true);
    expect(ev.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('parseDshLine', () => {
  const p = (o: unknown) => parseDshLine(JSON.stringify(o));
  it('maps session, text, final', () => {
    expect(p({ type: 'session', sessionId: 'session-1', cwd: '/w' })).toEqual([
      { type: 'done', text: '', sessionId: 'session-1' },
    ]);
    expect(p({ type: 'text', text: 'hi' })).toEqual([{ type: 'text', text: 'hi' }]);
    expect(p({ type: 'final', text: 'all' })).toEqual([{ type: 'done', text: 'all' }]);
  });
  it('maps tool calls and results', () => {
    expect(p({ type: 'tool_call', callId: 'c1', tool: 'bash', input: {} })).toEqual([
      { type: 'tool', name: 'bash', status: 'start', detail: 'c1' },
    ]);
    expect(p({ type: 'tool_result', callId: 'c1', status: 'error', result: 'x' })[0]).toMatchObject(
      { type: 'tool', status: 'error', detail: 'c1' },
    );
    expect(p({ type: 'tool_result', callId: 'c1', status: 'completed' })[0]).toMatchObject({
      status: 'done',
    });
  });
  it('maps errors and failed turns and thinking; ignores other status', () => {
    expect(p({ type: 'error', message: 'boom' })).toEqual([{ type: 'error', message: 'boom' }]);
    expect(
      p({
        type: 'status',
        phase: 'turn_end',
        reason: { kind: 'error', error: { message: 'rate limited' } },
      }),
    ).toEqual([{ type: 'error', message: 'rate limited' }]);
    expect(p({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })).toEqual([]);
    expect(p({ type: 'thinking', text: 'hmm' })).toEqual([{ type: 'thinking', text: 'hmm' }]);
    expect(parseDshLine('not json')).toEqual([]);
  });
});

describe('createDshParser', () => {
  it('pairs tool_result with the tool_call name', () => {
    const p = createDshParser();
    const j = (o: unknown) => p(JSON.stringify(o));
    j({ type: 'tool_call', callId: 'a', tool: 'bash' });
    j({ type: 'tool_call', callId: 'b', tool: 'edit' });
    expect(j({ type: 'tool_result', callId: 'b', status: 'completed' })[0]).toMatchObject({
      name: 'edit',
      status: 'done',
    });
    expect(j({ type: 'tool_result', callId: 'a', status: 'error' })[0]).toMatchObject({
      name: 'bash',
      status: 'error',
    });
    expect(j({ type: 'tool_result', callId: 'zz', status: 'completed' })[0]).toMatchObject({
      name: 'tool',
    });
  });
});

describe('parseGrokLine', () => {
  const p = (o: unknown) => parseGrokLine(JSON.stringify(o));
  it('maps text, tools, thought, end, error; ignores usage', () => {
    expect(p({ type: 'text', data: 'hi' })).toEqual([{ type: 'text-delta', text: 'hi' }]);
    expect(
      p({
        type: 'tool_call',
        toolCallId: 'c1',
        toolName: 'read_file',
        status: 'in_progress',
      }),
    ).toEqual([{ type: 'tool', name: 'read_file', status: 'start', detail: 'c1' }]);
    expect(p({ type: 'tool_call_update', toolCallId: 'c1', status: 'completed' })[0]).toMatchObject(
      { type: 'tool', status: 'done', detail: 'c1' },
    );
    expect(p({ type: 'end', sessionId: 's1', stopReason: 'end_turn' })).toEqual([
      { type: 'done', text: '', sessionId: 's1' },
    ]);
    expect(p({ type: 'error', message: 'boom' })).toEqual([{ type: 'error', message: 'boom' }]);
    expect(p({ type: 'thought', data: 'hmm' })).toEqual([{ type: 'thinking', text: 'hmm' }]);
    expect(p({ type: 'usage', usage: {} })).toEqual([]);
    expect(parseGrokLine('not json')).toEqual([]);
  });

  it('converts generated image payloads to renderable Markdown data URLs', () => {
    const b64 = 'iVBORw0KGgo=';
    expect(
      p({
        type: 'tool_call',
        toolCallId: 'img-1',
        toolName: 'image_generation',
        status: 'completed',
        rawOutput: { images: [{ b64_json: b64, mime_type: 'image/png' }] },
      }).at(-1),
    ).toEqual({
      type: 'text-delta',
      text: `![Generated image 1](data:image/png;base64,${b64})\n\n`,
    });
    expect(
      p({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }),
    ).toEqual([
      { type: 'text-delta', text: `![Generated image 1](data:image/jpeg;base64,${b64})\n\n` },
    ]);
  });

  it('keeps ordinary text unchanged while accepting image URLs from image tools', () => {
    expect(p({ type: 'text', data: 'https://example.com/readme' })).toEqual([
      { type: 'text-delta', text: 'https://example.com/readme' },
    ]);
    expect(
      p({
        type: 'tool_call_update',
        toolCallId: 'img-2',
        toolName: 'generate_image',
        status: 'completed',
        rawOutput: { image_url: { url: 'https://example.com/generated.png' } },
      }).at(-1),
    ).toEqual({
      type: 'text-delta',
      text: '![Generated image 1](https://example.com/generated.png)\n\n',
    });
  });
});

describe('image blocks from Claude, Codex and dsh', () => {
  const b64 = 'iVBORw0KGgo=';
  it('Claude image content blocks become Markdown data URLs', () => {
    const events = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Here is the image.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          ],
        },
      }),
    );
    expect(events).toContainEqual({ type: 'text', text: 'Here is the image.' });
    expect(events.at(-1)).toEqual({
      type: 'text-delta',
      text: `![Generated image 1](data:image/png;base64,${b64})\n\n`,
    });
  });

  it('Claude tool results preserve image content', () => {
    const events = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
              ],
            },
          ],
        },
      }),
    );
    expect(events.at(-1)).toEqual({
      type: 'text-delta',
      text: `![Generated image 1](data:image/jpeg;base64,${b64})\n\n`,
    });
  });

  it('Codex image_generation_call and dsh structured results become images', () => {
    expect(
      parseCodexLine(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: b64 },
        }),
      ).at(-1),
    ).toEqual({
      type: 'text-delta',
      text: `![Generated image 1](data:image/png;base64,${b64})\n\n`,
    });
    expect(
      parseDshLine(
        JSON.stringify({
          type: 'final',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: b64 } },
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'done',
        text: `![Generated image 1](data:image/webp;base64,${b64})`,
      },
    ]);
  });

  it('keeps images in each backend final event so persistence does not drop them', () => {
    const image = `![Generated image 1](data:image/png;base64,${b64})`;
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'result',
          result: [
            { type: 'text', text: 'Claude' },
            { type: 'image', source: { data: b64 } },
          ],
        }),
      ),
    ).toEqual([{ type: 'done', text: `Claude\n\n${image}` }]);
    expect(
      parseCodexLine(
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            content: [
              { type: 'text', text: 'Codex' },
              { type: 'image', data: b64 },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'Codex' },
      { type: 'done', text: `Codex\n\n${image}` },
    ]);
    expect(
      parseGrokLine(
        JSON.stringify({
          type: 'end',
          text: 'Grok',
          output: { images: [{ b64_json: b64 }] },
        }),
      ),
    ).toEqual([{ type: 'done', text: `Grok\n\n${image}` }]);
  });
});

describe('createGrokParser', () => {
  it('pairs tool_call_update with the tool_call name', () => {
    const p = createGrokParser();
    const j = (o: unknown) => p(JSON.stringify(o));
    j({ type: 'tool_call', toolCallId: 'a', toolName: 'bash', status: 'in_progress' });
    expect(j({ type: 'tool_call_update', toolCallId: 'a', status: 'completed' })[0]).toMatchObject({
      name: 'bash',
      status: 'done',
    });
  });
});

describe('tool trace fields (input / output / thinking / parent)', () => {
  it('claude: tool_use carries input, tool_result carries output, thinking block, sub-agent parent', () => {
    const p = createClaudeParser();
    const j = (o: unknown) => p(JSON.stringify(o));
    const start = j({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先看看目录' },
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/w/a.ts' } },
        ],
      },
    });
    expect(start[0]).toEqual({ type: 'thinking', text: '先看看目录' });
    expect(start[1]).toMatchObject({
      type: 'tool',
      name: 'Read',
      status: 'start',
      detail: 'a',
      input: '{"file_path":"/w/a.ts"}',
    });
    const inner = j({
      type: 'assistant',
      parent_tool_use_id: 'task1',
      message: { content: [{ type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'x' } }] },
    });
    expect(inner[0]).toMatchObject({ parentId: 'task1' });
    const done = j({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          },
        ],
      },
    });
    expect(done[0]).toMatchObject({ name: 'Read', status: 'done', output: 'line1\nline2' });
  });

  it('clips long input strings but keeps the JSON valid', () => {
    const [ev] = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Write', input: { content: 'x'.repeat(10_000) } },
          ],
        },
      }),
    );
    const input = (ev as { input: string }).input;
    expect(() => JSON.parse(input)).not.toThrow();
    expect(input.length).toBeLessThan(2300);
  });

  it('codex: command output / failure, reasoning, file_change', () => {
    const run = (o: unknown) => parseCodexLine(JSON.stringify(o));
    expect(
      run({
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'a\nb',
          exit_code: 2,
          status: 'failed',
        },
      })[0],
    ).toMatchObject({
      name: 'bash',
      status: 'error',
      id: 'i1',
      detail: 'ls',
      output: 'a\nb',
      input: '{"command":"ls"}',
    });
    expect(run({ type: 'item.completed', item: { type: 'reasoning', text: '想一下' } })).toEqual([
      { type: 'thinking', text: '想一下' },
    ]);
    expect(
      run({
        type: 'item.started',
        item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] },
      })[0],
    ).toMatchObject({ name: 'apply_patch', status: 'start', id: 'f1' });
  });

  it('grok / dsh: rawInput, rawOutput and result are mapped', () => {
    const g = createGrokParser();
    const gs = (o: unknown) => g(JSON.stringify(o));
    expect(
      gs({
        type: 'tool_call',
        toolCallId: 'c',
        toolName: 'bash',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      })[0],
    ).toMatchObject({ input: '{"command":"ls"}' });
    expect(
      gs({ type: 'tool_call_update', toolCallId: 'c', status: 'completed', rawOutput: 'ok' })[0],
    ).toMatchObject({ name: 'bash', output: 'ok' });
    expect(
      parseDshLine(
        JSON.stringify({
          type: 'tool_result',
          callId: 'c',
          tool: 'x',
          status: 'error',
          result: 'no',
        }),
      )[0],
    ).toMatchObject({ status: 'error', output: 'no' });
  });
});

describe('usage / status events', () => {
  it('claude: result carries usage, cost and duration; api_retry / compacting become status events', () => {
    const done = parseClaudeLine(
      JSON.stringify({
        type: 'result',
        result: 'ok',
        session_id: 's',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
        total_cost_usd: 0.5,
        duration_ms: 1234,
      }),
    );
    expect(done).toEqual([
      {
        type: 'done',
        text: 'ok',
        sessionId: 's',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 100,
          costUsd: 0.5,
          durationMs: 1234,
        },
      },
    ]);
    // 没有用量时不带 usage 字段
    expect(parseClaudeLine('{"type":"result","result":"x"}')[0]).not.toHaveProperty('usage');
    expect(
      parseClaudeLine('{"type":"system","subtype":"api_retry","attempt":2,"max_retries":5}'),
    ).toEqual([{ type: 'status', kind: 'retry', attempt: 2, max: 5 }]);
    expect(parseClaudeLine('{"type":"system","subtype":"status","status":"compacting"}')).toEqual([
      { type: 'status', kind: 'compact' },
    ]);
    expect(parseClaudeLine('{"type":"system","subtype":"status","status":null}')).toEqual([
      { type: 'status', kind: 'clear' },
    ]);
  });

  it('codex: turn.completed usage; "Reconnecting... 2/5" is a reconnect status, not an error', () => {
    expect(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":8}}',
      ),
    ).toEqual([
      { type: 'done', text: '', usage: { inputTokens: 10, outputTokens: 8, cacheReadTokens: 4 } },
    ]);
    expect(parseCodexLine('{"type":"error","message":"Reconnecting... 2/5"}')).toEqual([
      { type: 'status', kind: 'reconnect', text: 'Reconnecting... 2/5', attempt: 2, max: 5 },
    ]);
    expect(parseCodexLine('{"type":"error","message":"boom"}')).toEqual([
      { type: 'error', message: 'boom' },
    ]);
  });

  it('grok: usage event yields a done event carrying camelCase usage', () => {
    expect(parseGrokLine('{"type":"usage","usage":{"inputTokens":3,"outputTokens":4}}')).toEqual([
      // 每行是一次请求：当前上下文 = 输入 + 缓存读 + 输出；先实时上报，再并入轮末用量
      { type: 'context', tokens: 7 },
      { type: 'done', text: '', usage: { inputTokens: 3, outputTokens: 4, contextTokens: 7 } },
    ]);
  });
});

// 子代理（docs/design/cli-subagents.md §3）：fixture 来自真机录制（路径 / id 已脱敏）
describe('subagent events from real CLI recordings', () => {
  const fixture = (name: string) =>
    fs
      .readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
  const agents = (evs: HarnessEvent[]) =>
    evs.filter((e): e is Extract<HarnessEvent, { type: 'agent' }> => e.type === 'agent');

  it('Claude 2.1.303 task_started / progress / updated / notification → agent start / progress / end', () => {
    const evs = agents(fixture('claude-tasks.jsonl').flatMap((l) => parseClaudeLine(l)));
    expect(evs.map((e) => e.op)).toEqual(['start', 'progress', 'end', 'end']);
    expect(evs[0]).toMatchObject({
      id: 'ae8de0d6bf3fbd2d6',
      callId: 'toolu_01Aa79DxQ2W1zbY5G3aHv4Rk',
      label: 'Read a.txt and report',
      agentType: 'general-purpose',
      background: false,
      status: 'running',
    });
    expect(evs[1]).toMatchObject({ progress: 'Reading a.txt', usage: { toolUses: 1 } });
    expect(evs[3]).toMatchObject({ status: 'completed' });
    expect(evs[3]!.summary).toContain('a.txt');
  });

  it('Claude 后台 Bash 等非子代理任务不出 agent 卡片', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'brn1',
      description: 'sleep',
      task_type: 'local_bash',
      is_backgrounded: false,
    });
    expect(agents(parseClaudeLine(line))).toEqual([]);
  });

  it('Codex 0.163.0 collab_tool_call → spawn / wait / close 工具事件 + 子线程 agent start / end', () => {
    const evs = fixture('codex-collab.jsonl').flatMap((l) => parseCodexLine(l));
    const tools = evs.filter((e) => e.type === 'tool') as Array<
      Extract<HarnessEvent, { type: 'tool' }>
    >;
    expect(tools.map((e) => `${e.name}:${e.status}`)).toEqual([
      'spawn_agent:start',
      'spawn_agent:done',
      'wait_agent:start',
      'wait_agent:done',
      'close_agent:start',
      'close_agent:done',
    ]);
    expect(tools[0]!.input).toContain('a.txt');
    expect(tools[3]!.output).toBe('hello');
    const ag = agents(evs);
    expect(ag[0]).toMatchObject({
      op: 'start',
      callId: 'item_3',
      background: true,
      status: 'running',
    });
    expect(ag[0]!.label).toMatch(/^Read the file `a.txt`/);
    const ends = ag.filter((e) => e.op === 'end');
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.every((e) => e.id === ag[0]!.id && e.status === 'completed')).toBe(true);
    expect(ends[0]!.summary).toBe('hello');
  });

  it('dsh subagent / subagent_fork 工具 → agent start / end（无内部步骤，结果作摘要）', () => {
    const p = createDshParser();
    const start = p(
      JSON.stringify({
        type: 'tool_call',
        callId: 'c1',
        tool: 'subagent',
        input: { prompt: 'Audit the auth module\nthen report', run_in_background: true },
      }),
    );
    expect(agents(start)).toEqual([
      expect.objectContaining({
        op: 'start',
        id: 'c1',
        label: 'Audit the auth module',
        background: true,
      }),
    ]);
    const end = p(
      JSON.stringify({
        type: 'tool_result',
        callId: 'c1',
        status: 'completed',
        result: 'all good',
      }),
    );
    expect(agents(end)).toEqual([
      expect.objectContaining({ op: 'end', id: 'c1', status: 'completed', summary: 'all good' }),
    ]);
    // 普通工具不出 agent 事件
    expect(
      agents(p(JSON.stringify({ type: 'tool_call', callId: 'c2', tool: 'read_file', input: {} }))),
    ).toEqual([]);
  });
});

describe('Claude context usage (2.1.309 实测口径)', () => {
  // result.usage 是整轮累计：cache_read 36548 = 11334 + 25214；iterations 是逐请求明细
  const assistant = (usage: Record<string, number>, parent?: string) =>
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: parent ?? null,
      message: { content: [{ type: 'text', text: 'x' }], usage },
    });
  const result = (iterations?: Record<string, number>[]) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'OK',
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 14201,
        cache_read_input_tokens: 36548,
        output_tokens: 226,
        ...(iterations ? { iterations } : {}),
      },
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 4,
          cacheReadInputTokens: 36548,
          cacheCreationInputTokens: 14201,
          contextWindow: 1000000,
        },
        'claude-tiny': { inputTokens: 1, contextWindow: 200000 },
      },
    });
  const last = {
    input_tokens: 2,
    cache_read_input_tokens: 25214,
    cache_creation_input_tokens: 321,
    output_tokens: 4,
  };

  it('takes the last iteration as the current context and the main model window', () => {
    const done = parseClaudeLine(result([{ input_tokens: 2, output_tokens: 8 }, last]))[0];
    expect(done).toMatchObject({
      type: 'done',
      usage: {
        // 计费口径仍是整轮累计
        inputTokens: 4,
        cacheReadTokens: 36548,
        outputTokens: 226,
        contextTokens: 2 + 25214 + 321 + 4,
        contextWindow: 1000000,
        // 主模型 = 输入最多的那个
        model: 'claude-haiku-5-5',
      },
    });
  });

  it('falls back to the last main-thread assistant usage when iterations are missing', () => {
    const parse = createClaudeParser();
    parse(assistant({ input_tokens: 2, cache_read_input_tokens: 11334, output_tokens: 8 }));
    parse(assistant(last));
    // 子代理的请求不算
    parse(assistant({ input_tokens: 9, cache_read_input_tokens: 999999 }, 'toolu_1'));
    const done = parse(result()).find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.usage?.contextTokens).toBe(2 + 25214 + 321 + 4);
  });
  it('reports the live context per main-thread request (once per value) and after compaction', () => {
    const parse = createClaudeParser();
    const ctx = (line: string) => parse(line).filter((e) => e.type === 'context');
    const withModel = (usage: Record<string, number>) =>
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage },
      });
    expect(ctx(withModel(last))).toEqual([
      { type: 'context', tokens: 2 + 25214 + 321 + 4, model: 'claude-opus-5-5' },
    ]);
    // 同一次请求的下一个内容块：同一份 usage 不重复上报
    expect(ctx(withModel(last))).toEqual([]);
    // 子代理不算
    expect(ctx(assistant({ input_tokens: 9, cache_read_input_tokens: 999999 }, 'toolu_1'))).toEqual(
      [],
    );
    // 自动压缩：372K → 16K
    expect(
      ctx(
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 372759, post_tokens: 15996 },
        }),
      ),
    ).toEqual([{ type: 'context', tokens: 15996 }]);
    // 没给压缩后大小：上报 null，丢弃旧值
    expect(
      ctx(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: {} })),
    ).toEqual([{ type: 'context', tokens: null }]);
  });
});
