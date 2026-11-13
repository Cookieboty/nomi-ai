/**
 * 当前会话的问题卡：Nomi 对话按 conversationId，编程助手标签按 tabId。
 * 挂载时补拉一次，之后跟 ai.userQuestion 走。
 *
 * - 补拉的快照可能比已收到的事件旧：快照回来之前的事件先攒着，快照装好后按顺序重放；
 *   收到过 closed 的卡记下来，旧快照不能把它复活（#360）。
 * - 答复成功后才移除；失败时卡和已选内容都留着、显示错误，再补查一次 pending：
 *   后端已经不等了（其实答上了、只是回包丢了）就移除，不重复提交（#361）。
 */
import { t } from '@nomi-ai/ui';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { api, hasTransport } from '../../services/api';

import { UserQuestionCard, type UserQuestionRequest, type UserQuestionSubmission } from './index';

interface QuestionEvent {
  id: string;
  closed?: boolean;
  source?: UserQuestionRequest['source'];
  conversationId?: string;
  tabId?: string;
  questions?: UserQuestionRequest['questions'];
  expiresAt?: number;
}

const isRequest = (ev: QuestionEvent): ev is QuestionEvent & UserQuestionRequest =>
  !ev.closed && !!ev.source && !!ev.questions?.length && typeof ev.expiresAt === 'number';

const toRequest = (ev: QuestionEvent & UserQuestionRequest): UserQuestionRequest => ({
  id: ev.id,
  source: ev.source,
  conversationId: ev.conversationId,
  tabId: ev.tabId,
  questions: ev.questions,
  expiresAt: ev.expiresAt,
});

/** 把一条事件并进列表（closed 移除，其余新增或替换） */
export const applyQuestionEvent = (
  list: UserQuestionRequest[],
  ev: QuestionEvent,
): UserQuestionRequest[] => {
  if (ev.closed)
    return list.some((item) => item.id === ev.id) ? list.filter((item) => item.id !== ev.id) : list;
  if (!isRequest(ev)) return list;
  const next = toRequest(ev);
  const i = list.findIndex((item) => item.id === next.id);
  if (i < 0) return [...list, next];
  const copy = list.slice();
  copy[i] = next;
  return copy;
};

/** 失败后多久再补查一次 pending（断线重连期间会一直失败，到连上为止） */
const RECHECK_MS = 3000;

export const UserQuestionDock: React.FC<{
  conversationId?: string;
  tabId?: string;
}> = ({ conversationId, tabId }) => {
  const [items, setItems] = useState<UserQuestionRequest[]>([]);
  const [now, setNow] = useState(() => Date.now());
  /** 正在提交的卡（防重复点击） */
  const [busy, setBusy] = useState<string | null>(null);
  /** 提交失败的卡 → 错误提示 */
  const [failed, setFailed] = useState<Record<string, string>>({});
  const closedRef = useRef(new Set<string>());
  const inflightRef = useRef(new Set<string>());
  const aliveRef = useRef(true);
  const recheckRef = useRef<number | null>(null);
  /** 最新的 recheck（失败后的定时重查经它调用，不在回调里引用自己） */
  const recheckFnRef = useRef<() => void>(() => undefined);

  /** 用一份 pending 快照对齐列表：只认快照里有、且没收到过 closed 的 */
  const installSnapshot = useCallback((list: UserQuestionRequest[], buffered: QuestionEvent[]) => {
    let next = list.filter((item) => !closedRef.current.has(item.id));
    for (const ev of buffered) next = applyQuestionEvent(next, ev);
    setItems(next);
  }, []);

  const recheck = useCallback(() => {
    if (recheckRef.current !== null) {
      window.clearTimeout(recheckRef.current);
      recheckRef.current = null;
    }
    const buffered: QuestionEvent[] = [];
    const off = api.on('ai.userQuestion', (payload) => buffered.push(payload as QuestionEvent));
    void api.ai.userQuestion
      .pending()
      .then((list) => {
        off();
        if (!aliveRef.current) return;
        const pending = list as UserQuestionRequest[];
        const ids = new Set(pending.map((item) => item.id));
        // 后端已经不等的卡（答上了 / 过期 / 被关）就收掉，失败提示一起清掉
        setFailed((prev) => {
          const keep: Record<string, string> = {};
          for (const [id, msg] of Object.entries(prev)) if (ids.has(id)) keep[id] = msg;
          return keep;
        });
        installSnapshot(pending, buffered);
      })
      .catch(() => {
        off();
        // 还没连上：过一会儿再查，卡先留着
        if (aliveRef.current)
          recheckRef.current = window.setTimeout(() => recheckFnRef.current(), RECHECK_MS);
      });
  }, [installSnapshot]);
  useEffect(() => {
    recheckFnRef.current = recheck;
  }, [recheck]);

  useEffect(() => {
    if (!hasTransport()) return;
    aliveRef.current = true;
    let snapshotDone = false;
    const buffered: QuestionEvent[] = [];
    const off = api.on('ai.userQuestion', (payload) => {
      const ev = payload as QuestionEvent;
      if (ev.closed) closedRef.current.add(ev.id);
      else closedRef.current.delete(ev.id);
      if (!snapshotDone) buffered.push(ev);
      setItems((list) => applyQuestionEvent(list, ev));
    });
    void api.ai.userQuestion
      .pending()
      .then((list) => {
        snapshotDone = true;
        if (aliveRef.current) installSnapshot(list as UserQuestionRequest[], buffered);
      })
      .catch(() => {
        snapshotDone = true;
      });
    return () => {
      aliveRef.current = false;
      if (recheckRef.current !== null) window.clearTimeout(recheckRef.current);
      off();
    };
  }, [installSnapshot]);

  useEffect(() => {
    if (!items.length) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [items.length]);

  const visible = items.filter((item) => {
    if (item.expiresAt <= now) return false;
    if (tabId) return item.tabId === tabId;
    return !item.tabId && !!conversationId && item.conversationId === conversationId;
  });
  const request = visible[0];
  if (!request) return null;

  const submit = (submission: UserQuestionSubmission) => {
    const id = request.id;
    if (inflightRef.current.has(id)) return;
    inflightRef.current.add(id);
    setBusy(id);
    setFailed((prev) => {
      if (!(id in prev)) return prev;
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
    void api.ai.userQuestion
      .answer({
        id,
        action: submission.action,
        ...(submission.answers ? { answers: submission.answers } : {}),
        ...(submission.details ? { details: submission.details } : {}),
      })
      .then(() => {
        if (!aliveRef.current) return;
        closedRef.current.add(id);
        setItems((list) => list.filter((item) => item.id !== id));
      })
      .catch((err: unknown) => {
        if (!aliveRef.current) return;
        const detail = err instanceof Error && err.message ? err.message : String(err ?? '');
        setFailed((prev) => ({ ...prev, [id]: detail }));
        recheck();
      })
      .finally(() => {
        inflightRef.current.delete(id);
        if (aliveRef.current) setBusy((cur) => (cur === id ? null : cur));
      });
  };

  return (
    <UserQuestionCard
      key={request.id}
      request={request}
      onSubmit={submit}
      busy={busy === request.id}
      error={request.id in failed ? t('ui.chat-settings.question-submit-failed') : undefined}
    />
  );
};
