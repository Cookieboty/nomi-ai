import { useEffect, useState } from 'react';

import { providerClient, providerClientAvailable } from '../services/providerClient';

/**
 * Nomi 对话有没有可用的模型（第三方供应商生效 / 本机模型）。
 * 没有桌面桥（浏览器 / 单测）时返回 undefined；查到之前为 null。
 */
export function useModelReady(): boolean | null | undefined {
  const [ready, setReady] = useState<boolean | null | undefined>(() =>
    providerClientAvailable() ? null : undefined,
  );
  useEffect(() => {
    if (!providerClientAvailable()) return;
    providerClient
      .state()
      .then((s) => setReady(!!s.effectiveProviderId))
      .catch(() => setReady(false));
    return providerClient.onChanged((s) => setReady(!!s.effectiveProviderId));
  }, []);
  return ready;
}
