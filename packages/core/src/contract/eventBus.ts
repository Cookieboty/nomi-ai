/**
 * 应用事件总线 → 契约事件（docs/design/core-host-decoupling.md §5.3、§12 P1b）。
 *
 * 服务直接发布契约事件：`events.publish('theme.changed', state, { surface? })`。总线把它交给 router 的
 * `events`（schema 校验），由契约传输推给**订阅了**该事件的窗口。`surface` 只是发布方的意图，总线不看它：
 * 按窗口投递由契约的 `eventSurfaces` 决定（传输层在订阅时按调用者的界面过滤，§8），如确认请求只给看板娘、
 * 编程助手会话只给对话窗口。
 *
 * - router 建好之前（启动早期）没有订阅者，发布的事件直接丢弃；
 * - payload 不符合契约 schema 的事件只记 warn，不影响发布方（事件名由 `AppEventName` 在编译期限定）；
 * - `tap`（可选）：每次发布都原样转给它（测试与无界面宿主用来记录）。
 */

import type { AppEventName, AppEvents, PublishOptions } from '../core/appEvents';

import type { ContractLoggerLike } from './types';

/** router.events 的最小形状 */
export interface ContractEventSink {
  publish(event: string, data: unknown): void;
}

export interface ContractEventBus extends AppEvents {
  /** 接上契约事件；返回断开函数（再次 attach 会替换上一个） */
  attach(sink: ContractEventSink): () => void;
}

export function createContractEventBus(
  tap: AppEvents | null,
  logger?: Pick<ContractLoggerLike, 'warn'>,
): ContractEventBus {
  let sink: ContractEventSink | null = null;

  const publish = (event: AppEventName, payload: unknown, opts?: PublishOptions): void => {
    tap?.publish(event, payload, opts);
    if (!sink) return;
    try {
      sink.publish(event, payload);
    } catch (error) {
      // schema 不符等：只记日志，不影响发布方
      logger?.warn('契约事件发布失败', {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    publish,
    attach(next) {
      sink = next;
      return () => {
        if (sink === next) sink = null;
      };
    },
  };
}
