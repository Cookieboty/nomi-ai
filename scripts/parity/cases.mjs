/**
 * Extra parity inputs on top of apps/desktop-electron/internal/gateway/tests/fixtures/cases.ts:
 * Gemini request bodies (cases.ts has none) and serialisation edge cases that
 * matter for Go (key order, JS number formatting, string escaping, call-id
 * escaping, the Agent-tool rewrite).
 */
const agentTool = {
  name: 'Agent',
  description:
    'Launch a subagent.\nUse isolation: "worktree" to run in a worktree.\r\nRemote runs too.\nKeep it short.',
  input_schema: {
    type: 'object',
    properties: { prompt: { type: 'string' }, isolation: { enum: ['worktree', 'remote'] } },
    required: ['prompt', 'isolation'],
    additionalProperties: false,
  },
};

const weird = 'tab\t nl\n quote" back\\ ctl\u0001 ls\u2028 ps\u2029 <html>&amp; 中文 🎉';

export const requestCases = {
  messages: [
    {
      model: 'claude-x',
      max_tokens: 1e21,
      temperature: 1e-7,
      top_p: 0.30000000000000004,
      system: [{ type: 'text', text: weird }],
      tools: [
        agentTool,
        { name: 'Bash', description: 'remote shell', input_schema: { type: 'object' } },
      ],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [
        { role: 'user', content: weird },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01/with.dots+plus',
              name: 'Agent',
              input: { prompt: 'p', n: -0, big: 123456789012345680000, small: 0.000001 },
            },
            { type: 'tool_use', id: 'x'.repeat(60), name: 'Bash', input: 'not-an-object' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_01/with.dots+plus',
              content: [{ type: 'text', text: 'done' }],
              is_error: true,
            },
            { type: 'tool_result', tool_use_id: 'x'.repeat(60), content: 'ERROR already' },
          ],
        },
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      stream: true,
    },
    {
      model: 'm',
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
        },
      ],
      tools: [{ type: 'custom', name: 'c', input_schema: null }],
    },
    { messages: 'not-an-array', system: 42 },
  ],
  responses: [
    {
      model: 'gpt-x',
      instructions: 'be brief',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'dev note' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:;base64,QUJD' },
            { type: 'input_image', image_url: { url: 'data:image/webp;foo=bar;base64,Zm9v' } },
          ],
        },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 's1' }, { text: '' }],
          encrypted_content: 'enc',
        },
        {
          type: 'custom_tool_call',
          call_id: 'nomi_' + Buffer.from('a b').toString('base64url'),
          name: 'apply_patch',
          input: '*** Begin Patch',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'nomi_YSBi',
          output: [{ type: 'output_text', text: 'ok' }],
        },
        { type: 'function_call', id: 'fc_9', name: 'f', arguments: '[1,2]' },
        { type: 'function_call_output', call_id: 'fc_9', output: { weird: true } },
        { type: 'web_search_call', id: 'ws' },
      ],
      tools: [
        agentTool && {
          type: 'function',
          name: 'Agent',
          description: agentTool.description,
          parameters: agentTool.input_schema,
        },
        { type: 'custom', name: 'apply_patch', description: 'patch' },
      ],
      tool_choice: { type: 'custom', name: 'apply_patch' },
      parallel_tool_calls: false,
      reasoning: { effort: 'none' },
      max_output_tokens: 300,
    },
    { input: 'plain string', reasoning: { effort: 'high' }, stream: 1 },
  ],
  chat: [
    {
      model: 'gpt-c',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'S1' },
            { type: 'image_url', image_url: { url: 'https://x/i.png' } },
          ],
        },
        { role: 'developer', content: 'S2' },
        { role: 'user', content: 'u1' },
        { role: 'user', content: [{ type: 'image_url', image_url: 'data:image/gif;base64,R0lG' }] },
        {
          role: 'assistant',
          reasoning_content: 'think',
          content: null,
          tool_calls: [
            {
              id: 'call_' + 'y'.repeat(50),
              type: 'function',
              function: { name: 'g', arguments: '{"a":1e-7,"b":1E21,"c":"\\u00e9"}' },
            },
            { id: 'c2', function: { name: 'h', arguments: 'oops{' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_' + 'y'.repeat(50), content: '' },
        { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'r2' }] },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'g', parameters: { type: 'object', properties: {} } },
        },
        { type: 'function', function: { name: 'h', description: '' } },
      ],
      tool_choice: 'required',
      stop: 'END',
      max_tokens: 64,
      reasoning_effort: 'low',
      temperature: 0,
    },
    {
      messages: [{ role: 'assistant', reasoning: 'r only' }],
      stop: [],
      parallel_tool_calls: false,
      tool_choice: { type: 'function', function: { name: 'z' } },
    },
  ],
  gemini: [
    {
      systemInstruction: { parts: [{ text: 'sys a' }, { text: '' }, { text: 'sys b' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'hello' },
            { inlineData: { mimeType: 'image/png', data: 'iVBO' } },
            { inlineData: { mimeType: 'application/pdf', data: 'JVBE' } },
            { fileData: { fileUri: 'gs://b/f', mimeType: 'video/mp4' } },
            { fileData: { fileUri: 'gs://b/g' } },
          ],
        },
        {
          role: 'model',
          parts: [
            { text: 'plan', thought: true, thoughtSignature: 'ts1' },
            { text: 'answer', thoughtSignature: 'ts2' },
            { functionCall: { name: 'read', args: { path: '/a' } }, thoughtSignature: 'ts3' },
            { functionCall: { name: 'read', args: { path: '/b' } } },
            { functionCall: { id: 'given', name: 'write' } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'read', response: { content: 'A' } } },
            { functionResponse: { name: 'read', response: { result: null } } },
            { functionResponse: { id: 'given', name: 'write', response: { error: { code: 1 } } } },
            { functionResponse: { name: 'nobody', response: {} } },
            { text: 'continue' },
          ],
        },
        { role: 'user', parts: [{ text: 'again' }] },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read',
              description: 'Read',
              parametersJsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
            },
            { name: 'write', parameters: { type: 'OBJECT' } },
            { name: '' },
          ],
        },
        { googleSearch: {} },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } },
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.7,
        topP: 0.95,
        stopSequences: ['##'],
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
    {
      contents: [{ parts: [{ text: 'hi' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
    },
    {
      contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
      toolConfig: { functionCallingConfig: { mode: 'NONE' } },
      tools: [{ functionDeclarations: [{ name: 'x' }] }],
    },
  ],
};

/* Extra upstream SSE edge cases (decoder corners the shared fixtures skip). */
const sse = (evs) =>
  evs
    .map(
      ([e, d]) =>
        (e ? `event: ${e}\n` : '') + `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`,
    )
    .join('');
export const extraSse = {
  chat: [
    // error object mid-stream
    sse([
      [null, { id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'hi' } }] }],
      [null, { error: { message: 'boom', type: 'rate_limit_error' } }],
    ]),
    // reused tool index with a new id, reasoning, usage chunk, no [DONE]
    sse([
      [
        null,
        {
          id: 'c2',
          model: 'm',
          choices: [{ index: 0, delta: { reasoning_content: '想一想 🤔' } }],
        },
      ],
      [
        null,
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":' } }],
              },
            },
          ],
        },
      ],
      [
        null,
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } },
          ],
        },
      ],
      [
        null,
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'b', function: { name: 'g', arguments: '{}' } }],
              },
            },
          ],
        },
      ],
      [
        null,
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        },
      ],
    ]),
    // empty stream
    '',
    // garbage then length
    sse([
      [null, 'not json'],
      [
        null,
        { id: 'c3', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] },
      ],
      [null, '[DONE]'],
    ]),
    // tool calls without a name: index 1 never gets one (dropped), index 2 gets it after its args
    sse([
      [null, { id: 'c4', model: 'm', choices: [{ index: 0, delta: { content: 'go' } }] }],
      [
        null,
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'a', type: 'function', function: { name: 'f', arguments: '' } },
                  { index: 1, function: { arguments: '{"lost":' } },
                  { index: 2, function: { arguments: '{"y":' } },
                ],
              },
            },
          ],
        },
      ],
      [
        null,
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{}' } },
                  { index: 1, function: { arguments: '1}' } },
                  { index: 2, id: 'c', type: 'function', function: { name: 'h', arguments: '2}' } },
                ],
              },
            },
          ],
        },
      ],
      [null, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
      [null, '[DONE]'],
    ]),
    // the only tool call never gets a name: dropped, finish becomes end_turn
    sse([
      [null, { id: 'c5', model: 'm', choices: [{ index: 0, delta: { role: 'assistant' } }] }],
      [
        null,
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } },
          ],
        },
      ],
      [null, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
      [null, '[DONE]'],
    ]),
  ],
  responses: [
    sse([
      ['response.created', { type: 'response.created', response: { id: 'resp_1', model: 'm' } }],
      [
        'response.failed',
        { type: 'response.failed', response: { error: { code: 'server_error', message: 'bad' } } },
      ],
    ]),
    sse([
      ['response.created', { type: 'response.created', response: { id: 'resp_2', model: 'm' } }],
      [
        'response.output_item.added',
        {
          type: 'response.output_item.added',
          output_index: 0,
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
        'response.function_call_arguments.done',
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_1',
          output_index: 0,
          arguments: '{"input":"*** Begin"}',
        },
      ],
      [
        'response.output_item.done',
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_1' },
        },
      ],
      [
        'response.incomplete',
        {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        },
      ],
    ]),
    sse([['error', { type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }]]),
    // function_call without a name
    sse([
      [
        'response.created',
        { type: 'response.created', response: { id: 'resp_n', model: 'm', output: [] } },
      ],
      [
        'response.output_item.added',
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_n', arguments: '' },
        },
      ],
      [
        'response.function_call_arguments.delta',
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_1',
          delta: '{"a":1}',
        },
      ],
      [
        'response.output_item.done',
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_n', arguments: '{"a":1}' },
        },
      ],
      [
        'response.completed',
        {
          type: 'response.completed',
          response: {
            id: 'resp_n',
            status: 'completed',
            output: [
              { type: 'function_call', id: 'fc_1', call_id: 'call_n', arguments: '{"a":1}' },
            ],
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        },
      ],
    ]),
  ],
  gemini: [
    sse([
      [null, { candidates: [{ content: { parts: [{ text: 'no' }] }, finishReason: 'SAFETY' }] }],
    ]),
    sse([[null, { promptFeedback: { blockReason: 'OTHER' } }]]),
    sse([[null, { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }]]),
    sse([
      [
        null,
        {
          responseId: 'r1',
          modelVersion: 'g',
          candidates: [
            { content: { parts: [{ text: 'think', thought: true, thoughtSignature: 'sig1' }] } },
          ],
        },
      ],
      [
        null,
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'f', args: { a: [1, 2.5, 1e21] } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 3 },
        },
      ],
    ]),
    // functionCall without a name next to a named one
    sse([
      [
        null,
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { args: { a: 1 } } },
                  { functionCall: { name: 'g', args: {} } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ],
    ]),
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
            usage: { input_tokens: 9, cache_read_input_tokens: 4 },
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
          content_block: { type: 'redacted_thinking', data: 'xx' },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { q: 1 } },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } },
      ],
    ]),
    sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]]),
    // tool_use without a name: dropped, stop_reason tool_use becomes end_turn
    sse([
      [
        'message_start',
        {
          type: 'message_start',
          message: { id: 'msg_2', model: 'claude', usage: { input_tokens: 3 } },
        },
      ],
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_n', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]),
  ],
};
export const extraJson = {
  chat: [{ error: { message: 'nope', code: 'invalid_api_key' } }],
  responses: [
    {
      id: 'resp_x',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ text: 'a' }, { text: 'b' }],
          encrypted_content: 'E',
        },
        { type: 'function_call', call_id: 'c', name: 'apply_patch', arguments: { input: 'raw' } },
      ],
      incomplete_details: { reason: 'max_output_tokens' },
    },
  ],
  gemini: [{ promptFeedback: { blockReason: 'SAFETY' } }],
  messages: [
    { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
    // tool_use without a name
    {
      id: 'msg_n',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'toolu_n', input: { a: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  ],
};

/** assistant turns for the response fixer / passthrough / terminal fixtures */
const rep = (s, n) => Array.from({ length: n }, () => s).join('');
export const fixTexts = [
  {
    text: 'Let me check. <tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>',
  },
  {
    text: 'ok get_weather<arg_key>city</arg_key><arg_value>Paris</arg_value><arg_key>days</arg_key><arg_value>3</arg_value>',
  },
  {
    text: 'Plan:\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="read_file">\n<｜DSML｜parameter name="path" string="true">a&amp;b.txt</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>',
  },
  { text: 'x <tool_call>{"name":"nope","arguments":{}}</tool_call> tail' },
  {
    text: '<tool_call>{"function":{"name":"get_weather","arguments":"{\\"city\\":\\"Rome\\"}"}}</tool_call>   ',
  },
  { text: rep('This is the same sentence again. ', 50) },
  { think: rep('我在想同一件事情。', 50), text: 'never' },
  { text: 'a < b and <tool' },
  {
    text: 'see <tool_call>{"name":"get_weather","arguments":{"city":"Oslo"}}',
    tools: [{ name: 'mapped_weather', args: '{"city":"Oslo"}' }],
  },
  {
    tools: [
      { name: 'mapped_weather', args: '{"city":"Lima"}' },
      { name: 'other', args: '{}' },
    ],
  },
  { text: '你好😀，世界。Emoji 🎉🎉 test! Done?' },
  { text: 'cut <tool_call>{"name":"get_weather"' },
  {
    text: 'ok get_weather<arg_key>city</arg_key><arg_value>Paris</arg_value><arg_key>2</arg_key><arg_value>b</arg_value><arg_key>1</arg_key><arg_value>a</arg_value>',
  },
  {
    text: 'ok get_weather<arg_key>10</arg_key><arg_value>x</arg_value><arg_key>01</arg_key><arg_value>y</arg_value><arg_key>4294967295</arg_key><arg_value>z</arg_value><arg_key>0</arg_key><arg_value>w</arg_value>',
  },
  // tool calls without a name (nameless: never named; lateName: name after the args)
  { tools: [{ name: 'other', args: '{"a":1}', nameless: true }] },
  {
    tools: [
      { name: 'other', args: '{}' },
      { name: 'x', args: '{"b":2}', nameless: true },
      { name: 'mapped_weather', args: '{"city":"Oslo"}', lateName: true },
    ],
  },
];
/** JSON texts whose key order exercises JS integer-key ordering */
export const objKeyTexts = [
  '{"b":1,"2":2,"a":3,"1":4}',
  '{"10":1,"9":2,"01":3,"-1":4,"1.5":5,"0":6}',
  '{"4294967294":1,"4294967295":2,"4294967296":3,"3":4}',
  '{"x":{"2":1,"1":2},"arr":[{"5":0,"k":1,"4":2}]}',
  '{"1":1,"a":2,"1":3}',
  '{"":1,"00":2,"0":3," 1":4}',
];
