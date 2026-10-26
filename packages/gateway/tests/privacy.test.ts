/**
 * 密钥脱敏（docs/design/secret-privacy.md）：规则、已见值、按路径遍历、回程还原。
 */
import { describe, expect, it } from 'vitest';

import {
  allowTagOf,
  GatewayPrivacy,
  maskBody,
  maskText,
  PLACEHOLDER_RE,
  Restorer,
  ruleSpans,
  SecretStore,
} from '../src/privacy';

const KEY = 'test-key';
const OPENAI = 'sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv';
const GITHUB = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7';
const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1b2c3\nqrs+tuv/w==\n-----END RSA PRIVATE KEY-----';

function store(known: Array<{ kind: string; value: string }> = []) {
  const s = new SecretStore();
  s.setKey(KEY);
  s.setKnown(known);
  return s;
}

const values = (s: string) => ruleSpans(s).map((sp) => s.slice(sp.start, sp.end));
/** 去掉占位符再查子串：随机后缀可能碰巧拼出被查的子串 */
const plain = (s: string) => s.replace(PLACEHOLDER_RE, '');

describe('规则', () => {
  it('认得常见格式', () => {
    expect(values(`key=${OPENAI}`)).toEqual([OPENAI]);
    expect(values(`token ${GITHUB} end`)).toEqual([GITHUB]);
    expect(values('AKIAIOSFODNN7EXAMPLE')).toEqual(['AKIAIOSFODNN7EXAMPLE']);
    expect(values(`x ${PEM} y`)).toEqual([PEM]);
    expect(values('Authorization: Bearer abcd1234efgh5678ijkl')).toEqual(['abcd1234efgh5678ijkl']);
    expect(values('postgres://admin:S3cretPw@db.example.com/app')).toEqual(['S3cretPw']);
    expect(values('nomi-gw-AbCdEf123456')).toEqual(['nomi-gw-AbCdEf123456']);
  });

  it('不误伤', () => {
    // 长单词中间的片段、示例值、模板、id
    expect(values('task-sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv')).toEqual([]);
    expect(values('Bearer YOUR_API_KEY_HERE_PLEASE')).toEqual([]);
    expect(values('postgres://user:password@localhost/db')).toEqual([]);
    expect(values('postgres://user:${DB_PASS}@localhost/db')).toEqual([]);
    expect(values('commit 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39')).toEqual([]);
    expect(values('id 123e4567-e89b-12d3-a456-426614174000')).toEqual([]);
    expect(values('integrity sha512-AbCdEf0123456789')).toEqual([]);
  });

  it('严格档默认关', () => {
    const s = 'DB_PASSWORD=Xk29vLq8Zr4mWp7t';
    expect(ruleSpans(s)).toEqual([]);
    expect(ruleSpans(s, { strict: true }).map((sp) => s.slice(sp.start, sp.end))).toEqual([
      'Xk29vLq8Zr4mWp7t',
    ]);
    expect(ruleSpans('next_page_token=Xk29vLq8Zr4mWp7t', { strict: true })).toEqual([]);
  });
});

describe('占位符与已见值', () => {
  it('同一个值总是同一个占位符', () => {
    const a = maskText(`k ${OPENAI}`, store(), { key: KEY });
    const b = maskText(`again ${OPENAI}`, store(), { key: KEY });
    expect(a.text).toMatch(/^k \{\{API_KEY_[a-z2-7]{8}\}\}$/);
    expect(a.hits[0]!.placeholder).toBe(b.hits[0]!.placeholder);
    expect(a.hits[0]).toMatchObject({ kind: 'API_KEY', len: OPENAI.length, head: 'sk-p' });
  });

  it('遮过一次的值，之后没有上下文也认得', () => {
    const s = store();
    const first = maskText('DB_PASSWORD=Xk29vLq8Zr4mWp7t', s, { key: KEY, strict: true });
    const p = first.hits[0]!.placeholder;
    // 第二轮：模型说「密码是 …」，还原后作为历史发回来，前后没有 password=
    const second = maskText('密码是 Xk29vLq8Zr4mWp7t，写进 config', s, { key: KEY });
    expect(second.text).toBe(`密码是 ${p}，写进 config`);
  });

  it('已知原文（配置里的 Key）不靠格式也认得', () => {
    const r = maskText(
      'my key is plainKeyValue99',
      store([{ kind: 'API_KEY', value: 'plainKeyValue99' }]),
      {
        key: KEY,
      },
    );
    expect(plain(r.text)).not.toContain('plainKeyValue99');
  });

  it('从不脱敏名单', () => {
    const r = maskText(`k ${OPENAI}`, store(), {
      key: KEY,
      allow: new Set([allowTagOf(KEY, OPENAI)]),
    });
    expect(r.text).toBe(`k ${OPENAI}`);
  });

  it('按类型的动作：提醒原样发出，拦截标记 blocked', () => {
    const warn = maskText(`k ${OPENAI}`, store(), { key: KEY, actions: { API_KEY: 'warn' } });
    expect(warn.text).toBe(`k ${OPENAI}`);
    expect(warn.hits[0]!.action).toBe('warn');
    const block = maskText(`k ${OPENAI}`, store(), { key: KEY, actions: { API_KEY: 'block' } });
    expect(block.blocked).toBe(true);
    expect(block.text).not.toContain(OPENAI);
  });
});

