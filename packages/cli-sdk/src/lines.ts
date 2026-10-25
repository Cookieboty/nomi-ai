/**
 * 按换行增量切分子进程输出。没有换行的分片先存起来、出现换行时才拼接：一行几 MB 的 JSON
 * （大文件的工具结果、图片）分几十片到达时，不再每片都把整段缓冲拼一次、从头 split 一遍（O(n²)）。
 */
export class LineSplitter {
  private parts: string[] = [];

  /** 推入一段输出，返回新凑齐的整行（不含换行符；CRLF 一并去掉） */
  push(chunk: string): string[] {
    if (!chunk) return [];
    if (!chunk.includes('\n')) {
      this.parts.push(chunk);
      return [];
    }
    const text = this.parts.length ? this.parts.join('') + chunk : chunk;
    const lines = text.split(/\r?\n/);
    const rest = lines.pop() ?? '';
    this.parts = rest ? [rest] : [];
    return lines;
  }

  /** 取走最后一段没有换行的残留并清空 */
  take(): string {
    const rest = this.parts.join('');
    this.parts = [];
    return rest;
  }
}
