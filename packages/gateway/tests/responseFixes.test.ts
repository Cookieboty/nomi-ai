/**
 * 响应方向针对上游毛病的修正（§11.3）与工具名映射（§12.7.3）：单元测试。
 */
import { describe, expect, it } from 'vitest';

import { customToolsToFunctions, isCustomToolRefusal } from '../src/customTools';
import { Learner, type LearnEvent } from '../src/learn';
import { CallIds, fixEvents } from '../src/models/rules/response';
import { RepetitionGuard } from '../src/models/rules/response/repetition';
import { TextToolExtractor } from '../src/models/rules/response/textTools';
import { createStreamConverter, jsonToJson, SseParser } from '../src/stream';
import { ChatStreamPatcher, patchChatJson } from '../src/stream/chatPatch';
import { createPassthrough } from '../src/stream/passthrough';
import {
  chatToolName,
  chatToolNameReverse,
  ingressToolNames,
  mapChatToolNames,
} from '../src/toolNames';

const data = (d: unknown) => `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra = {}) =>
  data({ id: 'c1', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });

function parse(raw: string) {
  const p = new SseParser();
  return [...p.push(raw), ...p.end()].map((e) => ({
    event: e.event,
    data: e.data === '[DONE]' ? '[DONE]' : (JSON.parse(e.data) as any),
  }));
}

const resolveIn = (names: string[]) => (n: string) => (names.includes(n) ? n : null);

describe('Chat stream fixes (same-wire passthrough)', () => {
  it('untouched events stay byte-identical', () => {
    const text = chunk({ content: 'Hello' }) + chunk({}, 'stop') + data('[DONE]');
    const p = new ChatStreamPatcher({ chatStream: true, repetition: true });
    let out = '';
    for (let i = 0; i < text.length; i += 5) out += p.push(text.slice(i, i + 5));
    expect(out + p.end()).toBe(text);
  });

  it('drops empty reasoning, fixes finish_reason "", duplicate names and empty tool_calls', () => {
    const notes: string[] = [];
    const p = new ChatStreamPatcher({ chatStream: true, notes });
    const out = parse(
      p.push(
        chunk({ reasoning_content: '' }) +
          chunk({ content: 'a', reasoning_content: '' }, '') +
          chunk({ tool_calls: [] }) +
          chunk({ tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '' } }] }) +
          chunk({ tool_calls: [{ index: 0, function: { name: '', arguments: '{"a"' } }] }) +
          chunk({ tool_calls: [{ index: 0, function: { name: 'f', arguments: ':1}' } }] }) +
          chunk({}, 'tool_calls'),
      ) + p.end(),
    );
    // 第一块只剩空 delta：整个去掉；第三块（空 tool_calls）同样
    expect(out).toHaveLength(5);
    expect(out[0]!.data.choices[0]).toEqual({
      index: 0,
      delta: { content: 'a' },
      finish_reason: null,
    });
    expect(out[2]!.data.choices[0].delta.tool_calls[0].function).toEqual({ arguments: '{"a"' });
    expect(out[3]!.data.choices[0].delta.tool_calls[0].function).toEqual({ arguments: ':1}' });
    expect(notes.length).toBe(1);
  });

  it('can be switched off', () => {
    const text = chunk({ reasoning_content: '' }, '');
    const p = new ChatStreamPatcher({ chatStream: false });
    expect(p.push(text) + p.end()).toBe(text);
  });

  it('the decoder treats finish_reason "" as not finished', () => {
    const c = createStreamConverter('chat', 'messages');
    const out = parse(
      c.push(chunk({ content: 'x' }, '') + chunk({}, 'length') + data('[DONE]')) + c.end(),
    );
    expect(out.find((e) => e.event === 'message_delta')?.data.delta.stop_reason).toBe('max_tokens');
  });
});

describe('text tool calls', () => {
  it('ids of calls recovered from text are deterministic per seed (§6.9.7)', () => {
    const text = 'x<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>';
    const evs = [
      { type: 'start' as const },
      { type: 'text' as const, text },
      { type: 'finish' as const, reason: 'end_turn' as const },
    ];
    const ids = (seed: string) =>
      fixEvents(evs, { textTools: new Set(['read_file']), callIds: new CallIds(seed) })
        .filter((e) => e.type === 'tool_start')
        .map((e) => (e as { id: string }).id);
    expect(ids('s1')).toEqual(['call_s1_0']);
    expect(ids('s1')).toEqual(ids('s1'));
    // Chat 透传（chatPatch）用同一套 id
    const p = new ChatStreamPatcher({
      textTools: new Set(['read_file']),
      callIds: new CallIds('s2'),
    });
    const out =
      p.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      ) + p.end();
    expect(out).toContain('"id":"call_s2_0"');
  });

  it('<tool_call> JSON, held across chunk boundaries', () => {
    const ex = new TextToolExtractor(resolveIn(['read_file']));
    let shown = '';
    const s = 'Let me look.<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>';
    for (let i = 0; i < s.length; i += 3) shown += ex.push(s.slice(i, i + 3));
    expect(shown).toBe('Let me look.');
    expect(ex.flush()).toEqual({
      text: '',
      calls: [{ name: 'read_file', args: '{"path":"a.ts"}' }],
    });
  });

  it('a held "<" that is not a marker comes back', () => {
    const ex = new TextToolExtractor(resolveIn(['x']));
    expect(ex.push('a <')).toBe('a ');
    expect(ex.push('b> c')).toBe('<b> c');
    expect(ex.flush()).toEqual({ text: '', calls: [] });
  });

  it('GLM arg_key / arg_value, with and without <tool_call>', () => {
    const ex = new TextToolExtractor(resolveIn(['bash']));
    ex.push(
      '<tool_call>bash\n<arg_key>command</arg_key>\n<arg_value>ls -la</arg_value>\n<arg_key>timeout</arg_key><arg_value>5</arg_value></tool_call>',
    );
    expect(ex.flush().calls).toEqual([{ name: 'bash', args: '{"command":"ls -la","timeout":5}' }]);
    const bare = new TextToolExtractor(resolveIn(['bash']));
    expect(bare.push('ok\nbash<arg_key>command</arg_key><arg_value>pwd</arg_value>')).toBe('ok\n');
    expect(bare.flush()).toEqual({
      text: '',
      calls: [{ name: 'bash', args: '{"command":"pwd"}' }],
    });
  });

  it('DeepSeek DSML invokes inside function_calls', () => {
    const ex = new TextToolExtractor(resolveIn(['get_weather']));
    ex.push(
      '好的\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="get_weather">\n<｜DSML｜parameter name="city" string="true">杭州</｜DSML｜parameter>\n<｜DSML｜parameter name="days" string="false">3</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>',
    );
    expect(ex.flush()).toEqual({
      text: '',
      calls: [{ name: 'get_weather', args: '{"city":"杭州","days":3}' }],
    });
  });

  it('unknown tools and bad JSON are flushed as text', () => {
    const ex = new TextToolExtractor(resolveIn(['a']));
    const s = '<tool_call>{"name":"b","arguments":{}}</tool_call><tool_call>{bad</tool_call>';
    ex.push(s);
    expect(ex.flush()).toEqual({ text: s, calls: [] });
  });

  it('same-wire Chat: tool_calls chunks before the finish chunk, finish becomes tool_calls', () => {
    const notes: string[] = [];
    const p = new ChatStreamPatcher({ textTools: new Set(['read_file']), notes });
    const out = parse(
      p.push(
        chunk({ role: 'assistant', content: 'Sure. <tool' }) +
          chunk({ content: '_call>{"name":"read_file","arguments":{"path":"x"}}' }) +
          chunk({ content: '</tool_call>' }) +
          chunk({}, 'stop') +
          data('[DONE]'),
      ) + p.end(),
    );
    expect(out[0]!.data.choices[0].delta).toEqual({ role: 'assistant', content: 'Sure. ' });
    const call = out.find((e) => e.data.choices?.[0]?.delta?.tool_calls)!;
    expect(call.data.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"x"}' },
    });
    expect(out.at(-2)!.data.choices[0].finish_reason).toBe('tool_calls');
    expect(out.at(-1)!.data).toBe('[DONE]');
    expect(notes).toContain('正文里写出的工具调用已转成工具调用');
  });

  it('converted path: Chat → Messages gets a real tool_use block', () => {
    const c = createStreamConverter('chat', 'messages', {
      fixes: { textTools: new Set(['bash']) },
    });
    const out = parse(
      c.push(
        chunk({ content: 'Run:<tool_call>{"name":"bash","arguments":{"command":"ls"}}' }) +
          chunk({ content: '</tool_call>' }) +
          chunk({}, 'stop') +
          data('[DONE]'),
      ) + c.end(),
    );
    const starts = out.filter((e) => e.event === 'content_block_start');
    expect(starts.map((e) => e.data.content_block.type)).toEqual(['text', 'tool_use']);
    expect(starts[1]!.data.content_block.name).toBe('bash');
    const delta = out.find((e) => e.data.delta?.type === 'input_json_delta');
    expect(delta?.data.delta.partial_json).toBe('{"command":"ls"}');
    expect(out.find((e) => e.event === 'message_delta')?.data.delta.stop_reason).toBe('tool_use');
  });

  it('non-streaming: same-wire Chat JSON and converted JSON', () => {
    const body = {
      id: 'x',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
          },
          finish_reason: 'stop',
        },
      ],
    };
    const fixed = patchChatJson(body, { textTools: new Set(['bash']) }) as any;
    expect(fixed.choices[0].message.content).toBe('ok');
    expect(fixed.choices[0].message.tool_calls[0].function).toEqual({
      name: 'bash',
      arguments: '{"command":"ls"}',
    });
    expect(fixed.choices[0].finish_reason).toBe('tool_calls');
    const r = jsonToJson('chat', 'messages', body, { fixes: { textTools: new Set(['bash']) } });
    expect((r.body as any).content.map((b: any) => b.type)).toEqual(['text', 'tool_use']);
    expect((r.body as any).stop_reason).toBe('tool_use');
  });
});

describe('repetition detection', () => {
  const loop = '我需要再检查一下这个文件。'.repeat(45);

  it('trips on ≤3 distinct sentences among the last 40; separate channels', () => {
    const g = new RepetitionGuard();
    expect(g.push('think', 'A different sentence here. '.repeat(10))).toBe(false);
    expect(g.push('text', loop)).toBe(true);
    const ok = new RepetitionGuard();
    const varied = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is unique.`).join(
      ' ',
    );
    expect(ok.push('text', varied)).toBe(false);
    // 短行（如代码里的 `}`）不计
    expect(ok.push('text', '}\n'.repeat(100))).toBe(false);
  });

  it('converted stream ends with the ingress error event and reports stopped', () => {
    const notes: string[] = [];
    const c = createStreamConverter('chat', 'messages', { fixes: { repetition: true, notes } });
    let out = '';
    for (const ch of loop.match(/.{1,20}/gs)!) out += c.push(chunk({ content: ch }));
    expect(c.stopped).toBe(true);
    const evs = parse(out);
    expect(evs.at(-1)).toMatchObject({ event: 'error', data: { type: 'error' } });
    expect(notes).toContain('检测到模型复读，已中断');
  });

  it('same-wire Chat: data {"error"} then [DONE]', () => {
    const p = createPassthrough('chat', { repetition: true })!;
    let out = '';
    for (const ch of loop.match(/.{1,20}/gs)!) out += p.push(chunk({ content: ch }));
    expect(p.stopped).toBe(true);
    const evs = parse(out);
    expect(evs.at(-2)!.data.error.message).toMatch(/重复输出/);
    expect(evs.at(-1)!.data).toBe('[DONE]');
  });

  it('same-wire Responses / Messages: protocol error event, earlier events untouched', () => {
    const resp = createPassthrough('responses', { repetition: true })!;
    let out = '';
    for (const ch of loop.match(/.{1,20}/gs)!)
      out += resp.push(
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: ch })}\n\n`,
      );
    expect(resp.stopped).toBe(true);
    expect(parse(out).at(-1)!.event).toBe('response.failed');
    const msg = createPassthrough('messages', { repetition: true })!;
    out = '';
    for (const ch of loop.match(/.{1,20}/gs)!)
      out += msg.push(
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ch } })}\n\n`,
      );
    expect(msg.stopped).toBe(true);
    expect(parse(out).at(-1)!.event).toBe('error');
    expect(createPassthrough('gemini', { repetition: false })).toBeNull();
  });
});

