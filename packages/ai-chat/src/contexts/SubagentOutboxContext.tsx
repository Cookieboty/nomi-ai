/** 子任务待发箱属于工作台，不属于侧栏：关闭 / 切换面板后仍保留并继续交付。 */
import { t } from '@nomi-ai/ui';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { harnessClient, type HarnessImageInput } from '../services/harnessClient';
import { tasksApi } from '../services/tasksClient';
import { mergePending, newPendingId, type PendingSend } from '../utils/pendingSends';

import { useHarnessDetached, useHarnessLive, useHarnessTabs } from './HarnessTabsContext';

export type OutboxTarget =
  | { kind: 'nomi-task'; taskId: string }
  | { kind: 'nested'; parentTabId: string; callId: string; agentId?: string; name: string };

export interface OutboxMessage extends PendingSend {
  images?: HarnessImageInput[];
}
interface Entry {
  target: OutboxTarget;
  items: OutboxMessage[];
  error: string | null;
}
interface Outbox {
  entries: Record<string, Entry>;
  enqueue(target: OutboxTarget, text: string, images?: HarnessImageInput[]): void;
  remove(key: string, id: string): void;
  acknowledge(key: string, ids: Set<string>): void;
  fail(key: string, error: string | null): void;
}
const Ctx = createContext<Outbox | null>(null);
const EMPTY: OutboxMessage[] = [];
const ACTIVE_TASK = new Set(['running', 'queued', 'waiting_user']);
const keyOf = (target: OutboxTarget) =>
  JSON.stringify(
    target.kind === 'nomi-task'
      ? [target.kind, target.taskId]
      : [target.kind, target.parentTabId, target.callId],
  );

/** 一个待发箱一个交付者；它随 Provider 存活，面板卸载不会取消交付。 */
function Delivery({ entry, boxKey, outbox }: { entry: Entry; boxKey: string; outbox: Outbox }) {
  const tabs = useHarnessTabs();
  const target = entry.target;
  const parentId = target.kind === 'nested' ? target.parentTabId : null;
  const live = useHarnessLive((map) => (parentId ? map[parentId] : undefined));
  const detached = useHarnessDetached((map) => (parentId ? map[parentId] : undefined));
  const sending = useRef(false);
  const delivered = useRef(new Set<string>());
  const waitParent = useRef(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revision, refresh] = useState(0);
  const { acknowledge, fail } = outbox;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  useEffect(
    () =>
      target.kind === 'nomi-task' ? tasksApi.onChange(() => refresh((n) => n + 1)) : undefined,
    [target],
  );

  useEffect(() => {
    if (!entry.items.length || entry.error || sending.current) return;
    // 不截掉第九张图：剩余的消息留在下一批里。
    const batch: OutboxMessage[] = [];
    let imageCount = 0;
    for (const item of entry.items) {
      if (delivered.current.has(item.id)) continue;
      if (imageCount + (item.images?.length ?? 0) > 8 && batch.length) break;
      batch.push(item);
      imageCount += item.images?.length ?? 0;
    }
    if (!batch.length) return;
    const text = mergePending(batch);
    const images = batch.flatMap((item) => item.images ?? []);
    const deliver = async (): Promise<boolean> => {
      if (target.kind === 'nomi-task') {
        const rec = await tasksApi.get(target.taskId);
        if (!rec) throw new Error('not_found');
        if (ACTIVE_TASK.has(rec.task.status)) return false;
        const result = await tasksApi.followUp(target.taskId, text, images);
        if (result.ok) return true;
        if (result.reason === 'busy') return false;
        throw new Error(result.reason || 'error');
      }
      if (!tabs.state) return false;
      const parent = tabs.state.tabs.find((tab) => tab.id === target.parentTabId);
      if (!parent) throw new Error('not_found');
      const fork = tabs.state?.tabs.find(
        (tab) =>
          tab.subagentOf?.tabId === parent.id &&
          (tab.subagentOf.callId === target.callId ||
            (!!target.agentId && tab.subagentOf.agentId === target.agentId)),
      );
      if (fork) {
        const ok = await tabs.sendToTab(fork.id, text, undefined, images, 'queue');
        if (!ok) throw new Error('not_found');
        return true;
      }
      const match = (agent: { id: string; callId?: string }) =>
        agent.callId === target.callId || agent.id === target.agentId || agent.id === target.callId;
      const agent =
        Object.values(detached?.agents ?? {}).find(match) ??
        Object.values(live?.agents ?? {}).find(match);
      if (
        agent?.status === 'running' ||
        (waitParent.current && (parent.status === 'running' || parent.status === 'queued'))
      )
        return false;
      waitParent.current = false;
      const result = await harnessClient.messageAgent({
        id: parent.id,
        callId: target.callId,
        agentId: target.agentId ?? agent?.id,
        text,
        ...(images.length ? { images } : {}),
        mode: 'queue',
      });
      if (result.ok) return true;
      if (result.reason === 'running') waitParent.current = true;
      if (result.reason === 'busy' || result.reason === 'running') return false;
      if (result.reason === 'unsupported') {
        const body = t(
          'ui.session-workspace.subagent-envelope',
          target.name,
          target.agentId ?? target.callId,
          text,
        );
        if (await tabs.sendToTab(parent.id, body, undefined, images, 'queue')) return true;
      }
      throw new Error(result.message || result.reason || 'error');
    };
    sending.current = true;
    void deliver()
      .then((sent) => {
        if (!alive.current) return;
        if (sent) {
          const ids = new Set(batch.map((item) => item.id));
          for (const id of ids) delivered.current.add(id);
          acknowledge(boxKey, ids);
        } else {
          // 状态事件通常会立即唤醒；兜底处理 busy 返回早于状态送达的窗口。
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            if (alive.current) refresh((n) => n + 1);
          }, 1000);
        }
      })
      .catch((error: unknown) => {
        if (alive.current) fail(boxKey, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        sending.current = false;
      });
  }, [entry, target, tabs, live, detached, revision, acknowledge, fail, boxKey]);
  return null;
}

