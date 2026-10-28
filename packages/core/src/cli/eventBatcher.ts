/**
 * 把高频的 harness 实时事件（流式 text-delta / 工具事件）按帧合批后再发给渲染进程：
 * 一轮里可能有上万个事件，逐个 `webContents.send` 会让每个窗口（含看板娘）都做一遍结构化克隆与调度。
 * 相邻的同标签 text-delta / thinking 片段在队列里直接拼接；其它事件保持原有顺序。
 */
export interface BatchableEvent {
  type: string;
  tabId: string;
}

export class EventBatcher<T extends BatchableEvent> {
  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: (batch: T[]) => void,
    private readonly intervalMs = 16,
  ) {}

  push(ev: T): void {
    const last = this.queue[this.queue.length - 1] as (T & { text?: unknown }) | undefined;
    const text = (ev as T & { text?: unknown }).text;
    if (
      last &&
      last.tabId === ev.tabId &&
      last.type === ev.type &&
      (ev.type === 'text-delta' || ev.type === 'thinking') &&
      typeof last.text === 'string' &&
      typeof text === 'string'
    ) {
      this.queue[this.queue.length - 1] = { ...last, text: last.text + text };
    } else {
      this.queue.push(ev);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
      // 不阻止进程退出
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** 立刻发出队列里的事件（其它通道的消息发送前调用，保证事件顺序） */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    this.sink(batch);
  }

  get pending(): number {
    return this.queue.length;
  }

  dispose(): void {
    this.flush();
  }
}
