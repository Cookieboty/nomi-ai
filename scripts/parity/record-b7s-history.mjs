#!/usr/bin/env node
/**
 * 批次 7s：SessionHistoryService golden。每个场景的会话文件（含 @@SB@@ 占位的模板）、注入依赖与步骤
 * 随 golden 一起写出；Node 在沙箱里现场跑，Go 端按同一份模板重建文件逐步回放。
 * 输出 apps/desktop-go/internal/core/cli/testdata/b7s-history.json。CI 由 record-b7-drivers.mjs 链式录制（NOMI_GOLDEN_DIR）。
 * Usage: node --import tsx scripts/parity/record-b7s-history.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const H = await import(
  pathToFileURL(
    path.join(root, 'apps/desktop-electron/internal/core/src/cli/SessionHistoryService.ts'),
  ).href
);
const FIX = path.join(root, 'apps/desktop-electron/internal/core/tests/fixtures/history');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

const T = '@@SB@@';
const TE = encodeURIComponent(T);
const W = `${T}/work`;
const J = (o) => JSON.stringify(o);
const jl = (...xs) => xs.map(J).join('\n') + '\n';
// 文件：{p, text, mtime, json?(占位按 JSON 转义替换), zstd?, pad?}
const F = (p, text, mtime, o = {}) => ({ p, text, mtime, json: true, ...o });

const claude = (id, title, mtime, o = {}) =>
  F(
    `home/.claude/projects/-work-app/${id}.jsonl`,
    jl(
      {
        type: 'user',
        sessionId: o.sid ?? id,
        cwd: o.cwd ?? W,
        timestamp: '2026-10-14T10:00:00.000Z',
        ...(o.side ? { isSidechain: true } : {}),
        ...(o.perm ? { permissionMode: o.perm } : {}),
        message: { role: 'user', content: title },
      },
      {
        type: 'assistant',
        sessionId: o.sid ?? id,
        cwd: o.cwd ?? W,
        timestamp: '2026-10-14T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: o.model ?? 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
        },
      },
    ),
    mtime,
  );
const codexDay = 'home/.codex/sessions/2026/10/14';
const rollout = (id, title, meta = {}, extra = []) =>
  jl(
    {
      timestamp: '2026-10-14T13:30:12.603Z',
      type: 'session_meta',
      payload: { id, cwd: W, source: 'cli', ...meta },
    },
    {
      timestamp: '2026-10-14T13:30:13.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] },
    },
    ...extra,
  );
const codexF = (id, text, mtime, zst = false, dir = codexDay) =>
  F(
    `${dir}/rollout-2026-10-14T21-30-12-${id}.jsonl${zst ? '.zst' : ''}`,
    text,
    mtime,
    zst ? { zstd: true } : {},
  );
const cid = (i) => `01a13a9b-34b0-7612-ba36-61300000000${i}`;
const gem = (slug, id, mtime, extra = [], o = {}) => [
  F(`home/.gemini/tmp/${slug}/.project_root`, o.root ?? `${W}\n`, 1000, { json: false }),
  F(
    `home/.gemini/tmp/${slug}/chats/session-2026-10-19T00-00-${id.slice(0, 8)}.jsonl`,
    jl(
      {
        sessionId: id,
        projectHash: 'h',
        startTime: '2026-10-19T00:00:00Z',
        kind: o.kind ?? 'main',
        ...(o.summary ? { summary: o.summary } : {}),
      },
      {
        id: 'u1',
        type: 'user',
        timestamp: '2026-10-19T00:00:01Z',
        content: [{ text: o.title ?? '看看日志' }],
      },
      ...extra,
    ),
    mtime,
  ),
  F(
    `home/.gemini/tmp/${slug}/chats/${id}/sub.jsonl`,
    J({ sessionId: 'sub', kind: 'subagent' }) + '\n',
    mtime - 1,
  ),
];
const grokF = (id, lines, mtime, enc = `${TE}%2Fwork`) =>
  F(`home/.grok/sessions/${enc}/${id}/updates.jsonl`, jl(...lines), mtime);
const dshF = (id, mtime, o = {}) => {
  const meta = JSON.parse(fx('dsh-projcache.json'));
  meta.record.identity.cwd = o.cwd ?? W;
  if (o.title !== undefined) meta.record.title = o.title;
  const out = [
    F(
      `home/.dsh/sessions/--work--/${id}/session.v4.jsonl${o.plain ? '' : '.zstd'}`,
      o.text ?? fx('dsh-session.jsonl'),
      mtime,
      o.plain ? {} : { zstd: true, ...(o.pad ? { pad: o.pad } : {}) },
    ),
    F(`home/.dsh/sessions/--work--/${id}/session.lock`, '', mtime - 1),
  ];
  if (!o.noIndex)
    out.push(F(`home/.dsh/storages/session_projcache/sessions/${id}.json`, J(meta), 1000));
  return out;
};

const D0 = { open: [], tab: { reused: false }, trash: true };
export const SCENARIOS = [
  {
    name: 'pure',
    files: [],
    steps: [
      [
        'meta',
        jl({
          type: 'session_meta',
          payload: { source: 'vscode', originator: 'Codex Desktop', model_provider: 'openai' },
        }),
      ],
      [
        'meta',
        jl({
          type: 'session_meta',
          payload: { source: { subagent: 'x' }, originator: '  ', model_provider: 7 },
        }),
      ],
      ['meta', jl({ type: 'session_meta', payload: { source: null } })],
      ['meta', ''],
      ['meta', 'garbage\n{"type":"x"}\n'],
      ['meta', jl({ type: 'session_meta' })],
      ['meta', jl({ type: 'session_meta', payload: 'str' })],
      ['sub', 'cli'],
      ['sub', ' {"subagent":1}'],
      ['sub', '{bad'],
      ['sub', '{"other":1}'],
      ['sub', { subagent: { other: 'guardian' } }],
      ['sub', null],
      ['sub', 7],
      ['sub', ['subagent']],
      ['sub', '"{x"'],
      ['sub', '\u00a0{"subagent":null}'],
      ['route', null],
      ['route', ''],
      ['route', 'openai'],
      ['route', 'nomi_gateway'],
      ['route', 'custom'],
      ['route', 'OpenAI'],
      ['client', 'nomi', null],
      ['client', ' Nomi-desktop ', null],
      ['client', 'Codex Desktop', null],
      ['client', 'codex_work_desktop', 'cli'],
      ['client', 'codex_vscode', null],
      ['client', 'codex_exec', null],
      ['client', null, 'exec'],
      ['client', 'codex_cli_rs', 'vscode'],
      ['client', null, 'cli'],
      ['client', null, 'vscode'],
      ['client', 'other', 'other'],
      ['client', null, null],
      ['client', 'NOMI', 'exec'],
      [
        'changed',
        [
          ['a', { id: 'a', n: 1 }],
          ['b', { id: 'b', name: 'x' }],
        ],
        [
          ['a', { id: 'a', n: 1 }],
          ['b', { id: 'b', name: 'y' }],
          ['c', { id: 'c' }],
        ],
      ],
      ['changed', [['a', { id: 'a', x: null }]], [['a', { id: 'a' }]]],
      ['changed', [['a', { id: 'a', x: 1 }]], [['a', { id: 'a', x: '1' }]]],
      [
        'changed',
        [
          ['z', { id: 'z' }],
          ['a', { id: 'a' }],
        ],
        [],
      ],
      ['changed', [], []],
      ['changed', [['a', { id: 'a', x: 0 }]], [['a', { id: 'a', x: 0 }]]],
    ],
  },
  {
    name: 'claudeBasic',
    deps: D0,
    files: [
      claude('a', 'older task', 1_000_000),
      claude('b', 'newer task', 2_000_000, { perm: 'acceptEdits' }),
      F(
        'home/.claude/projects/-work-app/empty.jsonl',
        '{"type":"queue-operation","operation":"enqueue","sessionId":"empty"}\n',
        3_000_000,
      ),
      claude('side', 'sub agent', 4_000_000, { side: true }),
      F(
        'home/.claude/projects/-work-app/mixed.jsonl',
        jl(
          {
            type: 'user',
            sessionId: 'mixed',
            cwd: W,
            message: { role: 'user', content: 'main prompt' },
          },
          {
            type: 'user',
            sessionId: 'mixed',
            isSidechain: true,
            cwd: W,
            message: { role: 'user', content: 'side' },
          },
        ),
        5_000_000,
      ),
      F(
        'home/.claude/projects/-work-app/notitle.jsonl',
        jl({
          type: 'user',
          sessionId: 'nt',
          cwd: W,
          message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
        }),
        6_000_000,
      ),
      claude('gone', 'moved project', 500_000, { cwd: `${T}/gone`, perm: 'bogus' }),
      F(
        'home/.claude/projects/-work-app/raw.jsonl',
        '{"type":"user","sessionId":"rawid","message":{"role":"user","content":"hi \\u00e9"}}\n\uFFFDbad\n',
        7_000_000,
      ),
    ],
    steps: [
      ['list', 'claude', {}],
      ['index', 'claude', { limit: 2 }],
      ['index', 'claude', { offset: 2, limit: 2 }],
      ['list', 'claude', { offset: 600 }],
      ['list', 'claude', { limit: 0.4 }],
      ['list', 'claude', { limit: 99, offset: -3 }],
      ['list', 'claude', { offset: 1.5 }],
      ['list', 'nope', {}],
      ['transcript', 'claude', 'b'],
      ['transcript', 'claude', 'missing'],
      ['transcript', 'claude', 'nt'],
      ['open', 'claude', 'b'],
      ['open', 'claude', 'gone'],
      ['open', 'claude', 'missing'],
      ['calls'],
    ],
  },
  {
    name: 'claudeOpenAndDeps',
    deps: {
      ...D0,
      open: ['claude:a'],
      gateway: ['claude:b'],
      sessionModel: { 'claude:b': 'acme/claude-x' },
      sessionAccount: {
        'claude:b': { id: 'acct-1', label: 'me@x.com' },
        'claude:c': { id: 'acct-2' },
      },
      tab: { reused: true },
    },
    files: [
      claude('a', 'opened already', 1_000_000),
      claude('b', 'gateway one', 2_000_000),
      claude('c', 'third', 3_000_000),
    ],
    steps: [
      ['list', 'claude', {}],
      ['calls'],
      ['open', 'claude', 'b'],
      ['open', 'claude', 'c'],
      ['calls'],
      ['remove', 'claude', 'a'],
      ['remove', 'zzz', 'a'],
    ],
  },
  {
    name: 'claudeNoOpenTab',
    deps: { open: [] },
    files: [claude('a', 'x', 1000)],
    steps: [
      ['open', 'claude', 'a'],
      ['remove', 'claude', 'a'],
    ],
  },
  {
    name: 'claudeEnv',
    deps: { ...D0, env: { CLAUDE_CONFIG_DIR: `${T}/cc`, CODEX_HOME: `${T}/cx` } },
    files: [
      F(
        'cc/projects/p/e1.jsonl',
        jl({
          type: 'user',
          sessionId: 'e1',
          cwd: W,
          message: { role: 'user', content: 'from env dir' },
        }),
        1000,
      ),
      claude('a', 'default dir', 2000),
      F(`cx/sessions/2026/10/14/rollout-x-${cid(9)}.jsonl`, rollout(cid(9), 'codex env'), 3000),
    ],
    steps: [
      ['list', 'claude', {}],
      ['list', 'codex', {}],
    ],
  },
  {
    name: 'claudePaging',
    deps: D0,
    files: Array.from({ length: 45 }, (_, i) =>
      claude(`s${String(i).padStart(2, '0')}`, `task ${i}`, 10_000 + i * 1000),
    ),
    steps: [
      ['list', 'claude', {}],
      ['list', 'claude', { offset: 20 }],
      ['list', 'claude', { offset: 40 }],
      ['index', 'claude', { offset: 44 }],
      ['index', 'claude', { offset: 45 }],
    ],
  },
  {
    name: 'claudeMaxItems',
    deps: D0,
    files: [{ ...claude('m{i}', 'many {i}', 10_000), times: 520 }],
    steps: [
      ['list', 'claude', { offset: 480 }],
      ['list', 'claude', { offset: 460 }],
      ['index', 'claude', { offset: 499, limit: 5 }],
      ['index', 'claude', { offset: 500 }],
    ],
  },
  {
    name: 'claudeIncremental',
    deps: D0,
    files: [claude('a', 'first', 1000), claude('b', 'second', 2000)],
    steps: [
      ['list', 'claude', {}],
      ['write', claude('a', 'first renamed', 3000)],
      ['list', 'claude', {}],
      ['list', 'claude', { force: true }],
      ['rm', 'home/.claude/projects/-work-app/b.jsonl'],
      ['list', 'claude', { force: true }],
      ['transcript', 'claude', 'b'],
    ],
  },
  {
    name: 'claudeRemove',
    deps: D0,
    files: [
      claude('a', 'del me', 1000),
      F('home/.claude/projects/-work-app/a/tool.txt', 'x', 1000, { json: false }),
      claude('b', 'keep', 2000),
    ],
    steps: [
      ['remove', 'claude', 'a'],
      ['exists', 'home/.claude/projects/-work-app/a.jsonl'],
      ['exists', 'home/.claude/projects/-work-app/a'],
      ['calls'],
      ['list', 'claude', {}],
      ['remove', 'claude', 'a'],
      ['remove', 'claude', 'b'],
    ],
  },
  {
    name: 'trashFails',
    deps: { ...D0, trash: 'fail' },
    files: [claude('a', 'x', 1000)],
    steps: [['remove', 'claude', 'a'], ['calls']],
  },
  {
    name: 'codexIndex',
    deps: {
      ...D0,
      db: true,
      rows: [
        {
          id: cid(0),
          name: 'named in sqlite',
          model: 'gpt-5',
          reasoning_effort: 'high',
          model_provider: 'nomi_gateway',
          creator_account_id: 'acc-9',
          cwd: `${T}/work`,
          archived: 0,
        },
        { id: cid(1), archived: 1 },
        { id: cid(2), source: '{"subagent":{"thread_spawn":{}}}' },
        {
          id: cid(3),
          title: '',
          first_user_message: 'first from db',
          originator: 'codex_vscode',
          model_provider: 'custom',
        },
        { id: cid(6), title: 'db only zst', source: 'vscode', model_provider: 'acme', cwd: '' },
      ],
      accountLabel: { 'acc-9': 'nine@x.com' },
    },
    files: [
      codexF(cid(0), rollout(cid(0), 'from rollout'), 9000),
      codexF(cid(1), rollout(cid(1), 'archived'), 8000),
      codexF(cid(2), rollout(cid(2), 'spawned'), 7000),
      codexF(
        cid(3),
        jl({ timestamp: 'x', type: 'session_meta', payload: { id: cid(3), source: 'exec' } }),
        6000,
      ),
      codexF(
        cid(4),
        rollout(cid(4), 'compressed one', { originator: 'Codex Desktop', source: 'vscode' }),
        5000,
        true,
      ),
      codexF(
        cid(5),
        rollout(cid(5), 'guardian', { source: { subagent: { other: 'guardian' } } }),
        4000,
      ),
      codexF(cid(6), rollout(cid(6), 'zz'), 3500, true),
      codexF(
        cid(7),
        rollout(cid(7), 'via cc-switch', {
          model_provider: 'custom',
          originator: 'codex_exec',
          source: 'exec',
        }),
        3000,
      ),
      codexF(cid(8), rollout(cid(8), '', { originator: 'Codex Desktop' }), 2000),
      F(`home/.codex/archived_sessions/rollout-a-${cid(1)}.jsonl`, rollout(cid(1), 'arch'), 1000),
    ],
    steps: [
      ['list', 'codex', {}],
      ['open', 'codex', cid(0)],
      ['calls'],
      ['transcript', 'codex', cid(4)],
      ['rows', [{ id: cid(0), name: 'renamed in sqlite', model_provider: 'openai' }]],
      ['touchDb'],
      ['list', 'codex', { force: true }],
      ['rowsFail'],
      ['touchDb'],
      ['list', 'codex', { force: true }],
      ['calls'],
    ],
  },
  {
    name: 'codexNoDb',
    deps: D0,
    files: [
      codexF(
        cid(0),
        rollout(cid(0), 'newest file', { model_provider: 'openai', model: 'o3' }),
        5000,
      ),
      codexF(
        cid(0),
        rollout(cid(0), 'older file same id'),
        4000,
        false,
        'home/.codex/sessions/2026/10/13',
      ),
      codexF(
        cid(1),
        rollout(cid(1), 'from nomi', {
          model_provider: 'nomi_gateway',
          originator: 'nomi',
          source: 'vscode',
        }),
        3000,
      ),
      codexF(cid(2), rollout(cid(2), 'zst no index'), 2000, true),
      codexF(cid(3), fx('codex-rollout.jsonl'), 1000),
      F(`${codexDay}/rollout-noid.jsonl`, rollout(undefined, 'no id anywhere'), 500),
    ],
    steps: [
      ['list', 'codex', {}],
      ['open', 'codex', cid(1)],
      ['calls'],
      ['transcript', 'codex', cid(3)],
      ['transcript', 'codex', cid(2)],
      ['remove', 'codex', cid(0)],
      ['calls'],
      ['list', 'codex', { force: true }],
    ],
  },
  {
    name: 'gemini',
    deps: D0,
    files: [
      ...gem('app', 'gem-11111111', 2_000_000, [
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
      ]),
      ...gem('sum', 'gem-22222222', 3_000_000, [], { summary: 'Summarised  title', root: '   ' }),
      ...gem('sub', 'gem-33333333', 4_000_000, [], { kind: 'subagent' }),
      ...gem('empty', 'gem-44444444', 5_000_000, [], { title: '   ' }),
      F('home/.gemini/tmp/raw/chats/session-x.json', fx('gemini-session.jsonl'), 6_000_000),
    ],
    steps: [
      ['list', 'gemini', {}],
      ['open', 'gemini', 'gem-11111111'],
      ['open', 'gemini', 'gem-22222222'],
      ['calls'],
      ['remove', 'gemini', 'gem-11111111'],
      ['calls'],
      ['exists', 'home/.gemini/tmp/app/chats/gem-11111111'],
    ],
  },
  {
    name: 'geminiHome',
    deps: { ...D0, geminiHome: `${T}/gh` },
    files: [
      F(
        'gh/.gemini/tmp/x/chats/session-1.jsonl',
        jl(
          { sessionId: 'gh-1', kind: 'main' },
          { id: 'u', type: 'user', content: 'from gemini home' },
        ),
        1000,
      ),
      ...gem('app', 'gem-11111111', 2000),
    ],
    steps: [['list', 'gemini', {}]],
  },
  {
    name: 'grok',
    deps: D0,
    files: [
      grokF(
        'grok-session-1',
        [
          {
            sessionId: 'grok-session-1',
            cwd: W,
            sessionUpdate: 'user_message',
            content: [{ type: 'text', text: 'inspect project' }],
          },
          {
            sessionId: 'grok-session-1',
            sessionUpdate: 'agent_message',
            content: [{ type: 'text', text: 'done' }],
          },
          {
            sessionId: 'grok-session-1',
            sessionUpdate: 'current_mode_update',
            currentModeId: 'acceptEdits',
          },
          {
            sessionId: 'grok-session-1',
            usage: { modelUsage: { 'grok-4.7-build': { inputTokens: 1 } } },
            reasoningEffort: 'high',
          },
        ],
        3_000_000,
      ),
      grokF(
        'grok-acp-1',
        [
          {
            timestamp: 1_792_763_438,
            method: 'session/update',
            params: {
              sessionId: 'grok-acp-1',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: '你是什么模型' },
              },
            },
          },
          {
            timestamp: 1_792_763_438,
            method: 'session/update',
            params: {
              sessionId: 'grok-acp-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '我是 Grok' },
              },
            },
          },
        ],
        2_000_000,
      ),
      grokF(
        'grok-bad-enc',
        [{ sessionUpdate: 'user_message', content: [{ type: 'text', text: 'bad dir' }] }],
        1_000_000,
        '%E0%A4%A',
      ),
      grokF(
        'grok-empty',
        [{ sessionUpdate: 'agent_message', content: [{ type: 'text', text: 'only reply' }] }],
        500_000,
      ),
    ],
    steps: [
      ['list', 'grok', {}],
      ['open', 'grok', 'grok-session-1'],
      ['open', 'grok', 'grok-bad-enc'],
      ['calls'],
      ['remove', 'grok', 'grok-acp-1'],
      ['calls'],
      ['list', 'grok', { force: true }],
    ],
  },
  {
    name: 'dsh',
    deps: D0,
    files: [
      ...dshF('session-887fa07d-22ae-4013-849f-2b2fafcba3c3', 3000),
      ...dshF('session-887fa07d-22ae-4013-849f-2b2fafcba3c4', 2000, { pad: 8 + 2 * 1024 * 1024 }),
      ...dshF('session-plain-1', 1500, { plain: true, cwd: `${T}/gone` }),
      ...dshF('session-noidx', 1000, { noIndex: true }),
      ...dshF('session-notitle', 900, { title: '' }),
    ],
    steps: [
      ['list', 'dsh', {}],
      ['transcript', 'dsh', 'session-887fa07d-22ae-4013-849f-2b2fafcba3c3'],
      ['open', 'dsh', 'session-887fa07d-22ae-4013-849f-2b2fafcba3c3'],
      ['open', 'dsh', 'session-plain-1'],
      ['calls'],
      ['remove', 'dsh', 'session-887fa07d-22ae-4013-849f-2b2fafcba3c3'],
      ['calls'],
      [
        'exists',
        'home/.dsh/storages/session_projcache/sessions/session-887fa07d-22ae-4013-849f-2b2fafcba3c3.json',
      ],
      ['list', 'dsh', { force: true }],
    ],
  },
  {
    name: 'transcriptLong',
    deps: D0,
    files: [
      F(
        'home/.claude/projects/-work-app/long.jsonl',
        jl({
          type: 'user',
          sessionId: 'long',
          cwd: W,
          message: { role: 'user', content: 'long one' },
        }),
        1000,
        {
          rep: [
            J({
              type: 'assistant',
              sessionId: 'long',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'reply ' + 'x'.repeat(5000) }],
              },
            }) + '\n',
            2600,
          ],
        },
      ),
    ],
    steps: [
      ['open', 'claude', 'long'],
      ['transcriptMeta', 'claude', 'long'],
    ],
  },
  {
    name: 'corruptZstd',
    deps: D0,
    files: [
      ...dshF('session-corrupt', 1000, { plain: true }).map((f, i) =>
        i === 0 ? { ...f, p: f.p + '.zstd', text: 'not really zstd' } : f,
      ),
    ],
    steps: [
      ['list', 'dsh', {}],
      ['transcript', 'dsh', 'session-corrupt'],
      ['open', 'dsh', 'session-corrupt'],
    ],
  },
].map((s) => ({ ...s, files: (s.files ?? []).filter(Boolean) }));

/* ------------------------------ 运行 ------------------------------ */

