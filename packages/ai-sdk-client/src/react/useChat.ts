/**
 * useChat —— 消息发送 / 流式接收 / abort / regenerate 的最小可用 hook。
 *
 * - `messages`：本地维护的消息列表；追加规则由业务侧掌握（这里只提供最基本的 add 语义）；
 * - `streaming`：是否正在接收 stream；
 * - `send(text, opts?)`：以 text 为唯一 user turn 触发 `chat.stream`；返回时消息完成；
 * - `abort()`：调 `chat.abort(reqId)`；
 * - `regenerate()`：重跑最近一次用户消息。
 *
 * 目的：让 P8 消费方（renderer / ai-chat）能快速迁移，同时保持极小 API 面积。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SDKError, SDKErrorCodes } from '../errors';

import { useAIClient } from './AIProvider';

export interface UseChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: number;
}

export interface UseChatSendOptions {
  provider?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}

export interface UseChatResult {
  messages: UseChatMessage[];
  streaming: boolean;
  error?: SDKError;
  send: (text: string, opts?: UseChatSendOptions) => Promise<void>;
  abort: () => void;
  regenerate: (opts?: UseChatSendOptions) => Promise<void>;
  reset: () => void;
}

export function useChat(): UseChatResult {
  const client = useAIClient();
  const [messages, setMessages] = useState<UseChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<SDKError | undefined>(undefined);
  const reqIdRef = useRef<string | undefined>(undefined);

  const chatFacade = client.chat as {
    stream: (opts: unknown) => AsyncIterable<unknown>;
    abort: (reqId: string) => void;
  };

  // 组件卸载时放弃仍在进行的流，避免主进程继续生成无人接收的内容
  useEffect(
    () => () => {
      const id = reqIdRef.current;
      if (!id) return;
      try {
        chatFacade.abort(id);
      } catch {
        /* 卸载阶段不再上报 */
      }
    },
    [chatFacade],
  );

  const runStream = useCallback(
    async (userText: string, opts?: UseChatSendOptions) => {
      const now = Date.now();
      const userMsg: UseChatMessage = {
        id: `u_${now.toString(36)}`,
        role: 'user',
        content: userText,
        createdAt: now,
      };
      const assistantMsg: UseChatMessage = {
        id: `a_${now.toString(36)}`,
        role: 'assistant',
        content: '',
        createdAt: now + 1,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setError(undefined);
      setStreaming(true);

      const reqId = `req_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      reqIdRef.current = reqId;

      try {
        const iter = chatFacade.stream({
          reqId,
          provider: opts?.provider,
          model: opts?.model,
          temperature: opts?.temperature,
          topP: opts?.topP,
          maxTokens: opts?.maxTokens,
          extra: opts?.extra,
          messages: [{ role: 'user', content: userText }],
        });
        for await (const chunk of iter) {
          const c = chunk as { deltaText?: string; text?: string } | undefined;
          const text = c?.deltaText ?? c?.text ?? '';
          if (!text) continue;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.id !== assistantMsg.id) return prev;
            const merged: UseChatMessage = { ...last, content: last.content + text };
            return [...prev.slice(0, -1), merged];
          });
        }
      } catch (err) {
        setError(err instanceof SDKError ? err : SDKError.fromIpc(err));
      } finally {
        setStreaming(false);
        reqIdRef.current = undefined;
      }
    },
    [chatFacade],
  );

  const send = useCallback(
    async (text: string, opts?: UseChatSendOptions) => {
      if (!text) return;
      await runStream(text, opts);
    },
    [runStream],
  );

  const abort = useCallback(() => {
    const id = reqIdRef.current;
    if (!id) return;
    try {
      chatFacade.abort(id);
    } catch (err) {
      setError(err instanceof SDKError ? err : SDKError.fromIpc(err));
    }
  }, [chatFacade]);

  const regenerate = useCallback(
    async (opts?: UseChatSendOptions) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) {
        throw new SDKError(SDKErrorCodes.IPC_ERROR, '尚无可重新生成的用户消息');
      }
      await runStream(lastUser.content, opts);
    },
    [messages, runStream],
  );

  const reset = useCallback(() => {
    setMessages([]);
    setError(undefined);
    setStreaming(false);
  }, []);

  return useMemo(
    () => ({ messages, streaming, error, send, abort, regenerate, reset }),
    [messages, streaming, error, send, abort, regenerate, reset],
  );
}
