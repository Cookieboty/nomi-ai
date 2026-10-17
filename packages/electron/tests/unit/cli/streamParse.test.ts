import {
  createClaudeParser,
  createDshParser,
  createGrokParser,
  parseClaudeLine,
  parseCodexLine,
  parseDshLine,
  parseGrokLine,
} from '../../../src/cli/streamParse';

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
      { type: 'done', text: '', usage: { inputTokens: 3, outputTokens: 4 } },
    ]);
  });
});
