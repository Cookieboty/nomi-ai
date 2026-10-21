/**
 * 转换结果快照：请求方向（两两转换的旧接口，内部走 IR）与流式 / 非流式响应方向。
 * 快照在迁移到 IR 时与旧实现逐条核对过；之后改动转换逻辑导致快照变化，要确认是有意的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStreamConverter, jsonToJson, jsonToSse } from '../src/stream';
import * as T from '../src/transforms';

import {
  chatBodies,
  messagesBodies,
  responsesBodies,
  upstreamJson,
  upstreamSse,
} from './fixtures/cases';

const requestCases: Array<[keyof typeof T, unknown[]]> = [
  ['messagesToChatCompletions', messagesBodies],
  ['messagesToResponses', messagesBodies],
  ['messagesToGemini', messagesBodies],
  ['responsesToMessages', responsesBodies],
  ['responsesToChatCompletions', responsesBodies],
  ['chatCompletionsToMessages', chatBodies],
  ['chatCompletionsToResponses', chatBodies],
];

describe('request conversion snapshots', () => {
  for (const [fn, bodies] of requestCases) {
    bodies.forEach((b, i) => {
      it(`${fn} #${i}`, () => {
        const f = T[fn] as (b: unknown, m?: string) => unknown;
        expect({ asIs: f(b), withModel: f(b, 'up-model') }).toMatchSnapshot();
      });
    });
  }
});

const TO = ['messages', 'responses', 'chat', 'gemini'] as const;
const opts = { model: 'fallback', customTools: new Set(['apply_patch']) };

describe('response conversion snapshots', () => {
  beforeEach(() => {
    // 编码器生成的 id 带时间与随机数，固定下来才能做快照
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456);
  });
  afterEach(() => vi.restoreAllMocks());

  for (const from of Object.keys(upstreamSse) as Array<keyof typeof upstreamSse>) {
    upstreamSse[from]!.forEach((text, i) => {
      for (const to of TO) {
        it(`stream ${from}#${i} → ${to}`, () => {
          const whole = createStreamConverter(from as never, to, opts);
          const expected = whole.push(text) + whole.end();
          // 任意切分上游分片，结果都一样
          const c = createStreamConverter(from as never, to, opts);
          let split = '';
          for (let k = 0; k < text.length; k += 7) split += c.push(text.slice(k, k + 7));
          expect(split + c.end()).toBe(expected);
          expect(expected).toMatchSnapshot();
        });
      }
    });
    upstreamJson[from]!.forEach((body, i) => {
      for (const to of TO) {
        it(`json ${from}#${i} → ${to}`, () => {
          expect({
            sse: jsonToSse(from as never, to, body, opts),
            json: jsonToJson(from as never, to, body, opts),
          }).toMatchSnapshot();
        });
      }
    });
  }
});