export const SubagentOutboxProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const enqueue = useCallback(
    (target: OutboxTarget, text: string, images?: HarnessImageInput[]) => {
      const key = keyOf(target);
      setEntries((cur) => ({
        ...cur,
        [key]: {
          target,
          items: [...(cur[key]?.items ?? []), { id: newPendingId(), text, mode: 'queue', images }],
          error: cur[key]?.error ?? null,
        },
      }));
    },
    [],
  );
  const acknowledge = useCallback((key: string, ids: Set<string>) => {
    setEntries((cur) => {
      const entry = cur[key];
      if (!entry) return cur;
      const items = entry.items.filter((item) => !ids.has(item.id));
      if (items.length) return { ...cur, [key]: { ...entry, items } };
      const next = { ...cur };
      delete next[key];
      return next;
    });
  }, []);
  const remove = useCallback(
    (key: string, id: string) => acknowledge(key, new Set([id])),
    [acknowledge],
  );
  const fail = useCallback((key: string, error: string | null) => {
    setEntries((cur) => (cur[key] ? { ...cur, [key]: { ...cur[key], error } } : cur));
  }, []);
  const value = { entries, enqueue, remove, acknowledge, fail };
  return (
    <Ctx.Provider value={value}>
      {children}
      {Object.entries(entries).map(([key, entry]) => (
        <Delivery key={key} entry={entry} boxKey={key} outbox={value} />
      ))}
    </Ctx.Provider>
  );
};

export function useSubagentOutbox(target: OutboxTarget | null) {
  const outbox = useContext(Ctx);
  if (!outbox) throw new Error('SubagentOutboxProvider is required');
  const key = target ? keyOf(target) : '';
  const entry = outbox.entries[key];
  return {
    items: entry?.items ?? EMPTY,
    error: entry?.error ?? null,
    enqueue: (text: string, images?: HarnessImageInput[]) => {
      if (target) outbox.enqueue(target, text, images);
    },
    remove: (id: string) => outbox.remove(key, id),
    retry: () => outbox.fail(key, null),
  };
}
