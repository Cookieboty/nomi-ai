/**
 * 编程助手推送通道（ai:harness:events / tab-message / changed / tabs）的接收方登记。
 *
 * 只有对话窗口（packages/ai-chat）监听这些通道，且它挂载时一定先调 `ai:harness:tabs` /
 * `ai:harness:state`：主进程在任一 ai:harness:* 调用里记下发起方 webContents，推送只发给它们，
 * 看板娘、岛、截图浮层等从不监听的窗口不再为每帧事件 / 每次全量状态付结构化克隆与 IPC 开销。
 * webContents 销毁时自动移除。
 */

/** 用到的 Electron WebContents 子集（便于测试替身） */
export interface SubscriberContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: 'destroyed', listener: () => void): unknown;
}

export class RendererSubscribers {
  private readonly subs = new Map<number, SubscriberContents>();

  /** 记下一个接收方；重复登记同一个 webContents 不会重复挂监听 */
  add(wc: SubscriberContents | null | undefined): void {
    if (!wc || typeof wc.send !== 'function' || this.subs.has(wc.id)) return;
    try {
      if (wc.isDestroyed()) return;
    } catch {
      return;
    }
    this.subs.set(wc.id, wc);
    try {
      wc.once('destroyed', () => {
        if (this.subs.get(wc.id) === wc) this.subs.delete(wc.id);
      });
    } catch {
      /* 拿不到销毁事件时，靠 send 前的 isDestroyed 检查兜底 */
    }
  }

  /** 发给所有仍存活的接收方；已销毁的顺手移除 */
  send(channel: string, payload: unknown): void {
    for (const [id, wc] of this.subs) {
      try {
        if (wc.isDestroyed()) {
          this.subs.delete(id);
          continue;
        }
        wc.send(channel, payload);
      } catch {
        /* */
      }
    }
  }

  get size(): number {
    return this.subs.size;
  }

  clear(): void {
    this.subs.clear();
  }
}
