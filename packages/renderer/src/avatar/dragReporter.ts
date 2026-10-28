/**
 * 看板娘拖拽上报（契约 `mascot.dragStart` / `dragMove` / `dragEnd`）。
 *
 * 原来是单向 IPC 消息；现在每次上报是一次完整的契约往返（请求帧、入参校验、中间件、响应帧）。
 * 指针事件的频率可以远高于屏幕刷新，这里把它们收敛：
 * - 严格按调用顺序串行发送：上一条的回应到了才发下一条，start → move → end 不会乱序；
 * - move 合并：还没发出去的 move 只保留最新坐标；每帧最多发一条 move（`schedule`，默认 rAF），
 *   后面排着 start / end 时立即发；
 * - 失败不影响交互（原来就是即发即弃），也不阻塞后面的上报。
 */

export interface DragPoint {
  screenX: number;
  screenY: number;
}

export interface DragSink {
  dragStart(p: DragPoint): Promise<unknown>;
  dragMove(p: DragPoint): Promise<unknown>;
  dragEnd(): Promise<unknown>;
}

export interface DragReporter {
  start(p: DragPoint): void;
  move(p: DragPoint): void;
  /** 卸载时也照常调用：队列会发完，主进程不会停在拖拽状态 */
  end(): void;
}

type Op = { kind: 'start'; p: DragPoint } | { kind: 'move'; p: DragPoint } | { kind: 'end' };

const defaultSchedule = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
};

export function createDragReporter(
  sink: DragSink,
  schedule: (fn: () => void) => void = defaultSchedule,
): DragReporter {
  const queue: Op[] = [];
  let busy = false;
  /** 本帧还能发一条 move */
  let frameReady = true;
  let frameRequested = false;

  const send = (op: Op): Promise<unknown> => {
    if (op.kind === 'start') return sink.dragStart(op.p);
    if (op.kind === 'move') return sink.dragMove(op.p);
    return sink.dragEnd();
  };

  const pump = (): void => {
    if (busy || queue.length === 0) return;
    const head = queue[0]!;
    // 后面排着 start / end 时不等帧：窗口隐藏后 rAF 可能不再触发，dragEnd 不能卡在 move 后面
    if (head.kind === 'move' && !frameReady && queue.length === 1) {
      if (!frameRequested) {
        frameRequested = true;
        schedule(() => {
          frameRequested = false;
          frameReady = true;
          pump();
        });
      }
      return;
    }
    queue.shift();
    if (head.kind === 'move') frameReady = false;
    busy = true;
    let p: Promise<unknown>;
    try {
      p = send(head);
    } catch (error) {
      p = Promise.reject(error);
    }
    void p
      .catch(() => undefined)
      .then(() => {
        busy = false;
        pump();
      });
  };

  return {
    start(p) {
      queue.push({ kind: 'start', p });
      pump();
    },
    move(p) {
      const last = queue[queue.length - 1];
      // 还没发出去的 move 只留最新坐标
      if (last?.kind === 'move') last.p = p;
      else queue.push({ kind: 'move', p });
      pump();
    },
    end() {
      queue.push({ kind: 'end' });
      pump();
    },
  };
}
