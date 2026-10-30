#!/usr/bin/env node
/**
 * 批次 7 纯函数 golden：transcript / models / cleanTitle 等。
 * 语料：b7-fn-corpus.jsonl（b7-capture.cjs 以 B7_FN_CAPTURE 在 core 单测中采集）+ 下方手写边界。
 * 输出 apps/desktop-go/internal/cliplugins/testdata/fns.json：[{fn,args,out}]，out 为 JSON.stringify 结果
 * （undefined 记为 null 字段 "undef":true）。Go 侧 fns_parity_test.go 按 fn 名注册回放。
 * Usage: (先 build packages/cli-sdk、cli-plugins) node scripts/parity/record-b7-fns.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const req = createRequire(join(root, 'apps/desktop-electron/internal/core/package.json'));
const P = req('@nomi-ai/cli-plugins/main');
const S = req('@nomi-ai/cli-sdk');

const cases = [];
let taskTitles = 0;
for (const l of readFileSync(join(here, 'b7-fn-corpus.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const o = JSON.parse(l);
  if (o.fn === 'cleanTitle' && /^task \d+$/.test(o.args[0] ?? '') && ++taskTitles > 3) continue;
  cases.push(o);
}
const J = JSON.stringify;
const lines = (...xs) => xs.map((x) => (typeof x === 'string' ? x : J(x))).join('\n');
const T = '2025-01-02T03:04:05.678Z';
// —— 手写边界 ——
const claudeT = lines(
  {
    type: 'user',
    timestamp: T,
    message: { content: 'hello <system-reminder>x</system-reminder>' },
  },
  { type: 'user', isMeta: true, message: { content: 'meta' } },
  { type: 'user', isSidechain: true, message: { content: 'side' } },
  {
    type: 'assistant',
    timestamp: 'bad',
    message: {
      model: 'm',
      usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 },
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [{ type: 'text', text: 'out' }],
          is_error: true,
        },
      ],
    },
  },
  'garbage',
  '',
  '[1,2]',
  'null',
  { type: 'summary', summary: 's' },
  { type: 'assistant', message: { content: 'plain string' } },
  { type: 'user', message: { content: [{ type: 'text', text: '' }, { type: 'image' }] } },
);
const codexT = lines(
  { type: 'session_meta', timestamp: T, payload: { id: 'x', cwd: '/w' } },
  {
    type: 'response_item',
    timestamp: T,
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>e</environment_context>' }],
    },
  },
  {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
  },
  {
    type: 'response_item',
    payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell',
      call_id: 'c1',
      arguments: '{"command":["ls"]}',
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'c1',
      output: '{"output":"a\\nb","metadata":{"exit_code":1}}',
    },
  },
  {
    type: 'response_item',
    payload: { type: 'local_shell_call', call_id: 'c2', action: { type: 'exec' } },
  },
  {
    type: 'response_item',
    payload: { type: 'local_shell_call', call_id: 'c3', action: { command: null } },
  },
  {
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c4', input: 'patch' },
  },
  {
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: 'c4', output: 'done' },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4 },
        last_token_usage: { input_tokens: 3 },
      },
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    },
  },
  'x{',
  '',
);
const grokT = lines(
  { type: 'user', timestamp: T, content: 'hi' },
  { role: 'user', time: T, message: { content: [{ type: 'text', text: 'q' }] } },
  {
    type: 'assistant',
    content: [
      { type: 'thinking', thinking: 't' },
      { type: 'text', text: 'a' },
      { type: 'tool_use', id: 'u', name: 'read', input: {} },
    ],
  },
  { type: 'tool_result', tool_use_id: 'u', content: 'r' },
  { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } },
  'bad',
);
const dshT = lines(
  { role: 'user', time: T, content: 'hi' },
  {
    role: 'assistant',
    time: 1735787045678,
    content: 'a',
    reasoning: 'r',
    tool_calls: [{ id: 'k', function: { name: 'f', arguments: '{"a":1}' } }],
  },
  { role: 'tool', tool_call_id: 'k', content: 'res' },
  { role: 'system', content: 's' },
  '',
);
const geminiT = J({
  sessionId: 's',
  messages: [
    { type: 'user', timestamp: T, content: [{ text: 'hi' }] },
    {
      type: 'gemini',
      content: 'a',
      thoughts: [{ subject: 'S', description: 'D' }],
      tokens: { input: 3, output: 4, cached: 1 },
      toolCalls: [
        {
          id: 'g',
          name: 'ls',
          args: { p: 1 },
          result: [{ functionResponse: { response: { output: 'o' } } }],
          status: 'error',
        },
      ],
    },
    { type: 'info', content: 'i' },
  ],
});
const fb = 1700000000000;
for (const [fn, t] of [
  ['parseClaudeTranscript', claudeT],
  ['parseCodexTranscript', codexT],
  ['parseGrokTranscript', grokT],
  ['parseDshTranscript', dshT],
  ['parseGeminiTranscript', geminiT],
  ['parseGeminiTranscript', 'not json'],
  ['parseClaudeTranscript', ''],
])
  cases.push({ fn, args: [t, fb] }, { fn, args: [t] });
cases.push(
  {
    fn: 'parseClaudeModels',
    args: [
      {
        models: [
          { value: 'default', displayName: 'Default', resolvedModel: 'opus' },
          {
            value: 'opus',
            displayName: 'Opus',
            resolvedModel: 'opus',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high', 'bogus', 'low'],
          },
          { value: ' sonnet ', description: ' d ', defaultEffort: 'medium' },
          { value: '' },
          7,
          null,
        ],
        permissionModes: ['plan', { id: 'auto' }, 'plan', { value: ' x ' }],
      },
      { effort: 'high' },
    ],
  },
  { fn: 'parseClaudeModels', args: [{ models: [{ value: 'default', resolvedModel: 'zzz' }] }] },
  { fn: 'parseClaudeModels', args: [{ models: [{ value: 'default' }] }] },
  { fn: 'parseClaudeModels', args: [null] },
  {
    fn: 'parseCodexModels',
    args: [
      {
        models: [
          {
            slug: 'b',
            priority: 2,
            supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }],
            default_reasoning_level: 'low',
            input_modalities: ['text'],
          },
          { slug: 'a', priority: 1, display_name: 'A', input_modalities: ['image'] },
          { slug: 'h', visibility: 'hide' },
          { slug: 'n', visibility: null },
          { slug: 'z' },
        ],
        modes: { availableModes: [{ modeId: 'm1' }] },
      },
      { model: ' b ', effort: 'xhigh' },
    ],
  },
  {
    fn: 'parseCodexModels',
    args: [
      { models: [{ slug: 'b', supported_reasoning_levels: [{ effort: 'low' }] }] },
      { model: 'b', effort: 'high' },
    ],
  },
  {
    fn: 'parseGrokModels',
    args: [
      {
        models: {
          'grok-4': {
            info: {
              name: 'G4',
              reasoningEfforts: [{ value: 'low' }, { id: 'high', default: true }],
            },
          },
          x: {},
        },
        currentModelId: 'grok-4',
      },
    ],
  },
  {
    fn: 'parseGrokModels',
    args: [
      {
        models: [
          {
            id: 'm',
            _meta: { supportsReasoningEffort: false, reasoningEfforts: ['low'] },
            reasoningEffort: 'low',
          },
        ],
        default_model: 'm',
        modes: ['a', 'b'],
      },
    ],
  },
  {
    fn: 'parseGrokModels',
    args: [
      {
        models: {
          availableModels: [
            { modelId: 'q', displayName: 'Q', reasoningEfforts: [{ value: 'medium' }] },
          ],
          currentModelId: 'q',
        },
      },
    ],
  },
  { fn: 'readClaudeEffortSetting', args: ['{"effortLevel":"high"}'] },
  { fn: 'readClaudeEffortSetting', args: ['[1]'] },
  { fn: 'readClaudeEffortSetting', args: ['nope'] },
  {
    fn: 'readCodexConfigDefaults',
    args: ['model = "gpt"\r\nmodel_reasoning_effort=\'high\'\n[profile]\nmodel="x"'],
  },
  { fn: 'readCodexConfigDefaults', args: ['model = "  "\nmodel = "a\'"b"'] },
  { fn: 'cleanTitle', args: ['  multi\n line   title  ', 10] },
  { fn: 'cleanTitle', args: [undefined] },
);
// —— 插件主进程能力快照（pluginSnapshot：Go 侧以同一输入集合构造同形对象）——
const MODES = ['plan', 'manual', 'acceptEdits', 'auto', 'bypass'];
const NATIVE = [
  'plan',
  ' auto ',
  'default',
  'Read_Only',
  'on request',
  'on-request',
  'workspace write',
  'YOLO',
  'danger',
  'dontAsk',
  'bypassPermissions',
  'weird',
  '',
  '  ',
];
const CTXS = [
  {
    cwd: '/w',
    permissionMode: 'manual',
    model: null,
    effort: null,
    accountDir: null,
    runDir: '/r',
  },
  {
    cwd: '/w',
    permissionMode: 'bypass',
    model: 'm-1',
    effort: 'high',
    accountDir: '/acct',
    runDir: '/r',
  },
  { cwd: '/w', permissionMode: 'auto', model: '', effort: null, accountDir: '', runDir: '/r' },
  {
    cwd: '/w',
    permissionMode: 'plan',
    model: 'x"y',
    effort: null,
    accountDir: '/a b',
    runDir: '/r',
  },
  {
    cwd: '/w',
    permissionMode: 'acceptEdits',
    model: null,
    effort: null,
    accountDir: null,
    runDir: '/r',
  },
];
const ENVS = [
  {},
  {
    CLAUDE_CONFIG_DIR: '~/cc',
    CODEX_HOME: ' /abs/codex ',
    GROK_HOME: '~',
    DSH_HOME: '~\\d',
    GEMINI_CLI_HOME: '/g',
  },
];
const EVS = [
  { type: 'done' },
  { type: 'done', usage: {} },
  { type: 'done', sessionId: 's' },
  { type: 'done', sessionId: 's', usage: { a: 1 } },
  { type: 'text' },
];
const MA = [{}, { model: ' m ', effort: 'low' }, { model: '', effort: null }, { model: 'a"\\b' }];
const snap = (id) => {
  const m = P[id].createMain();
  const p = m.permissions;
  return {
    supported: p.supported,
    launch: MODES.map((x) => [p.launch(x), p.launch(x, { network: false })]),
    modeId: p.modeId ? MODES.map((x) => p.modeId(x)) : null,
    fromModeId: NATIVE.map((x) => p.fromModeId(x)),
    planPrefix: p.planPrefix ?? null,
    official: CTXS.map((c) => m.launch.official(c)),
    placeholderModel: m.launch.placeholderModel ?? null,
    modelArgs: m.launch.modelArgs ? MA.map((o) => m.launch.modelArgs(o)) : null,
    accounts: m.accounts ?? null,
    roots: ENVS.map((e) => m.history.roots(e, '/home/u')),
    resume: m.history.resume('sid'),
    watch: ENVS.map((e) => m.progress.watchRoots(e, '/home/u')),
    logRoots: m.usage?.logRoots ? ENVS.map((e) => m.usage.logRoots(e, '/home/u')) : null,
    slash: m.slash?.sources
      ? [
          m.slash.sources({ projectChain: [], home: '/h' }),
          m.slash.sources({ projectChain: ['/p/a', '/p'], home: '/h' }),
        ]
      : null,
    terminal: m.terminal
      ? [
          m.terminal.command({ cwd: '/w', env: {} }),
          m.terminal.command({ cwd: '/w', resumeId: 'r1', env: {} }),
          m.terminal.command({ cwd: '/w', resumeId: '', env: {} }),
        ]
      : null,
    exec: {
      completes: EVS.map((e) => m.session.exec.completes(e)),
      silentExitIsError: m.session.exec.silentExitIsError ?? null,
    },
  };
};
for (const id of ['claude', 'codex', 'dsh', 'gemini', 'grok'])
  cases.push({ fn: 'pluginSnapshot', args: [id], out: snap(id) });
for (const plat of ['linux', 'win32'])
  cases.push({
    fn: 'terminalLine',
    args: [{ command: 'claude', args: ["it's", 'a b', ''], env: { A: "x'y", B: '' } }, plat],
  });
const out = cases.map((c) => {
  const r = c.out !== undefined ? c.out : P[c.fn](...c.args);
  return {
    fn: c.fn,
    args: c.args.map((a) => (a === undefined ? { $undef: true } : a)),
    out: r === undefined ? { $undef: true } : r,
  };
});
void S;
// NOMI_GOLDEN_DIR：CI 按平台现场录制（record-b7-drivers.mjs 串联调用），不覆盖提交的 golden
const outDir =
  process.env.NOMI_GOLDEN_DIR || join(root, 'apps/desktop-go/internal/cliplugins/testdata');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'fns.json');
writeFileSync(file, J(out, null, 1) + '\n');
console.log(`wrote ${out.length} cases → ${file}`);
