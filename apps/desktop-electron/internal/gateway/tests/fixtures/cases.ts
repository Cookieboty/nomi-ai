/**
 * 协议转换的边界用例：覆盖原两两转换函数与流式转换的各个分支。
 * 迁移到 IR 时用它们和旧实现逐条比对过（字段、取值、长度完全一致；唯一的有意差异是
 * Messages 上游的 refusal 停止原因现在原样透传），快照见 parity.test.ts。
 */

const img = { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' };
export const messagesBodies: unknown[] = [
  { model: 'm', system: 'sys str', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  {
    model: 'm',
    system: [
      { type: 'text', text: 'a' },
      { type: 'text', text: '' },
      { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
    ],
    stream: true,
    temperature: 0.2,
    top_p: 0.9,
    stop_sequences: ['X'],
    tools: [
      {
        name: 't1',
        description: 'd',
        input_schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
      { type: 'web_search_20250305', name: 'web_search' },
      { name: 't2' },
    ],
    tool_choice: { type: 'any', disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: img },
          { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig' },
          { type: 'text', text: 'ok ' },
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'tu1', name: 't1', input: { a: 'x' } },
          { type: 'tool_use', id: 'tu2', name: 't2', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'after' },
          { type: 'tool_result', tool_use_id: 'tu1', content: 'res1' },
          {
            type: 'tool_result',
            tool_use_id: 'tu2',
            is_error: true,
            content: [
              { type: 'text', text: 'boom' },
              { type: 'image', source: img },
            ],
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: [] }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zzz' }] },
      { role: 'assistant', content: '' },
      { role: 'user', content: [{ type: 'text', text: '' }] },
    ],
  },
  {
    model: 'm',
    tools: [{ name: 't', input_schema: {} }],
    tool_choice: { type: 'tool', name: 't' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            is_error: true,
            content: [{ type: 'text', text: 'Error already' }],
          },
        ],
      },
    ],
  },
  {
    model: 'm',
    tools: [{ name: 't', input_schema: {} }],
    tool_choice: { disable_parallel_tool_use: true },
    messages: [],
  },
  {
    model: 'm',
    tools: [{ name: 't', input_schema: {} }],
    tool_choice: { type: 'none' },
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 't' }] }],
  },
];
export const responsesBodies: unknown[] = [
  { model: 'r', input: 'plain', instructions: 'ins' },
  {
    model: 'r',
    stream: true,
    instructions: 'ins',
    max_output_tokens: 50,
    temperature: 1,
    top_p: 0.5,
    parallel_tool_calls: false,
    tools: [
      { type: 'function', name: 'f', description: 'fd', parameters: { type: 'object' } },
      { type: 'custom', name: 'apply_patch', description: 'p' },
      { type: 'web_search' },
      { type: 'function' },
    ],
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev1' }] },
      { role: 'system', content: 'sys2' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'u1' },
          { type: 'input_image', image_url: 'data:image/png;base64,QQ==' },
          { type: 'input_image', image_url: { url: 'https://img' } },
        ],
      },
      {
        type: 'reasoning',
        id: 'rs1',
        summary: [{ type: 'summary_text', text: 'thought' }],
        encrypted_content: 'enc',
      },
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'a1' },
          { type: 'refusal', refusal: 'no' },
        ],
      },
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"x":1}' },
      { type: 'function_call', id: 'fcid', name: 'f', arguments: 'not json' },
      { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** patch' },
      { type: 'function_call_output', call_id: 'c1', output: 'out1' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'between' }] },
      {
        type: 'custom_tool_call_output',
        call_id: 'c2',
        output: [{ type: 'input_text', text: 'o2' }],
      },
      { type: 'function_call_output', call_id: 'c3', output: { a: 1 } },
      { type: 'function_call', call_id: 'c4', name: 'f', arguments: '[1,2]' },
      { type: 'function_call', call_id: 'c5', name: 'f', arguments: '' },
      { type: 'web_search_call', id: 'ws' },
    ],
  },
  {
    model: 'r',
    tools: [{ type: 'custom', name: 'cx' }],
    tool_choice: { type: 'custom', name: 'cx' },
    input: [],
  },
  {
    model: 'r',
    tools: [{ type: 'function', name: 'f' }],
    tool_choice: 'required',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '' }] }],
  },
  { model: 'r', tools: [{ type: 'function', name: 'f' }], tool_choice: 'none', input: [] },
];
export const chatBodies: unknown[] = [
  { model: 'c', messages: [{ role: 'user', content: 'hi' }] },
  {
    model: 'c',
    stream: true,
    max_completion_tokens: 77,
    max_tokens: 5,
    temperature: 0,
    top_p: 1,
    stop: 'END',
    parallel_tool_calls: false,
    tools: [
      {
        type: 'function',
        function: { name: 'f', description: 'd', parameters: { type: 'object' } },
      },
      { type: 'function', function: {} },
    ],
    tool_choice: { type: 'function', function: { name: 'f' } },
    messages: [
      { role: 'system', content: 's1' },
      { role: 'developer', content: [{ type: 'text', text: 's2' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'u' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } },
        ],
      },
      {
        role: 'assistant',
        content: 'calling',
        reasoning_content: 'think',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'f', arguments: '{"q":2}' } },
          { id: 't2', function: { name: 'f', arguments: 'bad' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'r1' },
      { role: 'tool', tool_call_id: 't2', content: [{ type: 'text', text: 'r2' }] },
      { role: 'user', content: 'next' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: [{ type: 'image_url', image_url: 'https://i' }] },
    ],
  },
  {
    model: 'c',
    stop: ['a', 'b'],
    max_tokens: 9,
    tools: [{ type: 'function', function: { name: 'f' } }],
    tool_choice: 'auto',
    messages: [],
  },
  {
    model: 'c',
    stop: [],
    tools: [{ type: 'function', function: { name: 'f' } }],
    tool_choice: 'required',
    messages: [],
  },
];

