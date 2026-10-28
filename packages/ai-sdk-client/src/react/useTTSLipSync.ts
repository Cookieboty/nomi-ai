/**
 * useTTSLipSync —— 订阅 `tts:chunk`，输出最近一次 rms 值供看板娘驱动嘴型。
 *
 * 用 `useSyncExternalStore` + 高频事件的**节流合并**（保留最新值即可，无需队列），
 * 避免每 frame 都触发 React re-render 之后仍卡顿。
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useAIClient } from './AIProvider';

export interface UseTTSLipSyncOptions {
  /** 若指定，则只订阅该 reqId 的 chunk（多路 TTS 场景） */
  reqId?: string;
  /** 事件到 render 的最小间隔（默认 33ms ≈ 30fps） */
  minIntervalMs?: number;
}

export function useTTSLipSync(opts: UseTTSLipSyncOptions = {}): number {
  const { reqId, minIntervalMs = 33 } = opts;
  const client = useAIClient();

  const rmsRef = useRef(0);
  const versionRef = useRef(0);
  const listenersRef = useRef(new Set<() => void>());
  const lastEmitRef = useRef(0);

  const notify = useCallback(() => {
    const now = Date.now();
    if (now - lastEmitRef.current < minIntervalMs) return;
    lastEmitRef.current = now;
    versionRef.current += 1;
    for (const l of listenersRef.current) l();
  }, [minIntervalMs]);

  useEffect(() => {
    const offChunk = client.on('tts:chunk', (payload) => {
      const p = payload as { reqId?: string; rms?: number };
      if (reqId && p?.reqId !== reqId) return;
      if (typeof p?.rms === 'number') {
        rmsRef.current = p.rms;
        notify();
      }
    });
    const offEnd = client.on('tts:end', (payload) => {
      const p = payload as { reqId?: string };
      if (reqId && p?.reqId !== reqId) return;
      rmsRef.current = 0;
      versionRef.current += 1;
      lastEmitRef.current = Date.now();
      for (const l of listenersRef.current) l();
    });
    return () => {
      offChunk();
      offEnd();
    };
  }, [client, reqId, notify]);

  const subscribe = useCallback((cb: () => void) => {
    listenersRef.current.add(cb);
    return () => listenersRef.current.delete(cb);
  }, []);
  // 快照直接返回最新 rms（number，按值比较），渲染期不读 ref
  const getSnapshot = useCallback(() => rmsRef.current, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
