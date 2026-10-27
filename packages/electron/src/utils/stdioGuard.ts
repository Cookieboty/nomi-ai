/**
 * 控制台输出断开时不当作崩溃：终端被关掉（Ctrl+C 结束 pnpm dev、关掉终端窗口、管道的读端先退出）后，
 * stdout / stderr 变成断开的伪终端或管道，之后的日志输出会异步报 EIO / EPIPE。
 * 流上没有 'error' 监听时这会变成 uncaughtException，弹出「应用遇到了严重错误」。
 * 日志照常写进文件，控制台这一路直接丢弃；其它错误照旧抛出。
 */
const BROKEN_STDIO = new Set(['EIO', 'EPIPE', 'ERR_STREAM_DESTROYED']);

export function isBrokenStdioError(err: unknown): boolean {
  return BROKEN_STDIO.has((err as NodeJS.ErrnoException | undefined)?.code ?? '');
}

export function guardStdio(streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const s of streams) {
    s.on('error', (err) => {
      if (!isBrokenStdioError(err)) throw err;
    });
  }
}
