/**
 * 应用事件总线 → 契约事件（docs/design/core-host-decoupling.md §5.3、§12 P1b）。
 *
 * 服务只调 `events.publish(<应用事件通道>, payload, { surface? })`（通道名沿用迁移前的 IPC 通道，
 * 如 `ai:theme:changed`）。桥按表把它转成契约事件（`theme.changed`），由契约传输推给**订阅了**该事件的
 * 窗口。`surface` 只是发布方的意图，桥不看它：按窗口投递由契约的 `eventSurfaces` 决定
 * （传输层在订阅时按调用者的界面过滤，§8），如确认请求只给看板娘、编程助手会话只给对话窗口。
 * 不再向窗口发旧通道：渲染进程只有 `window.nomiTransport`，收不到其它通道。
 *
 * - router 建好之前（启动早期）没有订阅者，发布的事件直接丢弃；
 * - 表里没有的通道没有任何窗口能收到：每个通道记一次 warn，提醒补桥接表。
 * - `tap`（可选）：每次发布都原样转给它（测试与无界面宿主用来记录）。
 */

import type { AppEvents, PublishOptions } from '../core/appEvents';

import type { ContractLoggerLike, EventBridgeMap } from './types';

/** router.events 的最小形状 */
export interface ContractEventSink {
  publish(event: string, data: unknown): void;
}

export interface ContractEventBridge extends AppEvents {
  /** 接上契约事件；返回断开函数（再次 attach 会替换上一个） */
  attach(sink: ContractEventSink): () => void;
  /** 某个应用事件通道会转成哪个契约事件（测试与诊断用） */
  contractEventOf(channel: string): string | undefined;
}

export function createContractEventBridge(
  tap: AppEvents | null,
  map: EventBridgeMap<string>,
  logger?: Pick<ContractLoggerLike, 'warn'>,
): ContractEventBridge {
  let sink: ContractEventSink | null = null;
  const unbridged = new Set<string>();
  const entryOf = (channel: string) =>
    Object.prototype.hasOwnProperty.call(map, channel) ? map[channel] : undefined;

  return {
    publish(channel: string, payload?: unknown, opts?: PublishOptions): void {
      tap?.publish(channel, payload, opts);
      const entry = entryOf(channel);
      if (!entry) {
        if (!unbridged.has(channel)) {
          unbridged.add(channel);
          logger?.warn('应用事件没有对应的契约事件，已丢弃', { channel });
        }
        return;
      }
      if (!sink) return;
      const event = typeof entry === 'string' ? entry : entry.event;
      try {
        sink.publish(event, typeof entry === 'string' ? payload : entry.map(payload));
      } catch (error) {
        // schema 不符等：只记日志，不影响发布方
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