const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v;
const zc = (b) => {
  const n = zlib.zstdCompressSync;
  return n ? n(b) : execFileSync('zstd', ['-c', '-q'], { input: b });
};

// times：按 {i}（3 位补零）展开成 N 个文件，mtime 逐个 +1000
function expand(f) {
  if (!f.times) return [f];
  return Array.from({ length: f.times }, (_, i) => {
    const k = String(i).padStart(3, '0');
    return {
      ...f,
      times: undefined,
      p: f.p.replaceAll('{i}', k),
      text: f.text.replaceAll('{i}', k),
      mtime: f.mtime + i * 1000,
    };
  });
}
function materialize(SB, f) {
  const enc = encodeURIComponent(SB);
  const js = JSON.stringify(SB).slice(1, -1);
  const p = path.join(SB, ...f.p.split('/').map((x) => x.replaceAll(TE, enc)));
  let text = f.text.replaceAll(TE, enc).replaceAll(T, f.json ? js : SB);
  if (path.sep === '\\')
    text = text.replaceAll(f.json ? `${js}/` : `${SB}/`, f.json ? `${js}\\\\` : `${SB}\\`);
  if (f.rep) text += f.rep[0].repeat(f.rep[1]);
  let buf = Buffer.from(text);
  if (f.zstd) buf = zc(buf);
  if (f.pad) {
    const pad = Buffer.alloc(f.pad);
    pad.writeUInt32LE(0x184d2a50, 0);
    pad.writeUInt32LE(f.pad - 8, 4);
    buf = Buffer.concat([buf, pad]);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  fs.utimesSync(p, new Date(f.mtime), new Date(f.mtime));
}
const sub = (SB, s) => {
  let v = s.replaceAll(T, SB);
  if (path.sep === '\\') v = v.replaceAll(`${SB}/`, `${SB}\\`);
  return v;
};

// 逐值替换（不经 JSON 文本：Windows 沙箱路径的反斜杠会破坏 JSON）
const deepSub = (SB, v) =>
  typeof v === 'string'
    ? sub(SB, v)
    : Array.isArray(v)
      ? v.map((x) => deepSub(SB, x))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepSub(SB, x)]))
        : v;

