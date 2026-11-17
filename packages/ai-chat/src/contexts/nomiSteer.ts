/**
 * Nomi 对话一轮进行中插入用户消息（见 utils/pendingSends）：AiChatContext 的流式循环把 steer / toolRunning
 * 挂到当前这一轮上，待发列表经 steerStream 交付、经 onNomiToolStart 等工具开始。
 */
import { useCallback, useRef, type MutableRefObject } from 'react';

import type { HarnessTraceEvent } from '../services/harnessClient';
import { hasRunningTool } from '../utils/pendingSends';

export interface SteerableStream {
  reqId: string;
  controller: AbortController;
  /**
   * 插入一条用户消息（成功后记进这一轮的轨迹）。
   * silent：只投给内核，不在轨迹里留 interject —— 系统自己的状态注入（后台委派终态）
   * 不能回显成「你插入了」，那不是用户说的话。
   */
  steer?: (text: string, opts?: { silent?: boolean }) => Promise<boolean>;
  /** 有没结束的工具调用 */
  toolRunning?: () => boolean;
}

/**
 * 已经交给这一轮的用户插入（#321：中途重启也不丢）。交付成功、内核已收下，但这一轮的回复还没结束：
 * - 进程在这一刻没了 → 这条消息只在内核里、对话记录里没有。重启后补在这一轮用户消息的后面：
 *   persist 时按 id 写一条用户消息（存过再存覆盖，不会多一条），重试也从这里接着；
 * - 正常结束 → 回复的轨迹里带 interject，它只留在那里（buildProviderMessages 把它排进上下文），
 *   补的那条按 id 删掉（不重复显示、不重复进上下文）；重启后再交付、这次没进轨迹的，
 *   结局时补进回复正文开头的「你加入了」分节再删（见 useChatSends.fullSteerText）。
 */
export interface DeliveredSteer {
  id: string;
  text: string;
  /** 这条带的分节标记（见 services/history：重启后从回复的开头认出已交出的待发消息，不再多一条） */
  marker?: string;
  /** 已经在回复的轨迹里（interject）：补进对话记录的那条不管怎么结束都可以删了 */
  traced?: boolean;
}

/** 已交给这一轮的插入消息（按对话键） */
export type SteerLedger = Map<string, DeliveredSteer[]>;

/** 插入消息补成的用户消息 id（稳定：同一轮里中途重启几次都只占一条） */
export const steerMessageId = (reqId: string, steerId: string): string =>
  `steer-${reqId}-${steerId}`;

/**
 * 把插入能力挂到这一轮上：交给内核成功后在轨迹里记一条 interject（textAt = 当时的正文长度），
 * 并记下这条插入（有 ledger 时；见 DeliveredSteer）。
 */
export function attachSteer(
  stream: SteerableStream,
  o: {
    trace: HarnessTraceEvent[];
    textLength: () => number;
    deliver: (reqId: string, text: string) => Promise<boolean> | undefined;
    onChange: () => void;
    ledger?: SteerLedger;
    /** 这一轮的对话键 / 请求 id（补成用户消息时的 id 用） */
    convoKey?: string;
    reqId?: string;
    /** 文本开头带的分节标记（见 services/history） */
    marker?: string;
    newId?: () => string;
  },
): void {
  stream.toolRunning = () => hasRunningTool(o.trace);
  stream.steer = async (text, opts) => {
    const ok = (await o.deliver(stream.reqId, text)) === true;
    if (!ok || stream.controller.signal.aborted) return false;
    if (opts?.silent) return true;
    o.trace.push({ type: 'interject', text, at: Date.now(), textAt: o.textLength() });
    if (o.ledger && o.convoKey !== undefined) {
      const list = o.ledger.get(o.convoKey) ?? [];
      const newId = o.newId ?? (() => `s${Date.now().toString(36)}`);
      list.push({ id: newId(), text, ...(o.marker ? { marker: o.marker } : {}) });
      o.ledger.set(o.convoKey, list);
    }
    o.onChange();
    return true;
  };
}

/** 这一轮结束了（正常 / 出错 / 停止）：取走记下的插入消息（只取这一轮的对话键，别的会话不动） */
export function finishSteer(ledger: SteerLedger, key: string): DeliveredSteer[] {
  const done = ledger.get(key) ?? [];
  ledger.delete(key);
  return done;
}

/** 当前会话这一轮的插入入口 + 工具开始的订阅（参数是会话键） */
export function useNomiSteer(
  activeStream: MutableRefObject<Map<string, SteerableStream>>,
  currentKey: () => string,
) {
  const toolStartFns = useRef(new Set<(key: string) => void>());
  const keyRef = useRef(currentKey);
  keyRef.current = currentKey;
  const current = useCallback(() => activeStream.current.get(keyRef.current()), [activeStream]);
  const steerStream = useCallback(
    async (text: string) => {
      const a = current();
      if (!a?.steer || a.controller.signal.aborted) return false;
      return a.steer(text);
    },
    [current],
  );
  const nomiToolRunning = useCallback(() => current()?.toolRunning?.() === true, [current]);
  const onNomiToolStart = useCallback((fn: () => void) => {
    const wrapped = (key: string) => {
      if (key === keyRef.current()) fn();
    };
    toolStartFns.current.add(wrapped);
    return () => {
      toolStartFns.current.delete(wrapped);
    };
  }, []);
  const notifyToolStart = useCallback((key: string) => {
    for (const fn of toolStartFns.current) fn(key);
  }, []);
  return { steerStream, nomiToolRunning, onNomiToolStart, notifyToolStart };
}
