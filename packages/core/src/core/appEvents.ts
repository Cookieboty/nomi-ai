/**
 * 内核 → 界面的事件总线（docs/design/core-host-decoupling.md §5.3、§7.1「实施约定」）。
 *
 * 服务只说「发生了什么」：`events.publish('theme.changed', state)`，事件名就是应用契约里声明的事件
 * （`<命名空间>.<事件>`），payload 按契约的事件 schema 校验。服务不知道有哪些窗口、怎么送达：契约传输把事件
 * 推给**订阅了**它的窗口（内核的 `contract/eventBus.ts` 接到 router 上）。本文件不得 import electron。
 *
 * 和 `core/EventBus.ts` 的区别：EventBus 是内核内部的发布订阅；AppEvents 的订阅方在界面里。
 */
import type { EventName } from '@nomi-ai/contract';
import type { AppContract } from '@nomi-ai/contract/app';
import type { Surface } from '@nomi-ai/host-ports';

/** 应用契约里声明的事件名 */
export type AppEventName = EventName<AppContract>;

export interface PublishOptions {
  /**
   * 发布方预期的接收界面（记录与测试用）。**不决定投递**：契约事件推给订阅了它的窗口，哪些界面
   * 能订阅由契约的 `eventSurfaces` 决定（§8，传输层强制）；要限定窗口就在那里登记事件。
   */
  surface?: Surface | readonly Surface[];
}

export interface AppEvents {
  /**
   * `event` 是契约事件名（编译期限定）；payload 必须符合契约的事件 schema，发布时在运行时校验（服务的
   * interface 没有索引签名，对不上契约的 loose schema 的类型，所以这里不在类型上约束 payload）
   */
  publish(event: AppEventName, payload: unknown, opts?: PublishOptions): void;
}

/** 一次 publish 的记录（测试与无界面宿主用） */
export interface PublishedEvent {
  event: AppEventName;
  payload: unknown;
  surfaces: readonly Surface[] | null;
}

/** 把 `surface` 选项统一成数组；null 表示「所有窗口」 */
export function targetSurfaces(opts?: PublishOptions): readonly Surface[] | null {
  const s = opts?.surface;
  if (s === undefined) return null;
  return typeof s === 'string' ? [s] : s;
}

/** 只记录、不送达的实现：单元测试与无界面宿主用 */
export interface RecordingAppEvents extends AppEvents {
  readonly published: PublishedEvent[];
  /** 某个事件最近一次的 payload；没有时为 undefined */
  last(event: AppEventName): unknown;
}

export function createRecordingAppEvents(): RecordingAppEvents {
  const published: PublishedEvent[] = [];
  return {
    published,
    publish(event, payload, opts) {
      published.push({ event, payload, surfaces: targetSurfaces(opts) });
    },
    last(event) {
      for (let i = published.length - 1; i >= 0; i--) {
        if (published[i]!.event === event) return published[i]!.payload;
      }
      return undefined;
    },
  };
}
