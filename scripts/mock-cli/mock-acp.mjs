#!/usr/bin/env node
/**
 * Mock generic ACP agent (an "external CLI" added in Settings → 编程助手 → 添加 CLI, §5.9).
 * Usage: mock-acp.mjs acp [--cwd <dir>] [...]   (the "acp" argument is required, to test arg templates)
 * Env: NOMI_MOCK_ACP_LOG=<file>      append {argv, cwd} and every request method (one JSON per line)
 *      NOMI_MOCK_ACP_DIR=<dir>       where sessions are kept so session/load works across restarts
 *                                    (default: <tmp>/nomi-mock-acp)
 *      NOMI_MOCK_ACP_NO_IMAGES=1     report promptCapabilities.image = false
 * A prompt containing "perm" asks for a permission (allow / reject) before answering.
 * A prompt containing "compact" auto-compacts first, Grok style (x.ai/session_notification auto_compact_*).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('mock-acp 0.1.0\n');
  process.exit(0);
}
if (argv[0] !== 'acp') {
  process.stderr.write('mock-acp: first argument must be "acp"\n');
  process.exit(2);
}

const logFile = process.env.NOMI_MOCK_ACP_LOG;
const log = (o) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`);
};
log({ argv, cwd: process.cwd() });

const dir = process.env.NOMI_MOCK_ACP_DIR || path.join(os.tmpdir(), 'nomi-mock-acp');
fs.mkdirSync(dir, { recursive: true });
const sessionFile = (id) => path.join(dir, `${id.replace(/[^\w-]/g, '_')}.json`);
const loadSession = (id) => {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
};
const saveSession = (s) => fs.writeFileSync(sessionFile(s.id), JSON.stringify(s));

const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, message) => send({ id, error: { code: -32000, message } });
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });

let nextOut = 9000;
const waiting = new Map();
const cancelled = new Set();

function ask(sessionId) {
  const id = nextOut++;
  send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: 'tc1', title: 'touch ok.txt', kind: 'edit' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function onPrompt(msg) {
  const { sessionId, prompt } = msg.params ?? {};
  const s = loadSession(sessionId);
  if (!s) return fail(msg.id, `unknown session ${sessionId}`);
  const text = (prompt ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  s.turns.push({ role: 'user', text });
  if (text.includes('perm')) {
    const r = await ask(sessionId);
    const ok = r?.outcome?.outcome === 'selected' && r.outcome.optionId === 'allow';
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc1',
      title: 'touch ok.txt',
      kind: 'edit',
      status: ok ? 'completed' : 'failed',
    });
  }
  if (text.includes('compact')) {
    const xai = (method, u) => send({ method, params: { sessionId, update: u } });
    xai('_x.ai/session_notification', {
      sessionUpdate: 'auto_compact_started',
      tokens_used: 900,
      context_window: 1000,
      percentage: 90,
    });
    // 扩展通知里的普通更新与标准 session/update 重复：驱动应忽略
    xai('x.ai/session/update', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'DUP' },
    });
    xai('x.ai/session_notification', {
      sessionUpdate: 'auto_compact_completed',
      tokens_before: 900,
      tokens_after: 300,
    });
  }
  if (cancelled.delete(sessionId)) {
    saveSession(s);
    return reply(msg.id, { stopReason: 'cancelled' });
  }
  const answer = `external: ${text} (turn ${s.turns.filter((t) => t.role === 'user').length})`;
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: answer },
  });
  s.turns.push({ role: 'assistant', text: answer });
  saveSession(s);
  reply(msg.id, { stopReason: 'end_turn' });
}

function onMessage(msg) {
  if (msg.method) log({ method: msg.method });
  if (msg.id !== undefined && !msg.method) {
    const done = waiting.get(msg.id);
    waiting.delete(msg.id);
    return done?.(msg.result);
  }
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp', version: '0.1.0' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: process.env.NOMI_MOCK_ACP_NO_IMAGES !== '1' },
        },
        authMethods: [],
      });
    case 'session/new': {
      const s = { id: `acp-${randomUUID().slice(0, 8)}`, cwd: msg.params?.cwd, turns: [] };
      saveSession(s);
      return reply(msg.id, { sessionId: s.id });
    }
    case 'session/load': {
      const s = loadSession(msg.params?.sessionId);
      if (!s) return fail(msg.id, 'session not found');
      for (const t of s.turns)
        update(s.id, {
          sessionUpdate: t.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: t.text },
        });
      return reply(msg.id, {});
    }
    case 'session/prompt':
      return void onPrompt(msg);
    case 'session/cancel':
      cancelled.add(msg.params?.sessionId);
      for (const [id, done] of waiting) {
        waiting.delete(id);
        done({ outcome: { outcome: 'cancelled' } });
      }
      return;
    default:
      if (msg.id !== undefined) fail(msg.id, `method not found: ${msg.method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      /* ignore garbage */
    }
  }
});
process.stdin.on('end', () => process.exit(0));
