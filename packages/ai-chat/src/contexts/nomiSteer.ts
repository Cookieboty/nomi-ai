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
  /** 插入一条用户消息（成功后记进这一轮的轨迹） */
  steer?: (text: string) => Promise<boolean>;
  /** 有没结束的工具调用 */
  toolRunning?: () => boolean;
}

/** 把插入能力挂到这一轮上：交给内核成功后在轨迹里记一条 interject（textAt = 当时的正文长度） */
export function attachSteer(
  stream: SteerableStream,
  o: {
    trace: HarnessTraceEvent[];
    textLength: () => number;
    deliver: (reqId: string, text: string) => Promise<boolean> | undefined;
    onChange: () => void;
  },
): void {
  stream.toolRunning = () => hasRunningTool(o.trace);
  stream.steer = async (text) => {
    const ok = (await o.deliver(stream.reqId, text)) === true;
    if (!ok || stream.controller.signal.aborted) return false;
    o.trace.push({ type: 'interject', text, at: Date.now(), textAt: o.textLength() });
    o.onChange();
    return true;
  };
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
