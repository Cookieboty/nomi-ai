/**
 * 输入框上方待发列表的接线（App 用）：Nomi 主对话的待发列表（插入走 ai.chat.steer）、
 * 当前会话（Nomi / 编程助手标签）该显示哪份列表，以及撤回修改 / 删除 / Esc 合成发送。
 * 规则见 utils/pendingSends。
 */
import { useCallback, useMemo } from 'react';

import { useChangesUi } from '../components/SessionWorkspace/ChangesUiContext';
import { useHarnessTabsCore } from '../contexts/HarnessTabsContext';
import type { PendingMode, PendingSend } from '../utils/pendingSends';

import { useSendQueue, type QueueOpts, type SteerChannel } from './useSendQueue';

interface NomiActions {
  sendStreamMessage: (text: string) => Promise<void>;
  askKnowledge: (text: string) => Promise<void>;
  steerStream: (text: string) => Promise<boolean>;
  nomiToolRunning: () => boolean;
  onNomiToolStart: (fn: () => void) => () => void;
  stopGeneration: () => void;
}

export function useComposerPending(actions: NomiActions, busyHere: boolean, resetKey?: string) {
  const tabs = useHarnessTabsCore();
  const { fillComposer } = useChangesUi();
  const steer = useMemo<SteerChannel>(
    () => ({
      deliver: actions.steerStream,
      toolRunning: actions.nomiToolRunning,
      onToolStart: actions.onNomiToolStart,
      stop: actions.stopGeneration,
    }),
    [actions.steerStream, actions.nomiToolRunning, actions.onNomiToolStart, actions.stopGeneration],
  );
  // 只有当前会话在回复时才进列表：别的会话在回复不影响这里直接发送
  const nomiQueue = useSendQueue(
    busyHere,
    // 入队时冻结的意图：知识库问答排的队，出队后仍走带引用的问答
    (text: string, opts?: QueueOpts) =>
      opts?.kb ? actions.askKnowledge(text) : actions.sendStreamMessage(text),
    resetKey,
    steer,
  );
  const cli = tabs.isCliTab && tabs.activeTab ? tabs.activeTab.id : null;
  const items: readonly PendingSend[] | undefined = cli ? tabs.queues[cli] : nomiQueue.items;
  const { removePending } = tabs;
  const { remove: removeNomi } = nomiQueue;
  const onRemove = useCallback(
    (id: string) => (cli ? removePending(id) : removeNomi(id)),
    [cli, removePending, removeNomi],
  );
  const onWithdraw = useCallback(
    (item: PendingSend) => {
      onRemove(item.id);
      fillComposer(item.text);
    },
    [onRemove, fillComposer],
  );
  // 输入框的运行中发送：Enter 插入 / Ctrl+Enter 排队 / Esc 停下来马上发（编程助手标签与 Nomi 各走各的列表）
  const { send: tabSend, cancel: tabCancel, flushPending } = tabs;
  const { enqueue, flush } = nomiQueue;
  const count = items?.length ?? 0;
  const queueProps = useMemo(
    () =>
      cli
        ? {
            onQueue: (text: string, o?: { mode?: PendingMode }): void =>
              void tabSend(text, undefined, o?.mode),
            onStop: (): void => void tabCancel(),
            pending: count,
            onFlush: (): void => void flushPending(),
          }
        : { onQueue: enqueue, pending: count, onFlush: flush },
    [cli, tabSend, tabCancel, flushPending, enqueue, flush, count],
  );
  return { nomiQueue, items, onRemove, onWithdraw, queueProps };
}