const sse = (evs: Array<[string | undefined, unknown]>) =>
  evs
    .map(
      ([e, d]) =>
        `${e ? `event: ${e}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`,
    )
    .join('');

export const upstreamSse: Record<string, string[]> = {
  chat: [
    sse([
      [
        undefined,
        {
          id: 'c1',
          model: 'glm',
          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think a' } }],
        },
      ],
      [undefined, { id: 'c1', choices: [{ index: 0, delta: { reasoning_content: 'think b' } }] }],
      [undefined, { id: 'c1', choices: [{ index: 0, delta: { content: 'Hello' } }] }],
      [
        undefined,
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 't0', function: { name: 'f', arguments: '{"a"' } },
                  { index: 1, id: 't1', function: { name: 'g', arguments: '{' } },
                ],
              },
            },
          ],
        },
      ],
      [
        undefined,
        {
          id: 'c1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: ':1}' } },
                  { index: 1, function: { arguments: '}' } },
                ],
              },
            },
          ],
        },
      ],
      [
        undefined,
        {
          id: 'c1',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        },
      ],
      [undefined, '[DONE]'],
    ]),
    sse([
      [undefined, { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] }],
    ]),
    sse([[undefined, { error: { message: 'boom', type: 'rate_limit_error' } }]]),
    '',
  ],
  responses: [
    sse([
      [
        'response.created',
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt', usage: null } },
      ],
      [
        'response.output_item.added',
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_1' },
        },
      ],
      [
        'response.reasoning_summary_text.delta',
        { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
      ],
      [
        'response.output_item.done',
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
        },
      ],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hi' }],
      [
        'response.output_item.added',
        {
          type: 'response.output_item.added',
          output_index: 2,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'apply_patch',
            arguments: '',
          },
        },
      ],
      [
        'response.function_call_arguments.delta',
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          delta: '{"input":"*** p"}',
        },
      ],
      [
        'response.output_item.done',
        {
          type: 'response.output_item.done',
          output_index: 2,
          item: { type: 'function_call', id: 'fc_1' },
        },
      ],
      [
        'response.completed',
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 3,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 1 },
            },
          },
        },
      ],
    ]),
    sse([
      [
        'response.incomplete',
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' } },
        },
      ],
    ]),
    sse([
      [
        'response.failed',
        { type: 'response.failed', response: { error: { code: 'server_error', message: 'bad' } } },
      ],
    ]),
  ],
  gemini: [
    sse([
      [
        undefined,
        {
          responseId: 'g1',
          modelVersion: 'gem',
          candidates: [
            { content: { parts: [{ text: 'secret', thought: true, thoughtSignature: 'S1' }] } },
          ],
        },
      ],
      [
        undefined,
        { candidates: [{ content: { parts: [{ text: 'Answer', thoughtSignature: 'S2' }] } }] },
      ],
      [
        undefined,
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'f', args: { x: 1 } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 9 },
        },
      ],
    ]),
    sse([
      [
        undefined,
        { candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'SAFETY' }] },
      ],
    ]),
    sse([[undefined, { promptFeedback: { blockReason: 'OTHER' } }]]),
  ],
  messages: [
    sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            model: 'claude',
            usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100 },
          },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'SIG' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'redacted_thinking', data: 'R' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      [
        'content_block_start',
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Yo' } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 3,
          content_block: { type: 'tool_use', id: 'tu', name: 'f', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'input_json_delta', partial_json: '{"q":1}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 3 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 9 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]),
    sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]]),
  ],
};

export const upstreamJson: Record<string, unknown[]> = {
  chat: [
    {
      id: 'c',
      model: 'm',
      choices: [
        {
          message: {
            content: 'hi',
            reasoning_content: 'r',
            tool_calls: [{ id: 't', function: { name: 'f', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
    { error: { message: 'x' } },
  ],
  responses: [
    {
      id: 'resp_x',
      model: 'm',
      output: [
        { type: 'reasoning', id: 'r', summary: [{ text: 's' }], encrypted_content: 'E' },
        { type: 'message', content: [{ type: 'output_text', text: 'a' }] },
        {
          type: 'function_call',
          id: 'fc',
          call_id: 'c',
          name: 'apply_patch',
          arguments: '{"input":"p"}',
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ],
  gemini: [
    {
      responseId: 'g',
      candidates: [
        {
          content: {
            parts: [
              { text: 't', thought: true },
              { text: 'a', thoughtSignature: 'S' },
              { functionCall: { name: 'f', args: {} } },
            ],
          },
          finishReason: 'MAX_TOKENS',
        },
      ],
    },
    { promptFeedback: {} },
  ],
  messages: [
    {
      id: 'm',
      model: 'c',
      content: [
        { type: 'thinking', thinking: 't', signature: 's' },
        { type: 'redacted_thinking', data: 'd' },
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: 'u', name: 'f', input: { a: 1 } },
      ],
      stop_reason: 'refusal',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    { type: 'error', error: { type: 'x', message: 'm' } },
  ],
};