export async function runScenario(sc) {
  const SB = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-b7sh-')));
  const scrub = (v) => {
    const enc = encodeURIComponent(SB);
    const s = JSON.stringify(v ?? null)
      .replaceAll(JSON.stringify(SB).slice(1, -1), '<SB>')
      .replaceAll(enc, '<SBENC>');
    return JSON.parse(s);
  };
  fs.mkdirSync(path.join(SB, 'work'), { recursive: true });
  fs.mkdirSync(path.join(SB, 'home'), { recursive: true });
  for (const f of sc.files.flatMap(expand)) materialize(SB, f);
  const d = sc.deps;
  const calls = [];
  let rows = d?.rows ?? [];
  let rowsFail = false;
  const db = path.join(SB, 'home', '.codex', 'state_5.sqlite');
  if (d?.db) {
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, 'x');
    fs.utimesSync(db, new Date(1000), new Date(1000));
  }
  let dbN = 1;
  const svc = d
    ? new H.SessionHistoryService({
        home: path.join(SB, 'home'),
        dshHome: path.join(SB, 'home', '.dsh'),
        ...(d.geminiHome ? { geminiHome: sub(SB, d.geminiHome) } : {}),
        env: Object.fromEntries(Object.entries(d.env ?? {}).map(([k, v]) => [k, sub(SB, v)])),
        logger: { warn: (m) => calls.push(['warn', m]) },
        openKeys: () => new Set(d.open ?? []),
        openTitle: (b, id, t) => calls.push(['openTitle', b, id, t]),
        ...(d.tab
          ? {
              openTab: (o) => {
                calls.push([
                  'openTab',
                  { ...o, messages: o.messages.length, firstMsg: o.messages[0] ?? null },
                ]);
                return { tab: { id: `tab-${o.sessionId}` }, reused: d.tab.reused };
              },
            }
          : {}),
        sessionModel: (b, id) => d.sessionModel?.[`${b}:${id}`],
        gatewaySession: (b, id) => (d.gateway ?? []).includes(`${b}:${id}`),
        accountLabel: (b, id) => d.accountLabel?.[id],
        sessionAccount: (b, id) => d.sessionAccount?.[`${b}:${id}`],
        ...(d.trash
          ? {
              trash: async (p) => {
                calls.push(['trash', p]);
                if (d.trash === 'fail') throw new Error('trash denied');
                fs.rmSync(p, { recursive: true, force: true });
              },
            }
          : {}),
        codexThreads: async () => {
          calls.push(['codexThreads']);
          if (rowsFail) throw new Error('worker crashed');
          return rows.map((r) => deepSub(SB, r));
        },
      })
    : null;
  const out = [];
  for (const st of sc.steps) {
    const [op, ...a] = st;
    let r;
    try {
      switch (op) {
        case 'meta':
          r = H.codexSessionMeta(a[0]);
          break;
        case 'sub':
          r = H.isCodexSubagentSource(a[0]);
          break;
        case 'route':
          r = H.codexRoute(a[0]);
          break;
        case 'client':
          r = H.codexClient(a[0] ?? undefined, a[1] ?? undefined);
          break;
        case 'changed':
          r = [...H.codexRowsChanged(new Map(a[0]), new Map(a[1]))];
          break;
        case 'list':
          r = await svc.list(a[0], a[1]);
          break;
        case 'index':
          r = await svc.index(a[0], a[1]);
          break;
        case 'transcript':
          r = await svc.transcript(a[0], a[1]);
          break;
        case 'transcriptMeta': {
          const t = await svc.transcript(a[0], a[1]);
          r = {
            n: t.messages.length,
            truncated: t.truncated,
            note: t.note,
            first: t.messages[0]?.content?.slice(0, 40),
          };
          break;
        }
        case 'open':
          r = await svc.open(a[0], a[1]);
          break;
        case 'remove':
          r = await svc.remove(a[0], a[1]);
          break;
        case 'write':
          materialize(SB, a[0]);
          r = null;
          break;
        case 'rm':
          fs.rmSync(path.join(SB, ...a[0].split('/')), { recursive: true, force: true });
          r = null;
          break;
        case 'exists':
          r = fs.existsSync(path.join(SB, ...a[0].split('/')));
          break;
        case 'calls':
          r = calls.splice(0);
          break;
        case 'rows':
          rows = a[0];
          rowsFail = false;
          r = null;
          break;
        case 'rowsFail':
          rowsFail = true;
          r = null;
          break;
        case 'touchDb':
          dbN++;
          fs.writeFileSync(db, 'x'.repeat(dbN));
          fs.utimesSync(db, new Date(1000 * dbN), new Date(1000 * dbN));
          r = null;
          break;
        default:
          throw new Error(`bad op ${op}`);
      }
      out.push(r === undefined ? { undef: true } : { v: sortKeys(scrub(r)) });
    } catch (e) {
      out.push({ err: scrub(String(e?.message ?? e)) });
    }
  }
  fs.rmSync(SB, { recursive: true, force: true });
  return out;
}

const result = [];
for (const sc of SCENARIOS) result.push({ ...sc, out: await runScenario(sc) });
const dir =
  process.env.NOMI_GOLDEN_DIR || path.join(root, 'apps/desktop-go/internal/core/cli/testdata');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'b7s-history.json');
fs.writeFileSync(
  file,
  JSON.stringify({ platform: process.platform, scenarios: result }, null, 1) + '\n',
);
console.log(
  `b7s-history: ${result.length} scenarios, ${result.reduce((n, s) => n + s.out.length, 0)} steps → ${file}`,
);
