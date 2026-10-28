/**
 * useAIEvents —— 订阅任意 AIClientEvent 事件；unmount 时自动反订阅。
 *
 * - `evt` 更改会重新订阅；`fn` 使用 ref 保存以避免每次渲染都重挂；
 * - 允许订阅任意字符串事件（P5 事件名 + P4 avatar 事件）。
 */

import { useEffect, useRef } from 'react';

import { useAIClient } from './AIProvider';

export function useAIEvents(evt: string, fn: (payload: unknown) => void): void {
  const client = useAIClient();
  const ref = useRef(fn);
  // 渲染期间不写 ref（React Compiler / react-hooks 7 规则）；提交后同步最新回调
  useEffect(() => {
    ref.current = fn;
  }, [fn]);

  useEffect(() => {
    const off = client.on(evt, (p) => ref.current(p));
    return () => off();
  }, [client, evt]);
}
