/**
 * 三种上游协议的本地 mock（e2e 用）：
 *   openai-chat       GET /v1/models · POST /v1/chat/completions（SSE）
 *   openai-responses  GET /v1/models · POST /v1/responses（SSE）
 *   anthropic         GET /v1/models（x-api-key + anthropic-version）· POST /v1/messages（SSE）
 * 每个请求都记录 path / model / 鉴权头，便于断言「请求真的发到了对的端点和模型」。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockProtocol = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface SeenRequest {
  server: string;
  method: string;
  path: string;
  model?: string;
  auth?: string;
  apiKey?: string;
  anthropicVersion?: string;
  ping: boolean;
  /** 请求里的系统提示（OpenAI 的 system 消息 / Responses 的 instructions / Anthropic 的 system） */
  system?: string;
}

export interface MockLlm {
  name: string;
  protocol: MockProtocol;
  server: Server;
  port: number;
  models: string[];
  seen: SeenRequest[];
  close(): Promise<void>;
}

const sse = (event: string | undefined, data: unknown) =>
  `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((p) => (p as { text?: string }).text ?? '').join('')
      : '';

/** 三种协议里的系统提示，拼成一段 */
function systemText(body: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if (body.system !== undefined) parts.push(textOf(body.system));
  if (typeof body.instructions === 'string') parts.push(body.instructions);
  const msgs = (body.messages ?? body.input) as
    Array<{ role?: string; content?: unknown }> | undefined;
  if (Array.isArray(msgs))
    for (const m of msgs)
      if (m.role === 'system' || m.role === 'developer') parts.push(textOf(m.content));
  const out = parts.filter(Boolean).join('\n');
  return out || undefined;
}

function lastUserText(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? body.input) as
    Array<{ role?: string; content?: unknown }> | undefined;
  const last = [...(msgs ?? [])].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p as { text?: string }).text ?? '').join('');
  return '';
}

export async function startMockLlm(
  name: string,
  protocol: MockProtocol,
  models: string[],
): Promise<MockLlm> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const text = lastUserText(body);
      seen.push({
        server: name,
        method: req.method ?? '',
        path: (req.url ?? '').split('?')[0]!,
        model: body.model as string | undefined,
        auth: req.headers.authorization,
        apiKey: req.headers['x-api-key'] as string | undefined,
        anthropicVersion: req.headers['anthropic-version'] as string | undefined,
        ping: text === 'ping',
        system: systemText(body),
      });
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            protocol === 'anthropic'
              ? {
                  data: models.map((id) => ({ type: 'model', id, display_name: id.toUpperCase() })),
                  has_more: false,
                }
              : {
                  object: 'list',
                  data: models.map((id) => ({ id, object: 'model', owned_by: name })),
                },
          ),
        );
        return;
      }
      const reply = `reply-from-${name}:${String(body.model)}`;
      const stream = body.stream === true;
      if (protocol === 'openai-chat' && url.startsWith('/v1/chat/completions')) {
        const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
        if (!stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: reply }, finish_reason: 'stop' }],
              usage,
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse(undefined, { choices: [{ delta: { content: reply } }] }));
        res.write(sse(undefined, { choices: [{ delta: {}, finish_reason: 'stop' }], usage }));
        res.end('data: [DONE]\n\n');
        return;
      }
      if (protocol === 'openai-responses' && url.startsWith('/v1/responses')) {
        const usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };
        const msg = {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: reply, annotations: [] }],
        };
        if (!stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'resp_1',
              object: 'response',
              created_at: 1,
              model: body.model,
              status: 'completed',
              output: [msg],
              usage,
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const r = {
          id: 'resp_1',
          object: 'response',
          created_at: 1,
          model: body.model,
          status: 'in_progress',
          output: [],
        };
        res.write(
          sse('response.created', { type: 'response.created', sequence_number: 0, response: r }),
        );
        res.write(
          sse('response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: 1,
            output_index: 0,
            item: {
              type: 'message',
              id: 'msg_1',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          }),
        );
        res.write(
          sse('response.output_text.delta', {
            type: 'response.output_text.delta',
            sequence_number: 2,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: reply,
          }),
        );
        res.write(
          sse('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: 3,
            output_index: 0,
            item: msg,
          }),
        );
        res.write(
          sse('response.completed', {
            type: 'response.completed',
            sequence_number: 4,
            response: { ...r, status: 'completed', output: [msg], usage },
          }),
        );
        res.end();
        return;
      }
      if (protocol === 'anthropic' && url.startsWith('/v1/messages')) {
        const usage = { input_tokens: 5, output_tokens: 3 };
        if (!stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{ type: 'text', text: reply }],
              stop_reason: 'end_turn',
              usage,
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          sse('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          }),
        );
        res.write(
          sse('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        );
        res.write(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: reply },
          }),
        );
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
        res.write(
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 3 },
          }),
        );
        res.write(sse('message_stop', { type: 'message_stop' }));
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: `mock ${name}: no route ${req.method} ${url}` } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    name,
    protocol,
    server,
    port,
    models,
    seen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
