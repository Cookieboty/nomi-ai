/**
 * AIProvider —— 承载 ClientAIClient 单例的 React Context。
 *
 * - `client` 可以外部注入（首选：由 app 装配层集中管理生命周期），
 *   也可以让 Provider 自动构造（会在 `useEffect` 卸载时 dispose）；
 * - `useAIClient` 读不到 client 时抛出可辨识错误，避免 UI 里出现 `undefined.chat` 迷惑栈。
 */

import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { PropsWithChildren } from 'react';

import { ClientAIClient, type ClientAIClientOptions } from '../ClientAIClient';
import { SDKError, SDKErrorCodes } from '../errors';

export interface AIProviderProps extends ClientAIClientOptions {
  /** 直接传入外部持有的 client；一旦提供，Provider 不再自建/dispose。 */
  client?: ClientAIClient;
}

const AIClientContext = createContext<ClientAIClient | null>(null);

export function AIProvider(props: PropsWithChildren<AIProviderProps>) {
  const { client: external, transport, bridge, bridgeName, avatarAvailable, children } = props;

  const owned = useMemo(() => {
    if (external) return null;
    return new ClientAIClient({ transport, bridge, bridgeName, avatarAvailable });
  }, [external, transport, bridge, bridgeName, avatarAvailable]);

  // 只有 Provider 自建的 client 才需要 dispose。
  // dispose 推迟一个 tick：React StrictMode（dev）会「挂载 → 卸载 → 再挂载」同一个 useMemo 实例，
  // 立即 dispose 会让之后所有请求报 AICLIENT_DISPOSED（pnpm dev 下对话 / 切换 provider 全部失效）。
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (pendingDispose.current) {
      clearTimeout(pendingDispose.current);
      pendingDispose.current = undefined;
    }
    return () => {
      if (!owned) return;
      pendingDispose.current = setTimeout(() => {
        pendingDispose.current = undefined;
        void owned.dispose();
      }, 0);
    };
  }, [owned]);

  const value = external ?? owned;
  return <AIClientContext.Provider value={value}>{children}</AIClientContext.Provider>;
}

export function useAIClient(): ClientAIClient {
  const c = useContext(AIClientContext);
  if (!c) {
    throw new SDKError(
      SDKErrorCodes.BRIDGE_MISSING,
      '<AIProvider> 未挂载；useAIClient 必须在其内部使用',
    );
  }
  return c;
}
