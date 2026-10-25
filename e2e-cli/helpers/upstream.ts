/**
 * 脚本化的假上游：按场景输出各种不规范的流，记录收到的每个请求（路径、模型、请求体）。
 * 只监听 127.0.0.1，随测试结束关闭。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  method: string;
  url: string;
  model?: string;
  body: Record<string, unknown>;
}

/** 一个场景：给定请求，返回要写出的 SSE 事件（已序列化）或一个 HTTP 错误 */
export type Scenario = (req: SeenRequest) => { status?: number; sse?: string[]; json?: unknown };

export interface FakeUpstream {
  base: string;
  hostPort: string;
  seen: SeenRequest[];
  setScenario(s: Scenario): void;
  close(): Promise<void>;
}

export async function startUpstream(initial: Scenario): Promise<FakeUpstream> {
  let scenario = initial;
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        /* 非 JSON 请求体按空处理 */
      }
      const s: SeenRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '',
        model: typeof body.model === 'string' ? body.model : undefined,
        body,
      };
      seen.push(s);
      if (s.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      const out = scenario(s);
      if (out.status && out.status >= 400) {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json ?? { error: { message: 'scenario error' } }));
        return;
      }
      if (out.json !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const ev of out.sse ?? []) res.write(ev);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hostPort: `127.0.0.1:${port}`,
    seen,
    setScenario: (s) => (scenario = s),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/* ----------------------------- Responses 事件构造 ----------------------------- */

export const sseEvent = (o: Record<string, unknown>) =>
  `event: ${String(o.type)}\ndata: ${JSON.stringify(o)}\n\n`;

export interface ResponsesDefects {
  /** 中转站伪装成正文增量的保活（无序号） */
  keepAlive?: boolean;
  /** response 对象缺 model / output（实测 amux） */
  bareResponse?: boolean;
  /** reasoning 条目缺 summary */
  reasoningNoSummary?: boolean;
  /** 自定义事件 response.metadata */
  metadataEvent?: boolean;
  /** 不发 response.completed 就断开 */
  cutBeforeCompleted?: boolean;
  /** 只在 output_item.done / completed 里给完整正文，没有增量 */
  wholeItemsOnly?: boolean;
  /** 增量事件缺 item_id / output_index / content_index */
  bareDeltas?: boolean;
  /** 事件不带 sequence_number */
  noSequence?: boolean;
}

/** 生成一段回复 `text` 的 Responses 流，按 defects 注入毛病 */
export function responsesStream(text: string, d: ResponsesDefects = {}): string[] {
  let seq = 0;
  const ev = (o: Record<string, unknown>) =>
    sseEvent(d.noSequence ? o : { ...o, sequence_number: seq++ });
  const resp = (status: string, extra: Record<string, unknown> = {}) =>
    d.bareResponse
      ? { id: 'resp_0', object: 'response', status, created_at: 1792770018, ...extra }
      : {
          id: 'resp_0',
          object: 'response',
          status,
          created_at: 1792770018,
          model: 'm',
          output: [],
          ...extra,
        };
  const keep = sseEvent({
    type: 'response.output_text.delta',
    item_id: 'SSE-Keep-Alive',
    output_index: 0,
    content_index: 0,
    delta: '',
    'SSE-Keep-Alive': true,
  });
  const msg = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const out: string[] = [ev({ type: 'response.created', response: resp('in_progress') })];
  if (d.keepAlive) out.push(keep);
  if (d.reasoningNoSummary) {
    out.push(
      ev({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      }),
    );
    out.push(
      ev({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', status: 'completed' },
      }),
    );
  }
  const oi = d.reasoningNoSummary ? 1 : 0;
  if (d.wholeItemsOnly) {
    out.push(ev({ type: 'response.output_item.done', output_index: oi, item: msg }));
  } else {
    out.push(
      ev({
        type: 'response.output_item.added',
        output_index: oi,
        item: { ...msg, status: 'in_progress', content: [] },
      }),
    );
    if (d.keepAlive) out.push(keep);
    out.push(
      ev(
        d.bareDeltas
          ? { type: 'response.output_text.delta', delta: text }
          : {
              type: 'response.output_text.delta',
              item_id: 'msg_1',
              output_index: oi,
              content_index: 0,
              delta: text,
            },
      ),
    );
    out.push(ev({ type: 'response.output_item.done', output_index: oi, item: msg }));
  }
  if (d.metadataEvent) out.push(ev({ type: 'response.metadata', metadata: { provider: 'x' } }));
  if (d.cutBeforeCompleted) return out;
  out.push(
    ev({
      type: 'response.completed',
      response: resp('completed', {
        output: d.bareResponse ? [] : [msg],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    }),
  );
  return out;
}

/** Messages 流（Claude Code 同协议上游时用） */
export function messagesStream(text: string, o: { cut?: boolean } = {}): string[] {
  const out = [
    sseEvent({
      type: 'message_start',
      message: {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'm',
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  ];
  if (o.cut) return out;
  out.push(
    sseEvent({ type: 'content_block_stop', index: 0 }),
    sseEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
    sseEvent({ type: 'message_stop' }),
  );
  return out;
}
