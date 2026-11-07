import { createLogger } from '@nomi-ai/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { fleetApi, fleetAvailable, type FleetState } from '../../services/fleetClient';

const log = createLogger('fleet');

/** 看板或浮层开着：几秒刷新一次占用 */
export const HOT_POLL_MS = 3000;
/** 只有标题栏指示与侧栏入口：慢一点，省得一直读进程表 */
export const IDLE_POLL_MS = 15000;

/**
 * 看板数据：拉一次，跟着 fleet.changed 更新；窗口可见时按 hot 决定的间隔轮询资源占用，窗口隐藏时不轮询。
 */
export function useFleet(hot: boolean): {
  state: FleetState | null;
  reload: () => void;
  apply: (s: FleetState) => void;
} {
  const [state, setState] = useState<FleetState | null>(null);
  const available = fleetAvailable();
  const inflight = useRef(false);
  const reload = useCallback(() => {
    if (!available || inflight.current) return;
    inflight.current = true;
    fleetApi
      .state()
      .then(setState)
      .catch((e: unknown) => log.warn('fleet.state failed', e))
      .finally(() => {
        inflight.current = false;
      });
  }, [available]);

  useEffect(() => {
    if (!available) return;
    reload();
    return fleetApi.onChange(setState);
  }, [available, reload]);

  useEffect(() => {
    if (!available) return;
    const ms = hot ? HOT_POLL_MS : IDLE_POLL_MS;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(reload, ms);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        reload();
        start();
      } else stop();
    };
    if (hot) reload();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [available, hot, reload]);

  return { state, reload, apply: setState };
}
