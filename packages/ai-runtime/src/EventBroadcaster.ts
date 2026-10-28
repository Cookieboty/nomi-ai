/**
 * EventBroadcaster —— 把 `AIClient.on(evt)` 桥接到所有渲染窗口的 `ai:event` 通道。
 *
 * 对齐 P6 计划 §P6-4：
 * - `start(client)` 一次性订阅全部 12 个业务事件，避免动态 hook 遗漏；
 * - 每次 fire 都广播给 `adapter.getAllWebContents()` 里存活的 web contents；
 * - 支持"按窗口订阅子集"：渲染层通过 `ai:event:subscribe` 通道传入过滤器
 *   （`{ include?: Evt[]; exclude?: Evt[] }`），本类维护 subscribers map。
 *
 * P9-2/P9-3 联动（Polish C）：
 * - 可选注入 [ObservabilityBridge](file:///./ObservabilityBridge.ts)，把广播事件同步
 *   翻译成 metrics / span 埋点；默认不启用，业务方按需通过 `observability` 开关打开。
 *
 * 事件形态：`ai:event` 的 payload 是 `{ evt: AIClientEvent, data: unknown }`。
 */

import type { AIClient } from '@nomi-ai/ai-sdk';
import type { AIClientEvent, AIClientEventMap } from '@nomi-ai/ai-sdk';

import type { IpcAdapter, IpcInvokeEvent } from './IpcAdapter';
import type { RuntimeLogger } from './logger';
import { ConsoleRuntimeLogger } from './logger';
import type { ObservabilityBridge, ObservabilityBridgeOptions } from './ObservabilityBridge';
import { createObservabilityBridge } from './ObservabilityBridge';

const ALL_EVENTS: AIClientEvent[] = [
  'message:delta',
  'message:complete',
  'agent:step',
  'agent:turn-end',
  'agent:stopped-by-user',
  'tool:confirm-required',
  'tool:executed',
  'tts:chunk',
  'tts:end',
  'userProfile:changed',
  'avatar:touch',
  'avatar:motion-end',
];

export const EVENT_BROADCAST_CHANNEL = 'ai:event';
export const EVENT_SUBSCRIBE_CHANNEL = 'ai:event:subscribe';
export const EVENT_UNSUBSCRIBE_CHANNEL = 'ai:event:unsubscribe';

export interface EventFilter {
  include?: AIClientEvent[];
  exclude?: AIClientEvent[];
}

export interface EventBroadcasterOptions {
  adapter: IpcAdapter;
  logger?: RuntimeLogger;
  /**
   * P9-2/P9-3 observability bridge.
   * - `true` → 使用默认 [createObservabilityBridge()](file:///./ObservabilityBridge.ts)
   *   （默认 tracer / defaultRegistry）；
   * - 传入对象 → 走 [ObservabilityBridgeOptions](file:///./ObservabilityBridge.ts)；
   * - 未传 / `false` → 完全跳过埋点（默认关闭，防止意外出网 / 隐私泄漏）。
   */
  observability?: boolean | ObservabilityBridge | ObservabilityBridgeOptions;
}

export class EventBroadcaster {
  private disposers: Array<() => void> = [];
  private started = false;
  private readonly logger: RuntimeLogger;
  private readonly filters = new Map<number, EventFilter>();
  private readonly bridge?: ObservabilityBridge;
  private readonly subscribeListener = (event: IpcInvokeEvent, ...args: unknown[]) =>
    this.onSubscribe(event, args[0] as EventFilter | undefined);
  private readonly unsubscribeListener = (event: IpcInvokeEvent) =>
    this.filters.delete(event.senderId);

  constructor(private readonly opts: EventBroadcasterOptions) {
    this.logger = opts.logger ?? ConsoleRuntimeLogger;
    this.bridge = resolveObservabilityBridge(opts.observability);
  }

  start(client: AIClient): void {
    if (this.started) return;
    this.started = true;

    for (const evt of ALL_EVENTS) {
      const off = client.on(evt, (data) => this.broadcast(evt, data));
      this.disposers.push(off);
    }

    this.opts.adapter.on(EVENT_SUBSCRIBE_CHANNEL, this.subscribeListener);
    this.opts.adapter.on(EVENT_UNSUBSCRIBE_CHANNEL, this.unsubscribeListener);
    this.logger.info(`event broadcaster ready · ${ALL_EVENTS.length} events`);
  }

  stop(): void {
    if (!this.started) return;
    for (const off of this.disposers.splice(0)) {
      try {
        off();
      } catch (err) {
        this.logger.warn('event disposer threw', err);
      }
    }
    this.opts.adapter.off(EVENT_SUBSCRIBE_CHANNEL, this.subscribeListener);
    this.opts.adapter.off(EVENT_UNSUBSCRIBE_CHANNEL, this.unsubscribeListener);
    this.filters.clear();
    this.bridge?.dispose();
    this.started = false;
  }

  private broadcast<E extends AIClientEvent>(evt: E, data: AIClientEventMap[E]): void {
    const payload = { evt, data };
    const wcs = this.opts.adapter.getAllWebContents();
    const live = new Set<number>();
    for (const wc of wcs) {
      if (wc.isDestroyed()) {
        this.filters.delete(wc.id);
        continue;
      }
      live.add(wc.id);
      const filter = this.filters.get(wc.id);
      if (filter && !passesFilter(evt, filter)) continue;
      try {
        wc.send(EVENT_BROADCAST_CHANNEL, payload);
      } catch (err) {
        this.logger.warn(`send to wc#${wc.id} threw`, err);
      }
    }
    // 已关闭的窗口通常不会再出现在 getAllWebContents 里，退订消息也发不出来
    for (const id of this.filters.keys()) {
      if (!live.has(id)) this.filters.delete(id);
    }
    // observability 桥接：broadcast 之后再喂 bridge，避免副作用阻塞 IPC。
    if (this.bridge) {
      this.bridge.notify(evt, data);
    }
  }

  private onSubscribe(event: IpcInvokeEvent, filter?: EventFilter): void {
    if (!filter) {
      this.filters.delete(event.senderId);
      return;
    }
    this.filters.set(event.senderId, {
      include: filter.include ? [...filter.include] : undefined,
      exclude: filter.exclude ? [...filter.exclude] : undefined,
    });
  }
}

function passesFilter(evt: AIClientEvent, f: EventFilter): boolean {
  if (f.exclude?.includes(evt)) return false;
  if (f.include && !f.include.includes(evt)) return false;
  return true;
}

function isObservabilityBridge(value: unknown): value is ObservabilityBridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { notify?: unknown }).notify === 'function' &&
    typeof (value as { dispose?: unknown }).dispose === 'function'
  );
}

function resolveObservabilityBridge(
  input: EventBroadcasterOptions['observability'],
): ObservabilityBridge | undefined {
  if (input === undefined || input === false) return undefined;
  if (input === true) return createObservabilityBridge();
  if (isObservabilityBridge(input)) return input;
  return createObservabilityBridge(input);
}
