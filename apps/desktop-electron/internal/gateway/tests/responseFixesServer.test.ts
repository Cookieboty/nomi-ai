/**
 * 响应修正（§11.3）与工具名映射（§12.7.3）的端到端：真实监听的网关 + 本地假上游。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayConfig, RuntimeProvider } from '../src/config';
import { createGateway, type UsageEvent } from '../src/server';
import { chatToolName } from '../src/toolNames';

type Script = (body: Record<string, unknown>, res: http.ServerResponse) => void;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function upstream(script: Script) {
  const seen: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push(body);
      script(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => server.close());
  return { seen, base: `http://127.0.0.1:${port}`, hostPort: `127.0.0.1:${port}` };
}

const sse = (evs: Array<[string | undefined, unknown]>) =>
  evs
    .map(
      ([e, d]) =>
        `${e ? `event: ${e}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`,
    )
    .join('');

function provider(urls: RuntimeProvider['urls']): RuntimeProvider {
  return {
    id: 'zp',
    name: 'ZP',
    enabled: true,
    urls,
    keys: [{ id: 'k1', value: 'key-1', enabled: true }],
    models: [{ id: 'glm-5', enabled: true }],
  };
}

async function gateway(cfg: Partial<GatewayConfig>, hosts: string[]) {
  const usage: UsageEvent[] = [];
  const gw = createGateway(
    {
      host: '127.0.0.1',
      port: 0,
      providers: [],
      clients: { codex: { token: 'tok-codex', models: { main: 'zp/glm-5' } } },
      allowedPrivateHosts: hosts,
      ...cfg,
    },
    { onUsage: (e) => usage.push(e) },
  );
  await gw.start();
  cleanups.push(() => gw.stop());
  return { usage, url: gw.listenUrl()! };
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok-codex' },
    body: JSON.stringify(body),
  });

function events(text: string) {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '';
      let json: any = data;
      try {
        json = JSON.parse(data);
      } catch {
        /* [DONE] */
      }
      return { ev, data: json };
    });
}

describe('gateway: response fixes (§11.3)', () => {
  it('Codex → Chat upstream: namespaced tool names mapped out and restored back', async () => {
    const mapped = chatToolName('ns.read');
    const up = await upstream((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sse([
          [
            undefined,
            {
              id: 'c1',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index: 0, id: 't1', function: { name: mapped, arguments: '{"p":1}' } },
                    ],
                  },
                },
              ],
            },
          ],
          [undefined, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
          [undefined, '[DONE]'],
        ]),
      );
    });
    const { url, usage } = await gateway({ providers: [provider({ chat: `${up.base}/v1` })] }, [
      up.hostPort,
    ]);
    const res = await post(url, '/v1/responses', {
      model: 'zp/glm-5',
      stream: true,
      input: 'hi',
      tools: [{ type: 'function', name: 'ns.read', parameters: { type: 'object' } }],
    });
    const evs = events(await res.text());
    expect((up.seen[0]!.tools as any)[0].function.name).toBe(mapped);
    const added = evs.find((e) => e.ev === 'response.output_item.added');
    expect(added?.data.item).toMatchObject({ type: 'function_call', name: 'ns.read' });
    expect(usage[0]!.notes).toEqual([
      '1 个工具名已映射为 Chat 接口允许的名字',
      '工具名已按映射还原',
    ]);
  });

  it('same-wire Chat: a repeating model is cut off with an error chunk', async () => {
    const line = '我需要再检查一下这个文件。';
    const up = await upstream((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const evs: Array<[undefined, unknown]> = [];
      for (let i = 0; i < 60; i++)
        evs.push([undefined, { id: 'c1', choices: [{ index: 0, delta: { content: line } }] }]);
      res.end(sse([...evs, [undefined, '[DONE]']]));
    });
    const { url, usage } = await gateway({ providers: [provider({ chat: `${up.base}/v1` })] }, [
      up.hostPort,
    ]);
    const res = await post(url, '/v1/chat/completions', {
      model: 'zp/glm-5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const evs = events(await res.text());
    expect(evs.at(-2)!.data.error.message).toMatch(/重复输出/);
    expect(evs.at(-1)!.data).toBe('[DONE]');
    expect(evs.length).toBeLessThan(50);
    expect(usage[0]!.notes).toContain('检测到模型复读，已中断');
  });

  it('learned customToolsRefused: custom tools sent as functions, calls restored', async () => {
    const up = await upstream((_b, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const item = { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'apply_patch' };
      res.end(
        sse([
          ['response.created', { type: 'response.created', response: { id: 'r1' } }],
          [
            'response.output_item.added',
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { ...item, arguments: '' },
            },
          ],
          [
            'response.function_call_arguments.delta',
            {
              type: 'response.function_call_arguments.delta',
              item_id: 'fc_1',
              output_index: 0,
              delta: '{"input":"PATCH"}',
            },
          ],
          [
            'response.output_item.done',
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: { ...item, arguments: '{"input":"PATCH"}' },
            },
          ],
          [
            'response.completed',
            {
              type: 'response.completed',
              response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 2 } },
            },
          ],
        ]),
      );
    });
    const { url } = await gateway(
      {
        providers: [provider({ responses: `${up.base}/v1` })],
        learned: { zp: { customToolsRefused: ['glm-5'] } },
      },
      [up.hostPort],
    );
    const res = await post(url, '/v1/responses', {
      model: 'zp/glm-5',
      stream: true,
      input: 'hi',
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }],
    });
    const evs = events(await res.text());
    expect((up.seen[0]!.tools as any)[0]).toMatchObject({ type: 'function', name: 'apply_patch' });
    const done = evs.find((e) => e.ev === 'response.output_item.done');
    expect(done?.data.item).toMatchObject({
      type: 'custom_tool_call',
      name: 'apply_patch',
      input: 'PATCH',
    });
  });
});