describe('custom tool refused', () => {
  const sent = { tools: [{ type: 'custom', name: 'apply_patch' }] };

  it('recognizes the refusal only for 400s mentioning custom tools', () => {
    expect(isCustomToolRefusal(400, '{"error":{"message":"Unsupported custom tool"}}', sent)).toBe(
      true,
    );
    expect(
      isCustomToolRefusal(400, "Invalid value: 'custom'. Supported values are: 'function'.", sent),
    ).toBe(true);
    expect(isCustomToolRefusal(400, 'tool type custom is not supported', sent)).toBe(true);
    expect(isCustomToolRefusal(500, 'Unsupported custom tool', sent)).toBe(false);
    expect(isCustomToolRefusal(400, 'Unsupported custom tool', { tools: [] })).toBe(false);
    expect(isCustomToolRefusal(400, 'max_tokens is too large', sent)).toBe(false);
  });

  it('reports custom-tools-refused per model', () => {
    const got: LearnEvent[] = [];
    new Learner((e) => got.push(e)).customToolsRefused({
      provider: { id: 'zp' },
      publicModel: 'zp/glm-5',
      wire: 'responses',
    } as never);
    expect(got).toEqual([{ type: 'custom-tools-refused', providerId: 'zp', model: 'glm-5' }]);
  });

  it('turns custom tools, history and tool_choice into functions', () => {
    const body = {
      tools: [
        { type: 'custom', name: 'apply_patch', description: 'd', format: { type: 'grammar' } },
        { type: 'function', name: 'shell', parameters: {} },
      ],
      tool_choice: { type: 'custom', name: 'apply_patch' },
      input: [
        { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: 'PATCH' },
        { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' },
      ],
    };
    const out = customToolsToFunctions(body) as any;
    expect(out.tools[0]).toEqual({
      type: 'function',
      name: 'apply_patch',
      description: 'd',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
    });
    expect(out.tools[1]).toBe(body.tools[1]);
    expect(out.tool_choice).toEqual({ type: 'function', name: 'apply_patch' });
    expect(out.input[0]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: 'apply_patch',
      arguments: '{"input":"PATCH"}',
    });
    expect(out.input[1].type).toBe('function_call_output');
    expect(body.tools[0]!.type).toBe('custom');
    expect(customToolsToFunctions({ tools: [] })).toEqual({ tools: [] });
  });
});

