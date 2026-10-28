/**
 * 应用事件总线 → 契约事件（docs/design/core-host-decoupling.md §5.3、§12「P1b 实施约定」）。
 *
 * P2 之后服务只调 `events.publish(<旧通道>, payload, { surface? })`。P1b 迁移期间两路并行：
 * - 旧通道照常按窗口广播（还没迁移的视图、e2e-headed 用例仍在监听）；
 * - 通道在桥接表里时，同时发布为契约事件，由契约传输推给**订阅了**该事件的窗口
 *   （与 P1a 的 `ai.*` 事件一致：不再按 surface 广播，没订阅的窗口收不到）。
 *
 * router 建好之前（启动早期）发布的事件只走旧通道；`attach` 之后才转契约事件。
 * 收尾批次删掉旧监听后，旧通道的广播一起删除。
 */

import type { AppEvents, PublishOptions } from '../../core/appEvents';

import type { ContractLoggerLike, EventBridgeMap } from './types';

/** router.events 的最小形状 */
export interface ContractEventSink {
  publish(event: string, data: unknown): void;
}

export interface ContractEventBridge extends AppEvents {
  /** 接上契约事件；返回断开函数（再次 attach 会替换上一个） */
  attach(sink: ContractEventSink): () => void;
  /** 某个旧通道会转成哪个契约事件（测试与诊断用） */
  contractEventOf(channel: string): string | undefined;
}

export function createContractEventBridge(
  inner: AppEvents,
  map: EventBridgeMap<string>,
  logger?: Pick<ContractLoggerLike, 'warn'>,
): ContractEventBridge {
  let sink: ContractEventSink | null = null;
  const entryOf = (channel: string) =>
    Object.prototype.hasOwnProperty.call(map, channel) ? map[channel] : undefined;

  return {
    publish(channel: string, payload?: unknown, opts?: PublishOptions): void {
      inner.publish(channel, payload, opts);
      const entry = entryOf(channel);
      if (!entry || !sink) return;
      const event = typeof entry === 'string' ? entry : entry.event;
      try {
        sink.publish(event, typeof entry === 'string' ? payload : entry.map(payload));
      } catch (error) {
        // schema 不符等：只记日志，不影响旧通道与发布方
        logger?.warn('契约事件发布失败', {
          channel,
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    attach(next) {
      sink = next;
      return () => {
        if (sink === next) sink = null;
      };
    },
    contractEventOf(channel) {
      const entry = entryOf(channel);
      return entry === undefined ? undefined : typeof entry === 'string' ? entry : entry.event;
    },
  };
}
