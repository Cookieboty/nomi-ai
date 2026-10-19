#!/usr/bin/env node
/**
 * Mock Gemini CLI for CI / unit tests.
 * Supports: --version | --acp (newline-delimited JSON-RPC, shapes from gemini-cli 0.62.0)
 * Env: NOMI_MOCK_GEMINI_PERM=1 (ask permission before a tool), NOMI_MOCK_GEMINI_LOG=<file> (record requests),
 *      NOMI_MOCK_DELAY_MS (delay before replying to session/prompt).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('0.62.0\n');
  process.exit(0);
}
if (!args.includes('--acp')) {
  process.stderr.write('mock-gemini: only --acp is supported\n');
  process.exit(2);
}

const delayMs = Number(process.env.NOMI_MOCK_DELAY_MS || 0);
const log = process.env.NOMI_MOCK_GEMINI_LOG;
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } });
const sessions = new Set();
const cancelled = new Set();
const waiting = new Map();
let seq = 1000;

const ask = (method, params) =>
  new Promise((resolve) => {
    const id = seq++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

async function prompt(id, p) {
  const sid = p.sessionId;
  cancelled.delete(sid);
  const text = (p.prompt || []).map((c) => c.text || '').join('');
  update(sid, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Thinking…' },
  });
  if (process.env.NOMI_MOCK_GEMINI_PERM === '1') {
    const toolCall = {
      toolCallId: 'tc-1',
      title: 'Write file',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'a.txt' }],
    };
    update(sid, { sessionUpdate: 'tool_call', ...toolCall });
    const r = await ask('session/request_permission', {
      sessionId: sid,
      toolCall,
      options: [
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'proceed_always', name: 'Always', kind: 'allow_always' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const ok = r?.outcome?.outcome === 'selected' && r.outcome.optionId !== 'cancel';
    update(sid, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: ok ? 'completed' : 'failed',
      content: [{ type: 'content', content: { type: 'text', text: ok ? 'written' : 'denied' } }],
    });
  }
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (cancelled.has(sid)) return send({ id, result: { stopReason: 'cancelled' } });
  update(sid, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: `Mock Gemini: ${text}` },
  });
  send({
    id,
    result: {
      stopReason: 'end_turn',
      _meta: { quota: { token_count: { input_tokens: 12, output_tokens: 5 } } },
    },
  });
}

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (log && m.method)
      fs.appendFileSync(log, `${JSON.stringify({ method: m.method, params: m.params })}\n`);
    if (m.method === undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m.result);
      waiting.delete(m.id);
      continue;
    }
    switch (m.method) {
      case 'initialize':
        send({
          id: m.id,
          result: {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
            agentCapabilities: { loadSession: true },
          },
        });
        break;
      case 'authenticate': {
        const id = m.id;
        setTimeout(
          () => {
            if (process.env.NOMI_MOCK_LOGIN_FAIL === '1')
              return send({ id, error: { code: -32000, message: 'Authentication timed out' } });
            const email = process.env.NOMI_MOCK_LOGIN_EMAIL || 'mock@gmail.com';
            const dir = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
            fs.mkdirSync(dir, { recursive: true });
            const payload = Buffer.from(JSON.stringify({ sub: `g-${email}`, email })).toString(
              'base64url',
            );
            fs.writeFileSync(
              path.join(dir, 'oauth_creds.json'),
              JSON.stringify({
                access_token: `at-${email}`,
                refresh_token: `rt-${email}`,
                id_token: `h.${payload}.s`,
                expiry_date: Date.now() + 3600_000,
              }),
            );
            fs.writeFileSync(
              path.join(dir, 'google_accounts.json'),
              JSON.stringify({ active: email, old: [] }),
            );
            send({ id, result: {} });
          },
          Number(process.env.NOMI_MOCK_LOGIN_MS || 200),
        );
        break;
      }
      case 'session/new': {
        const sessionId = `gem-${randomUUID()}`;
        sessions.add(sessionId);
        send({
          id: m.id,
          result: {
            sessionId,
            modes: {
              currentModeId: 'default',
              availableModes: [{ id: 'default' }, { id: 'yolo' }],
            },
          },
        });
        break;
      }
      case 'session/load':
        if (sessions.has(m.params.sessionId) || m.params.sessionId.startsWith('gem-'))
          send({ id: m.id, result: {} });
        else send({ id: m.id, error: { code: -32603, message: 'session not found' } });
        break;
      case 'session/set_mode':
        send({ id: m.id, result: {} });
        break;
      case 'session/prompt':
        void prompt(m.id, m.params);
        break;
      case 'session/cancel':
        cancelled.add(m.params.sessionId);
        break;
      default:
        if (m.id !== undefined)
          send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
