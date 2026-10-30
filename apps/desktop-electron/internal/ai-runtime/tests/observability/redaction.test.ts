import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SENSITIVE_FIELDS,
  createRedactor,
  redact,
} from '../../src/observability/redaction';

describe('redaction · default sensitive fields', () => {
  it('exports 每一个默认字段（大小写不敏感），且都会被替换为 ***', () => {
    for (const key of DEFAULT_SENSITIVE_FIELDS) {
      const out = redact({ [key]: 'secret-value' }) as Record<string, string>;
      expect(out[key], `field ${key} should be redacted`).toBe('***');
    }
  });

  it('顶层与深层嵌套的 apiKey / authorization / token 都会被脱敏', () => {
    const input = {
      user: 'alice',
      apiKey: 'sk-live-xxx',
      config: {
        provider: {
          authorization: 'Bearer eyJ',
          nested: { token: 'abc' },
        },
      },
      arr: [{ email: 'a@b.com' }, { password: 'p' }],
    };
    const out = redact(input) as {
      user: string;
      apiKey: string;
      config: { provider: { authorization: string; nested: { token: string } } };
      arr: Array<{ email?: string; password?: string }>;
    };
    expect(out.user).toBe('alice');
    expect(out.apiKey).toBe('***');
    expect(out.config.provider.authorization).toBe('***');
    expect(out.config.provider.nested.token).toBe('***');
    expect(out.arr[0]?.email).toBe('***');
    expect(out.arr[1]?.password).toBe('***');
  });

  it('大小写不敏感：API_KEY / Authorization / X-Api-Token 都命中', () => {
    const out = redact({
      API_KEY: 'k',
      Authorization: 'Bearer x',
      apikey: 'k2',
      access_token: 'a',
    }) as Record<string, string>;
    expect(out.API_KEY).toBe('***');
    expect(out.Authorization).toBe('***');
    expect(out.apikey).toBe('***');
    expect(out.access_token).toBe('***');
  });

  it('不修改原对象（deep clone 语义）', () => {
    const input = { apiKey: 'sk', deep: { token: 't' } };
    const out = redact(input);
    expect(out).not.toBe(input);
    expect(input.apiKey).toBe('sk');
    expect(input.deep.token).toBe('t');
    expect((out as { deep: unknown }).deep).not.toBe(input.deep);
  });

  it('循环引用被替换为 [Circular] 而不是栈溢出', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as { name: string; self: unknown };
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('超过最大深度返回 [Truncated]', () => {
    const build = (depth: number): unknown => {
      let cur: unknown = { leaf: 1 };
      for (let i = 0; i < depth; i++) cur = { next: cur };
      return cur;
    };
    const shallowRedactor = createRedactor({ maxDepth: 2 });
    // maxDepth=2 → root(0) 展开，第 1 层展开，第 2 层被截断为 '[Truncated]'
    const out = shallowRedactor(build(6)) as { next: unknown };
    expect(out.next).toEqual({ next: '[Truncated]' });
  });

  it('额外字段：extraKeys 会追加到脱敏列表', () => {
    const redactor = createRedactor({ extraKeys: ['sessionCookie'] });
    const out = redactor({ sessionCookie: 'abc', harmless: 1 }) as Record<string, unknown>;
    expect(out.sessionCookie).toBe('***');
    expect(out.harmless).toBe(1);
  });

  it('自定义 placeholder', () => {
    const out = redact({ apiKey: 'x' }, { placeholder: '<redacted>' }) as { apiKey: string };
    expect(out.apiKey).toBe('<redacted>');
  });

  it('null / undefined / 原始类型直接透传', () => {
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(42)).toBe(42);
    expect(redact('str')).toBe('str');
    expect(redact(true)).toBe(true);
  });

  it('Date / RegExp 不做拆包，原样返回', () => {
    const d = new Date();
    const r = /abc/gi;
    const out = redact({ d, r }) as { d: Date; r: RegExp };
    expect(out.d).toBe(d);
    expect(out.r).toBe(r);
  });

  it('数组顺序 + 结构保持', () => {
    const out = redact([{ apiKey: 'a' }, { name: 'b' }, 3]) as unknown[];
    expect(out).toHaveLength(3);
    expect((out[0] as { apiKey: string }).apiKey).toBe('***');
    expect((out[1] as { name: string }).name).toBe('b');
    expect(out[2]).toBe(3);
  });
});
