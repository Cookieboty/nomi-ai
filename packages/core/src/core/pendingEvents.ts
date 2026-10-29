/**
 * 没送达的一次性事件（docs/design/core-host-decoupling.md §5.3、§12 P1b「剩下的」）：面板导航、拖入总结与
 * 看板娘识别结果的投递（`voice.inject`）。
 *
 * 宿主先打开对话窗口、再发布导航 / 总结事件；新开的窗口要等页面加载、React 挂载并订阅之后才收得到，以前靠
 * 固定延迟（400 / 600 ms）等它。现在发布时如果没有订阅者，内核把这次事件留下（每组只留最近一次），对话窗口
 * 挂载时经契约拉取（`nav.takePending` / `desktop.takePendingSummary` / `voice.takePendingInject`），拉取即取走。已经开着、订阅了的窗口
 * 照常收事件，同组里留着的旧事件随之作废。
 *
 * 留下的事件 `ttlMs` 后过期：窗口没能打开时，不让很久以后才打开的对话窗口跳到一个旧面板。
 */
import type { AppEventName } from './appEvents';
import { CHAT_NAV_EVENTS } from './chatNav';

/** 留着的一次事件 */
export interface PendingEvent {
  event: AppEventName;
  payload: unknown;
}

export interface PendingEventsOptions {
  /** 组名 → 这一组的事件（同一组只留最近一次） */
  groups: Readonly<Record<string, readonly AppEventName[]>>;
  /** 留多久，默认 60 秒 */
  ttlMs?: number;
  now?: () => number;
}

export interface PendingEvents {
  /** 事件总线每次发布时调用；`delivered` = 发布时有订阅者 */
  offer(event: AppEventName, payload: unknown, delivered: boolean): void;
  /** 取走某组留着的事件；没有或已过期时为 null */
  take(group: string): PendingEvent | null;
}

export const PENDING_EVENT_TTL_MS = 60_000;

export function createPendingEvents(opts: PendingEventsOptions): PendingEvents {
  const ttl = opts.ttlMs ?? PENDING_EVENT_TTL_MS;
  const now = opts.now ?? Date.now;
  const groupOf = new Map<string, string>();
  for (const [group, events] of Object.entries(opts.groups)) {
    for (const e of events) groupOf.set(e, group);
  }
  const slots = new Map<string, PendingEvent & { at: number }>();

  return {
    offer(event, payload, delivered) {
      const group = groupOf.get(event);
      if (group === undefined) return;
      if (delivered) slots.delete(group);
      else slots.set(group, { event, payload, at: now() });
    },
    take(group) {
      const slot = slots.get(group);
      if (!slot) return null;
      slots.delete(group);
      if (now() - slot.at > ttl) return null;
      return { event: slot.event, payload: slot.payload };
    },
  };
}

/** 内核留着的两组：对话窗口的面板导航与拖入总结 */
export const CORE_PENDING_GROUPS = {
  nav: CHAT_NAV_EVENTS,
  summary: ['desktop.summary'],
  voiceInject: ['voice.inject'],
} as const satisfies Record<string, readonly AppEventName[]>;
