import { useEffect, useState } from 'react';

import { usageClient } from '../../services/usageClient';

import type { Fx } from './shared';

const DEFAULT_FX: Fx = { currency: 'USD', rate: 7.2 };

/** 读取当前币种 / 汇率（设置变化时跟随）；拿不到就按 USD。 */
export function useUsageFx(): Fx {
  const [fx, setFx] = useState<Fx>(DEFAULT_FX);
  useEffect(() => {
    if (!usageClient.available()) return;
    let alive = true;
    const load = () =>
      void usageClient
        .state()
        .then((s) => {
          if (!alive) return;
          const next = { currency: s.settings.currency, rate: s.settings.cnyPerUsd };
          setFx((p) => (p.currency === next.currency && p.rate === next.rate ? p : next));
        })
        .catch(() => undefined);
    load();
    const off = usageClient.onChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return fx;
}