describe('按路径遍历', () => {
  it('未命中时返回原对象', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'hello world' }] };
    expect(maskBody(body, store(), { key: KEY }).body).toBe(body);
  });

  it('协议字段、id、签名、媒体不动，正文照遮', () => {
    const body = {
      model: OPENAI,
      metadata: { user_id: OPENAI },
      messages: [
        { role: 'user', content: [{ type: 'text', text: `use ${OPENAI}` }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: `saw ${OPENAI}`, signature: 'sig' },
            { type: 'tool_use', id: OPENAI, name: 'bash', input: { cmd: `curl -H ${OPENAI}` } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: OPENAI, content: `OPENAI_KEY=${OPENAI}` },
            { type: 'image', source: { type: 'base64', data: `data${OPENAI}` } },
          ],
        },
      ],
    };
    const out = maskBody(body, store(), { key: KEY }).body as typeof body;
    expect(out.model).toBe(OPENAI);
    expect(out.metadata.user_id).toBe(OPENAI);
    const [u, a, t] = out.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(plain(u!.content[0]!.text as string)).toBe('use ');
    expect(a!.content[0]).toBe(body.messages[1]!.content[0]); // thinking 整块不动
    expect(a!.content[1]!.id).toBe(OPENAI);
    expect(plain(JSON.stringify(a!.content[1]!.input))).not.toContain(OPENAI);
    expect(t!.content[0]!.tool_use_id).toBe(OPENAI);
    expect(plain(t!.content[0]!.content as string)).toBe('OPENAI_KEY=');
    expect(t!.content[1]).toBe(body.messages[2]!.content[1]);
  });

  it('工具参数里的键名不豁免（magpie 7137feb4 的坑）', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'http',
              input: { signature: OPENAI, user_id: OPENAI, name: OPENAI },
            },
          ],
        },
      ],
    };
    const out = JSON.stringify(maskBody(body, store(), { key: KEY }).body);
    expect(plain(out)).not.toContain(OPENAI);
  });

  it('Chat / Responses 的 arguments 字符串照遮，结果仍是合法 JSON', () => {
    const args = JSON.stringify({ key: PEM, note: 'x' });
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: args } }],
        },
      ],
      input: [{ type: 'function_call', call_id: 'c2', name: 'w', arguments: args }],
    };
    const r = maskBody(body, store(), { key: KEY });
    const out = r.body as {
      messages: Array<{ tool_calls: Array<{ function: { arguments: string } }> }>;
      input: Array<{ arguments: string }>;
    };
    const a1 = JSON.parse(out.messages[0]!.tool_calls[0]!.function.arguments) as { key: string };
    expect(a1.key).toMatch(/^\{\{PRIVATE_KEY_[a-z2-7]{8}\}\}$/);
    expect(JSON.parse(out.input[0]!.arguments)).toEqual(a1 && { key: a1.key, note: 'x' });
    // 登记的是反转义后的原文（带真换行）
    expect([...r.restore.values()]).toEqual([PEM]);
  });

  it('工具定义只遮 description', () => {
    const body = {
      tools: [
        {
          name: OPENAI,
          description: `uses ${OPENAI}`,
          input_schema: { type: 'object', properties: { [OPENAI]: { enum: [OPENAI] } } },
        },
      ],
    };
    const out = maskBody(body, store(), { key: KEY }).body as typeof body;
    const t = out.tools[0]!;
    expect(t.name).toBe(OPENAI);
    expect(plain(t.description)).toBe('uses ');
    expect(t.input_schema).toBe(body.tools[0]!.input_schema);
  });

  it('Gemini：思考片段不动，functionCall.args 照遮', () => {
    const body = {
      contents: [
        {
          role: 'model',
          parts: [
            { text: `t ${OPENAI}`, thought: true, thoughtSignature: 'sig' },
            { functionCall: { name: 'f', args: { k: OPENAI } } },
          ],
        },
      ],
    };
    const out = maskBody(body, store(), { key: KEY }).body as typeof body;
    expect(out.contents[0]!.parts[0]).toBe(body.contents[0]!.parts[0]);
    expect(plain(JSON.stringify(out.contents[0]!.parts[1]))).not.toContain(OPENAI);
  });

  it('确定：同一请求扫两次结果相同', () => {
    const body = { messages: [{ role: 'user', content: `a ${OPENAI} b ${GITHUB}` }] };
    const s = store();
    expect(JSON.stringify(maskBody(body, s, { key: KEY }).body)).toBe(
      JSON.stringify(maskBody(body, store(), { key: KEY }).body),
    );
  });
});