describe('tool-name mapping for Chat upstreams', () => {
  it('legal names stay; illegal ones get deterministic legal names', () => {
    expect(chatToolName('read_file')).toBe('read_file');
    const ns = chatToolName('functions.shell');
    expect(ns).toMatch(/^functions_shell_[0-9a-f]{7}$/);
    expect(chatToolName('functions.shell')).toBe(ns);
    const long = chatToolName(`mcp__${'x'.repeat(80)}`);
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(long).toHaveLength(64);
    expect(chatToolName('a.b')).not.toBe(chatToolName('a/b'));
  });

  it('maps tools, tool_choice, history tool calls and tool messages', () => {
    const notes: string[] = [];
    const tools = [
      { type: 'function', function: { name: 'ns.read', parameters: {} } },
      { type: 'function', function: { name: 'ok', parameters: {} } },
    ];
    const o: Record<string, unknown> = {
      tools,
      tool_choice: { type: 'function', function: { name: 'ns.read' } },
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 't', type: 'function', function: { name: 'ns.read', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 't', name: 'ns.read', content: 'r' },
      ],
    };
    const before = JSON.stringify(o);
    mapChatToolNames(o, notes);
    const m = chatToolName('ns.read');
    expect((o.tools as any)[0].function.name).toBe(m);
    expect((o.tools as any)[1]).toBe(tools[1]);
    expect((o.tool_choice as any).function.name).toBe(m);
    expect((o.messages as any)[1].tool_calls[0].function.name).toBe(m);
    expect((o.messages as any)[2].name).toBe(m);
    expect(JSON.stringify(tools)).toBe(JSON.stringify(JSON.parse(before).tools));
    expect(notes).toEqual(['1 个工具名已映射为 Chat 接口允许的名字']);
  });

  it('restores names in the stream (same-wire and converted) and in JSON', () => {
    const names = ingressToolNames('responses', {
      tools: [
        { type: 'function', name: 'ns.read' },
        { type: 'custom', name: 'apply_patch' },
      ],
    });
    expect(names).toEqual(['ns.read', 'apply_patch']);
    const rev = chatToolNameReverse(names)!;
    const m = chatToolName('ns.read');
    expect(rev.get(m)).toBe('ns.read');
    const up =
      chunk({ tool_calls: [{ index: 0, id: 't1', function: { name: m, arguments: '{}' } }] }) +
      chunk({}, 'tool_calls') +
      data('[DONE]');
    const p = new ChatStreamPatcher({ toolNames: rev });
    expect(parse(p.push(up))[0]!.data.choices[0].delta.tool_calls[0].function.name).toBe('ns.read');
    const c = createStreamConverter('chat', 'responses', { fixes: { toolNames: rev } });
    const added = parse(c.push(up) + c.end()).find((e) => e.event === 'response.output_item.added');
    expect(added?.data.item.name).toBe('ns.read');
    const json = {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', tool_calls: [{ id: 't', function: { name: m } }] },
        },
      ],
    };
    expect(
      (patchChatJson(json, { toolNames: rev }) as any).choices[0].message.tool_calls[0],
    ).toEqual({ id: 't', function: { name: 'ns.read' } });
    expect(chatToolNameReverse(['a', 'b'])).toBeNull();
  });
});
