/**
 * 丢掉没有工具名的工具调用（四种上游协议共用，接在解码之后、修正与编码之前）。
 * 上游偶尔给出只有参数、始终没有工具名的调用（中转站拼流出错等）：原样转下去，客户端 SDK 会整轮报错
 * （AI SDK：Expected 'function.name' to be a string.），这个调用也执行不了。丢掉它和它的参数；
 * 这一轮因此一个调用都不剩时，停止原因 tool_use 改成 end_turn。
 */
import type { NormEvent } from './events';

export class NamelessToolGuard {
  private readonly dropped = new Set<string>();
  private kept = false;

  /** null = 丢掉这个事件 */
  push(n: NormEvent): NormEvent | null {
    switch (n.type) {
      case 'tool_start':
        if (n.name) {
          this.kept = true;
          return n;
        }
        this.dropped.add(n.key);
        return null;
      case 'tool_args':
      case 'tool_end':
        return this.dropped.has(n.key) ? null : n;
      case 'finish':
        return this.dropped.size && !this.kept && n.reason === 'tool_use'
          ? { ...n, reason: 'end_turn' }
          : n;
      default:
        return n;
    }
  }
}

/** 整段事件（非流式）：同 NamelessToolGuard */
export function dropNamelessTools(evs: NormEvent[]): NormEvent[] {
  const g = new NamelessToolGuard();
  const out: NormEvent[] = [];
  for (const n of evs) {
    const r = g.push(n);
    if (r) out.push(r);
  }
  return out;
}
