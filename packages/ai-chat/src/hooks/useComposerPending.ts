/**
 * 输入框上方待发列表的接线（App 用）：Nomi 主对话的待发列表（插入走 ai.chat.steer）、
 * 当前会话（Nomi / agent 标签）该显示哪份列表，以及撤回修改 / 删除 / Esc 合成发送。
 * 规则见 utils/pendingSends。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { useChangesUi } from '../components/SessionWorkspace/ChangesUiContext';
import { useHarnessTabsCore } from '../contexts/HarnessTabsContext';
import {
  openPendingSends,
  pendingKey,
  type PendingSendStore,
  type PendingSource,
} from '../services/pendingSendsStore';
import type { PendingMode, PendingSend } from '../utils/pendingSends';

import { useSendQueue, type QueueOpts, type SteerChannel } from './useSendQueue';

interface NomiActions {
  sendStreamMessage: (text: string) => Promise<void>;
  askKnowledge: (text: string) => Promise<void>;
  steerStream: (text: string) => Promise<boolean>;
  nomiToolRunning: () => boolean;
  onNomiToolStart: (fn: () => void) => () => void;
  stopGeneration: () => void;
  /** 会话存储 + IPC（按会话回写待发列表） */
  pendingSource?: () => PendingSource;
}

/**
 * 当前会话待发列表的落盘（services/pendingSendsStore）：按组（nomi:<会话 id> / tab:<标签 id>）换一份。
 * 每次改都同步写 localStorage，Nomi 会话再写进它的元信息（同一份不写）；卸载时再写一次。
 * 切到别的组时旧的那份留着，别的会话 / 标签存下的不动。
 */
function useNomiPendingStore(source: (() => PendingSource) | undefined, key: string | undefined) {
  const make = (): PendingSendStore | undefined => {
    const id = key?.startsWith('nomi:') ? key.slice(5) : '';
    return key ? openPendingSends(source?.() ?? {}, key, id || undefined) : undefined;
  };
  const [store, setStore] = useState<PendingSendStore | undefined>(make);
  useEffect(() => {
    setStore(make());
    // source 只是取最新的 IPC（currentConversationId 不是响应式的）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // 卸载前（Suspense 拿下 / 换到别的组）：存下的那份再写一次（这次交付写的「这一轮收到了」别丢）
  useEffect(
    () => () => {
      void store?.persist('unload').catch(() => undefined);
    },
    [store],
  );
  return store;
}

export function useComposerPending(
  actions: NomiActions,
  busyHere: boolean,
  resetKey?: string,
  /** 待发列表存在哪个 Nomi 会话里 + 读 / 写它的来源（换会话时换） */
  pendingTarget?: { convoId: string | undefined; source: NomiActions['pendingSource'] },
) {
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
  const cli = tabs.isCliTab && tabs.activeTab ? tabs.activeTab.id : null;
  // 当前会话在哪个组（nomi:<会话 id> / tab:<标签 id>；标签一开始不在运行时还没有 CLI 组）
  const pendingKeyNow = cli
    ? pendingKey('tab', cli)
    : pendingTarget?.convoId
      ? pendingKey('nomi', pendingTarget.convoId)
      : undefined;
  const pendingStore = useNomiPendingStore(pendingTarget?.source, pendingKeyNow);
  // CLI 标签的待发列表：挂回（重启前没交出去的），列表还归 HarnessTabsContext 维护，
  // 这里记下当前标签组的键，它的每次改动写回那一组（见 HarnessTabsContext.restorePending）
  useLayoutEffect(() => {
    if (cli) tabs.restorePending(pendingKey('tab', cli));
  }, [cli, tabs]);
  // 只有当前会话在回复时才进列表：别的会话在回复不影响这里直接发送
  const nomiQueue = useSendQueue(
    busyHere,
    // 入队时冻结的意图：知识库问答排的队，出队后仍走带引用的问答
    (text: string, opts?: QueueOpts) =>
      opts?.kb ? actions.askKnowledge(text) : actions.sendStreamMessage(text),
    resetKey,
    steer,
    pendingStore,
  );
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
  // 输入框的运行中发送：Enter 插入 / Ctrl+Enter 排队 / Esc 停下来马上发（agent 标签与 Nomi 各走各的列表）
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
