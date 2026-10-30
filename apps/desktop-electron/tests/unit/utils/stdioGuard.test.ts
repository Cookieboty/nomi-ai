import { EventEmitter } from 'events';

import { guardStdio, isBrokenStdioError } from '../../../src/utils/stdioGuard';

const err = (code: string) => Object.assign(new Error(`write ${code}`), { code });

describe('stdio guard（终端断开后的控制台写入失败不算崩溃）', () => {
  it('EIO / EPIPE / 已销毁的流被吞掉，其它错误照旧抛出', () => {
    const out = new EventEmitter();
    guardStdio([out as unknown as NodeJS.WriteStream]);
    expect(() => out.emit('error', err('EIO'))).not.toThrow();
    expect(() => out.emit('error', err('EPIPE'))).not.toThrow();
    expect(() => out.emit('error', err('ERR_STREAM_DESTROYED'))).not.toThrow();
    expect(() => out.emit('error', err('ENOSPC'))).toThrow('write ENOSPC');
  });

  it('isBrokenStdioError 只认这几种代码', () => {
    expect(isBrokenStdioError(err('EIO'))).toBe(true);
    expect(isBrokenStdioError(new Error('write EIO'))).toBe(false);
    expect(isBrokenStdioError(undefined)).toBe(false);
  });
});
