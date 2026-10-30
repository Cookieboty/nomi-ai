import { describe, expect, it, vi } from 'vitest';

import type { LogRecord, LogSink } from '../../src/observability/logger';
import {
  LOG_LEVELS,
  createStructuredLogger,
  toRuntimeLoggerAdapter,
} from '../../src/observability/logger';

function createCollector(): { records: LogRecord[]; sink: LogSink } {
  const records: LogRecord[] = [];
  return { records, sink: (r) => records.push(r) };
}

describe('StructuredLogger', () => {
  it('每条日志都是结构化 record（ts/level/msg + bindings）', () => {
    const { records, sink } = createCollector();
    const log = createStructuredLogger({ sink, now: () => '2026-09-02T00:00:00.000Z' });
    log.info('hello', { foo: 'bar' });
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.ts).toBe('2026-09-02T00:00:00.000Z');
    expect(r.level).toBe('info');
    expect(r.msg).toBe('hello');
    expect(r.bindings).toEqual({});
    expect(r.meta).toEqual({ foo: 'bar' });
  });

  it('低于 level 的调用被短路（不出现在 sink 里）', () => {
    const { records, sink } = createCollector();
    const log = createStructuredLogger({ sink, level: 'warn' });
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    expect(records.map((r) => r.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('isLevelEnabled 按阈值判断', () => {
    const log = createStructuredLogger({ level: 'info', sink: () => {} });
    expect(log.isLevelEnabled('info')).toBe(true);
    expect(log.isLevelEnabled('warn')).toBe(true);
    expect(log.isLevelEnabled('debug')).toBe(false);
    expect(log.isLevelEnabled('trace')).toBe(false);
  });

  it('meta 里的敏感字段被 redact', () => {
    const { records, sink } = createCollector();
    const log = createStructuredLogger({ sink });
    log.info('req', {
      user: 'alice',
      headers: { Authorization: 'Bearer xxx' },
      apiKey: 'sk-live',
    });
    expect(records[0]!.meta).toEqual({
      user: 'alice',
      headers: { Authorization: '***' },
      apiKey: '***',
    });
  });

  it('Error 参数被序列化为 err 字段（保留 name/message/stack/code）', () => {
    const { records, sink } = createCollector();
    const log = createStructuredLogger({ sink });
    const err = Object.assign(new Error('boom'), { code: 'E_TIMEOUT' });
    log.error('boom happened', err);
    expect(records[0]!.err).toMatchObject({
      name: 'Error',
      message: 'boom',
      code: 'E_TIMEOUT',
    });
    expect(records[0]!.err?.stack).toBeTypeOf('string');
    expect(records[0]!.meta).toBeUndefined();
  });

  it('meta.err 为 Error 时会被拆到顶层 err 字段', () => {
    const { records, sink } = createCollector();
    const log = createStructuredLogger({ sink });
    log.error('wrapped', {
      requestId: 'r-1',
      err: new Error('inner'),
    });
    expect(records[0]!.err?.message).toBe('inner');
    expect(records[0]!.meta).toEqual({ requestId: 'r-1' });
  });

  it('child(bindings) 派生 logger 并沿链合并（后写覆盖）', () => {
    const { records, sink } = createCollector();
    const root = createStructuredLogger({ sink, bindings: { app: 'ai-runtime' } });
    const sess = root.child({ sessionId: 's1' });
    const turn = sess.child({ turnId: 't1' });
    turn.info('step');
    expect(records[0]!.bindings).toEqual({ app: 'ai-runtime', sessionId: 's1', turnId: 't1' });
  });

  it('child 派生的 logger 不影响父 logger 的 bindings', () => {
    const { records, sink } = createCollector();
    const root = createStructuredLogger({ sink, bindings: { app: 'a' } });
    const c = root.child({ sessionId: 's' });
    c.info('c');
    root.info('r');
    expect(records[0]!.bindings).toEqual({ app: 'a', sessionId: 's' });
    expect(records[1]!.bindings).toEqual({ app: 'a' });
  });

  it('sink 抛错不阻塞调用方（走 console.error 兜底）', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createStructuredLogger({
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => log.info('ok')).not.toThrow();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('LOG_LEVELS 包含全部 6 个级别', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });
});

describe('toRuntimeLoggerAdapter', () => {
  it('单参数 msg 走对应级别', () => {
    const { records, sink } = createCollector();
    const adapter = toRuntimeLoggerAdapter(createStructuredLogger({ sink }));
    adapter.info('hello');
    adapter.warn('careful');
    adapter.error('oops');
    expect(records.map((r) => [r.level, r.msg])).toEqual([
      ['info', 'hello'],
      ['warn', 'careful'],
      ['error', 'oops'],
    ]);
  });

  it('单参数 Error 被拆到 err 字段', () => {
    const { records, sink } = createCollector();
    const adapter = toRuntimeLoggerAdapter(createStructuredLogger({ sink }));
    adapter.error('boom', new Error('detail'));
    expect(records[0]!.err?.message).toBe('detail');
  });

  it('单个对象 meta 直接透传给 structured logger', () => {
    const { records, sink } = createCollector();
    const adapter = toRuntimeLoggerAdapter(createStructuredLogger({ sink }));
    adapter.info('req', { userId: 'u1', apiKey: 'sk' });
    expect(records[0]!.meta).toEqual({ userId: 'u1', apiKey: '***' });
  });

  it('多余参数被 packaged 到 meta.args', () => {
    const { records, sink } = createCollector();
    const adapter = toRuntimeLoggerAdapter(createStructuredLogger({ sink }));
    adapter.info('multi', 'a', 'b', 42);
    expect(records[0]!.meta).toEqual({ args: ['a', 'b', 42] });
  });
});