describe('回程还原', () => {
  const setup = () => {
    const r = maskText(`${OPENAI} ${PEM}`, store(), { key: KEY });
    const [p1, p2] = r.hits.map((h) => h.placeholder) as [string, string];
    return { map: r.restore, p1, p2 };
  };

  const sse = (evs: unknown[]) => evs.map((d) => `data: ${JSON.stringify(d)}\n\n`).join('');
  const datas = (text: string) =>
    text
      .split('\n\n')
      .filter(Boolean)
      .map((b) => /^data: (.*)$/m.exec(b)![1]!)
      .map((d) => (d.startsWith('{') ? JSON.parse(d) : d));

  it('完整的占位符', () => {
    const { map, p1 } = setup();
    const r = new Restorer(map);
    expect(r.text(`key ${p1}`)).toBe(`key ${OPENAI}`);
    expect(r.text('{{API_KEY_zzzzzzzz}}')).toBe('{{API_KEY_zzzzzzzz}}');
    expect(r.counts.get(p1)).toBe(1);
  });

  it('跨两个、三个增量的占位符拼完整再还原，文本不增不减', () => {
    const { map, p1 } = setup();
    for (const cuts of [[6], [2, 9], [1, 3, 15]]) {
      const parts: string[] = [];
      let at = 0;
      const text = `hi ${p1} ok`;
      for (const c of cuts) {
        parts.push(text.slice(at, 3 + c));
        at = 3 + c;
      }
      parts.push(text.slice(at));
      const r = new Restorer(map);
      const out =
        r.push(
          sse(
            parts.map((t) => ({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: t },
            })),
          ),
        ) + r.end();
      const joined = datas(out)
        .map((d) => (d as { delta: { text: string } }).delta.text)
        .join('');
      expect(joined).toBe(`hi ${OPENAI} ok`);
    }
  });

  it('扣住的尾巴后面跟的是另一段文本：原样放出', () => {
    const { map } = setup();
    const r = new Restorer(map);
    const out =
      r.push(
        sse([
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a {{API' } },
          { type: 'content_block_stop', index: 0 },
        ]),
      ) + r.end();
    expect(datas(out)[0]).toMatchObject({ delta: { text: 'a {{API' } });
    expect(datas(out)).toHaveLength(2);
  });

  it('工具参数增量里的值按 JSON 再转义一层', () => {
    const { map, p2 } = setup();
    const r = new Restorer(map);
    const out =
      r.push(
        sse([
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: `{"k":"${p2.slice(0, 5)}` },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: `${p2.slice(5)}"}` },
          },
        ]),
      ) + r.end();
    const json = datas(out)
      .map((d) => (d as { delta: { partial_json: string } }).delta.partial_json)
      .join('');
    expect(JSON.parse(json)).toEqual({ k: PEM });
  });

  it('Chat 工具调用参数与 [DONE]', () => {
    const { map, p1 } = setup();
    const r = new Restorer(map);
    const out =
      r.push(
        sse([
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: `{"k":"${p1}"}` } }] },
              },
            ],
          },
        ]) + 'data: [DONE]\n\n',
      ) + r.end();
    const [first, done] = datas(out) as [
      { choices: Array<{ delta: { tool_calls: Array<{ function: { arguments: string } }> } }> },
      string,
    ];
    expect(JSON.parse(first.choices[0]!.delta.tool_calls[0]!.function.arguments)).toEqual({
      k: OPENAI,
    });
    expect(done).toBe('[DONE]');
  });

  it('事件被切在任意字节处也能还原', () => {
    const { map, p1 } = setup();
    const text = sse([
      { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: `x ${p1}` },
    ]);
    for (let cut = 1; cut < text.length; cut += 7) {
      const r = new Restorer(map);
      const out = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.end();
      expect((datas(out)[0] as { delta: string }).delta).toBe(`x ${OPENAI}`);
    }
  });

  it('非流式 JSON', () => {
    const { map, p1 } = setup();
    const r = new Restorer(map);
    expect(
      r.json({
        content: [{ type: 'tool_use', input: { k: p1 } }],
        choices: [{ message: { tool_calls: [{ function: { arguments: `{"k":"${p1}"}` } }] } }],
      }),
    ).toEqual({
      content: [{ type: 'tool_use', input: { k: OPENAI } }],
      choices: [
        { message: { tool_calls: [{ function: { arguments: JSON.stringify({ k: OPENAI }) } }] } },
      ],
    });
  });
});

describe('GatewayPrivacy', () => {
  it('关掉时清空已见值', () => {
    const g = new GatewayPrivacy();
    const cfg = {
      host: '',
      port: 0,
      providers: [],
      clients: {},
      privacy: { enabled: true, key: KEY },
    };
    g.configure(cfg);
    g.mask(cfg, { messages: [{ role: 'user', content: OPENAI }] });
    expect(g.store.size).toBe(1);
    g.configure({ ...cfg, privacy: { enabled: false, key: KEY } });
    expect(g.store.size).toBe(0);
  });
});
