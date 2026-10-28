/**
 * 主进程 → 界面的事件总线（docs/design/core-host-decoupling.md §5.3、§7.1「实施约定」）。
 *
 * 服务只说「发生了什么」：`events.publish('ai:theme:changed', state)`，不知道有哪些窗口、
 * 怎么送达。送达由宿主负责：Electron 上是契约事件桥（host/contract/eventBridge.ts），按表转成
 * 契约事件（`theme.changed`），推给订阅了的窗口。本文件不得 import electron。
 *
 * 和 `core/EventBus.ts` 的区别：EventBus 是主进程内部的发布订阅；AppEvents 的订阅方在界面里，
 * 通道名沿用迁移前的 IPC 通道名，事件桥里登记了它对应的契约事件。
 */
import type { Surface } from '@nomi-ai/host-ports';

export interface PublishOptions {
  /**
   * 只发给这些界面；缺省发给所有窗口（与现在的 `BrowserWindow.getAllWindows()` 广播一致）。
   * `settings` 落在宿主决定的窗口（Electron：对话窗口）。
   */
  surface?: Surface | readonly Surface[];
}

export interface AppEvents {
  /** 通道名沿用现有 IPC 通道（如 `ai:theme:changed`）；payload 必须可结构化克隆 */
  publish(channel: string, payload?: unknown, opts?: PublishOptions): void;
}

/** 一次 publish 的记录（测试与无界面宿主用） */
export interface PublishedEvent {
  channel: string;
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
  /** 某个通道最近一次的 payload；没有时为 undefined */
  last(channel: string): unknown;
}

export function createRecordingAppEvents(): RecordingAppEvents {
  const published: PublishedEvent[] = [];
  return {
    published,
    publish(channel, payload, opts) {
      published.push({ channel, payload, surfaces: targetSurfaces(opts) });
    },
    last(channel) {
      for (let i = published.length - 1; i >= 0; i--) {
        if (published[i]!.channel === channel) return published[i]!.payload;
      }
      return undefined;
    },
  };
}
